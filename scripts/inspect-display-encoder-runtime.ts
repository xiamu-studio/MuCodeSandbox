import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {LimaRuntime} from '../server/runtime.ts';
import {DISPLAY_ENCODER_EXECUTABLE,DISPLAY_ENCODER_BINARY_SHA256} from '../server/guest-display-encoder.ts';

const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const cookie=(await fetch(info.launchUrl,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text();
const cfg=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
const s=await(await fetch(info.url+'/api/snapshot',{headers:{Authorization:'Bearer '+cfg.token}})).json() as any;
const e=s.environments.find((e:any)=>e.id==='76c193f7-09a2-4544-83b8-4852445ab2be');assert.equal(e.state,'running');
const runtime=new LimaRuntime('/Users/staff/.mucodesandbox');
const source=`import pathlib,pwd,subprocess,hashlib,json,socket,ipaddress
dev=pwd.getpwnam('dev');unit='mucodesandbox-display.service'
group=subprocess.check_output(['systemctl','show',unit,'--property=ControlGroup','--value'],text=True).strip();assert group=='/system.slice/'+unit
pids=set()
for file in pathlib.Path('/sys/fs/cgroup'+group).rglob('cgroup.procs'):pids.update(file.read_text().split())
rows=[]
for pid in pids:
 p=pathlib.Path('/proc')/pid
 try:
  if str(p.joinpath('exe').readlink())!='${DISPLAY_ENCODER_EXECUTABLE}':continue
  args=p.joinpath('cmdline').read_bytes().split(bytes([0]));args=[v.decode() for v in args if v]
  def argument(name):return args[args.index(name)+1]
  assert argument('-securitytypes')=='vnc' and argument('-interface')=='127.0.0.1' and argument('-rfbport')=='5900'
  assert all(v in args for v in ['-noclipboardrecv','-noclipboardsend','-noprimarysync','-noreset'])
  assert int(argument('-nthreads'))==min(4,${e.cpus})
  auth=pathlib.Path(argument('-auth'));assert auth.stat().st_uid==dev.pw_uid and auth.stat().st_mode&0o777==0o600
  denied=subprocess.run(['sudo','-H','-u','nobody','--','env','-i','PATH=/usr/bin:/bin','DISPLAY=:99','XAUTHORITY=/nonexistent','xdpyinfo'],capture_output=True).returncode!=0;assert denied
  sockets=set()
  for descriptor in p.joinpath('fd').iterdir():
   try:
    target=str(descriptor.readlink())
    if target.startswith('socket:['):sockets.add(target[8:-1])
   except FileNotFoundError:pass
  listeners=[]
  for name,family in [('tcp',socket.AF_INET),('tcp6',socket.AF_INET6)]:
   for line in pathlib.Path('/proc/net/'+name).read_text().splitlines()[1:]:
    values=line.split()
    if values[3]!='0A' or values[9] not in sockets:continue
    host,port=values[1].split(':');data=bytes.fromhex(host)
    data=data[::-1] if family==socket.AF_INET else b''.join(data[i:i+4][::-1] for i in range(0,16,4))
    address=socket.inet_ntop(family,data);assert ipaddress.ip_address(address).is_loopback and int(port,16)==5900
    listeners.append({'address':address,'port':int(port,16)})
  assert listeners
  binary=pathlib.Path('${DISPLAY_ENCODER_EXECUTABLE}');assert hashlib.sha256(binary.read_bytes()).hexdigest()=='${DISPLAY_ENCODER_BINARY_SHA256}'
  rows.append({'pid':int(pid),'encodingThreads':int(argument('-nthreads')),'threadCount':len(list(p.joinpath('task').iterdir())),'binarySha256':'${DISPLAY_ENCODER_BINARY_SHA256}','missingXAuthorityDenied':denied,'xAuthorityUid':auth.stat().st_uid,'listeners':listeners,'automaticClipboardDisabled':True})
 except (FileNotFoundError,ProcessLookupError):pass
assert len(rows)==1
print(json.dumps({'passed':True,'displays':rows}))`;
const report={at:new Date().toISOString(),application:s.system.application,version:s.system.version,...JSON.parse(await runtime.management(e,['sudo','python3','-c',source],{timeoutMs:12000,maxBytes:6000}))};
await writeFile('test-results/smoothness-0447/display-runtime.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
