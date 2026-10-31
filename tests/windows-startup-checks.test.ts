import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initializeWindowsPrerequisites} from '../server/platform/windows/startup-checks.ts';

test('Startup runs both prerequisites and waits for both to complete',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const started:string[]=[];let ready=false;
 const check=initializeWindowsPrerequisites(async()=>{started.push('host');await gate;},async()=>{started.push('base');await gate;}).then(()=>{ready=true;});
 await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(started,['host','base']);assert.equal(ready,false);release();await check;assert.equal(ready,true);
});

test('Startup failure cannot finish while the other prerequisite is still running',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let completed=false;
 const denied=assert.rejects(initializeWindowsPrerequisites(async()=>{throw Error('host failed');},async()=>{await gate;}).finally(()=>{completed=true;}),/host failed/);
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(completed,false);release();await denied;assert.equal(completed,true);
});
