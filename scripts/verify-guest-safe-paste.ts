// An owned transient Bash PTY only: no user terminal, file or AI account.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {LimaRuntime} from '../server/runtime.ts';
const info=JSON.parse(await readFile('/Users/staff/.mucodesandbox/service-info.json','utf8'));
const launch=await fetch(info.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie')!.split(';')[0];
const html=await(await fetch(info.url,{headers:{Cookie:cookie}})).text(),config=JSON.parse(html.match(/window.__MU_CONFIG__=(\{[^<]*?\});/)![1]);
async function api(route:string){const r=await fetch(info.url+route,{headers:{Authorization:'Bearer '+config.token,Cookie:cookie}});assert.ok(r.ok);return r.json();}
const e=(await api('/api/snapshot')).environments.find((e:any)=>e.id==='76c193f7-09a2-4544-83b8-4852445ab2be');assert.equal(e.state,'running');
const before=await api(`/api/environments/${e.id}/network/protection`);assert.ok(before.active&&before.integrity==='verified');
const program=String.raw`import os,pty,select,signal,time,json
def exercise(bracketed):
 pid,fd=pty.fork()
 if pid==0:
  os.environ.update({'TERM':'xterm-256color','PS1':'MU_LOCAL_PROMPT> ','INPUTRC':'/dev/null','HISTFILE':'/dev/null','PROMPT_COMMAND':''})
  os.execv('/usr/bin/bash',['bash','--noprofile','--norc','-i'])
 def read_for(seconds):
  out=b'';end=time.monotonic()+seconds
  while time.monotonic()<end:
   ready,_,_=select.select([fd],[],[],max(0,min(.05,end-time.monotonic())))
   if ready:
    try:out+=os.read(fd,65536)
    except OSError:break
  return out
 try:
  start=read_for(.5)
  assert b'\x1b[?2004h' in start,'Bash must enable bracketed paste'
  text=b"printf '%s%s\\n' 'MU_LOCAL_PASTE_' 'EXECUTED'\nprintf '%s\\n' 'second line'"
  os.write(fd,(b'\x1b[200~'+text+b'\x1b[201~') if bracketed else text)
  output=read_for(.4)
  executed=b'MU_LOCAL_PASTE_EXECUTED' in output
  assert executed is (not bracketed),'Owned control distinguishes paste from execution'
  return {'bracketed':bracketed,'enteredCommandExecuted':executed}
 finally:
  try:os.kill(pid,signal.SIGKILL)
  except ProcessLookupError:pass
  os.close(fd);os.waitpid(pid,0)
print(json.dumps({'checks':[exercise(True),exercise(False)],'filesCreated':False,'externalRequests':0}))
`;
const bootstrap='import json,sys;exec(compile(json.loads(sys.stdin.read()),"<owned-safe-paste>","exec"))';
const actual=JSON.parse(await new LimaRuntime('/Users/staff/.mucodesandbox').guest(e,['python3','-c',bootstrap],{input:JSON.stringify(program),timeoutMs:12000,maxBytes:8192}));
assert.deepEqual(actual.checks,[{bracketed:true,enteredCommandExecuted:false},{bracketed:false,enteredCommandExecuted:true}]);
const after=await api(`/api/environments/${e.id}/network/protection`);assert.ok(after.active&&after.integrity==='verified'&&after.leaseActive);
for(const field of ['firewallHash','bootFileHash','tunnelConfigHash','leaseRulesHash'])assert.equal(after[field],before[field]);
await mkdir('test-results/all-quick-tools',{recursive:true});await writeFile('test-results/all-quick-tools/guest-paste.json',JSON.stringify({passed:true,at:new Date().toISOString(),scope:'Two owned Bash PTYs with synthetic printf, without user dotfiles; terminated and reaped; no provider requests or files.',actual,guardUnchanged:true},null,2));console.log(JSON.stringify({passed:true,actual,guardUnchanged:true}));
