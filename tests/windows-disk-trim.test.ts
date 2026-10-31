import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {windowsRootTrimScript,parseWindowsRootTrimReceipt} from '../server/platform/windows/disk-trim.ts';

// Run the generated Python with simulated Linux OS calls: no real device or
// discard operation is touched. Record exactly when the fixed command runs.
const harness=String.raw`import sys,json,os,stat,subprocess,builtins,io,contextlib,types
case=json.loads(sys.stdin.read()); mode=case['mode']; calls=[]; trimmed=False
os.geteuid=lambda:0
os.path.realpath=lambda value:value
os.sync=lambda:None
def fake_stat(path):
 if path=='/usr/sbin/fstrim':return types.SimpleNamespace(st_mode=stat.S_IFREG|(0o777 if mode=='unsafe-tool' else 0o755),st_uid=0)
 if path=='/dev/sda':return types.SimpleNamespace(st_mode=stat.S_IFBLK,st_rdev=1)
 if path=='/dev/sda1':return types.SimpleNamespace(st_mode=stat.S_IFBLK,st_rdev=2 if not(trimmed and mode=='changed') else 3)
 if path=='/':return types.SimpleNamespace(st_dev=2)
 raise RuntimeError('unexpected stat')
os.stat=fake_stat
def fake_open(path,*args,**kwargs):
 if path!='/sys/class/block/sda/queue/discard_max_bytes':raise RuntimeError('unexpected file')
 return io.StringIO('0' if mode=='no-discard' else '1048576')
builtins.open=fake_open
def check_output(args,**kwargs):
 if args[0]=='/usr/bin/findmnt':return json.dumps({'filesystems':[{'source':'/dev/sda1' if mode!='wrong-device' else '/dev/sdb1','fstype':'xfs' if mode=='wrong-fs' else 'ext4','target':'/'}]})
 if args[0]=='/usr/sbin/blockdev':return str((31 if mode=='wrong-size' else 32)*2**30)
 raise RuntimeError('unexpected command')
subprocess.check_output=check_output
def run(args,**kwargs):
 global trimmed
 calls.append(args);trimmed=True
 if mode=='command-failed':raise RuntimeError('failed')
subprocess.run=run
out=io.StringIO();error=None
try:
 with contextlib.redirect_stdout(out):exec(compile(case['script'],'guest-trim','exec'),{})
except Exception as ex:error=str(ex)
print(json.dumps({'output':out.getvalue(),'error':error,'calls':calls}))`;
function simulated(mode:string){
 const p=spawnSync('python',['-c',harness],{input:JSON.stringify({mode,script:windowsRootTrimScript(32)}),encoding:'utf8'});
 assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout) as {output:string;error:string|null;calls:string[][]};
}
test('Guest trim checks the fixed root and sends one discard command without claiming reclaimed bytes',()=>{
 const r=simulated('ok');assert.equal(r.error,null);assert.deepEqual(r.calls,[['/usr/sbin/fstrim','/']]);
 assert.deepEqual(parseWindowsRootTrimReceipt(r.output,32),{device:'/dev/sda1',diskBytes:32*2**30,discardCompleted:true});
});
test('Changed layout, missing discard support and failed or uncertain commands cannot report completion',()=>{
 for(const mode of ['wrong-device','wrong-fs','wrong-size','no-discard','unsafe-tool','command-failed','changed']){
  const r=simulated(mode);assert.ok(r.error,mode);assert.equal(r.output,'',mode);
  assert.equal(r.calls.length,mode==='command-failed'||mode==='changed'?1:0,mode);
 }
});
test('Discard receipts reject extra fields, wrong capacity and invalid limits',()=>{
 const valid={device:'/dev/sda1',diskBytes:32*2**30,discardCompleted:true};
 for(const value of [{...valid,reclaimedBytes:1},{...valid,device:'/dev/sdb1'},{...valid,diskBytes:31*2**30},{...valid,discardCompleted:false}])assert.throws(()=>parseWindowsRootTrimReceipt(JSON.stringify(value),32));
 for(const size of [15,257,NaN])assert.throws(()=>windowsRootTrimScript(size));
});
