import {test} from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {run,type Runner} from '../server/process.ts';
import {runWindowsSsh} from '../server/platform/windows/ssh-process.ts';

for(const [name,runner] of [['general',run],['Windows SSH',runWindowsSsh]] as const)for(const cause of ['cancellation','timeout']){
 test(`${name} retains ${cause} when process errors arrive during teardown`,async t=>{
  if(cause==='timeout')t.mock.timers.enable({apis:['setTimeout']});
  const child=Object.assign(new EventEmitter(),{
   pid:12345,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),
   kill:()=>{queueMicrotask(()=>{child.emit('error',Error('synthetic teardown error'));child.emit('error',Error('second synthetic teardown error'));child.emit('close',null);});return true;},
  });
  const spawn=t.mock.method(childProcess,'spawn',()=>child as unknown as ReturnType<typeof childProcess.spawn>);
  // No real process or process group is created or signalled by this fixture.
  const kill=t.mock.method(process,'kill',()=>child.kill());
  syncBuiltinESMExports();
  try{
   const abort=new AbortController();
   const pending=(runner as Runner)('synthetic-child',[],{signal:abort.signal,timeoutMs:5000});
   const rejected=assert.rejects(pending,{code:cause==='cancellation'?'CANCELLED':'TIMEOUT'});
   if(cause==='cancellation')abort.abort();else t.mock.timers.tick(5000);
   await rejected;
  }finally{
   child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
   spawn.mock.restore();kill.mock.restore();syncBuiltinESMExports();
  }
 });
}
