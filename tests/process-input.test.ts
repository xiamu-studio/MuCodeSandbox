import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {run} from '../server/process.ts';

test('Process output preserves Chinese and emoji split across pipe chunks',async()=>{
 for(const stream of ['stdout','stderr'])for(const boundary of ['中','😀']){
  const text=JSON.stringify({path:'中文/文件😀.txt'}),parts:string[]=[];
  const script=`const bytes=Buffer.from(${JSON.stringify(text)}),split=bytes.indexOf(Buffer.from(${JSON.stringify(boundary)}))+1;process.${stream}.write(bytes.subarray(0,split));setTimeout(()=>process.${stream}.write(bytes.subarray(split)),100);`;
  const result=await run(process.execPath,['-e',script],{onOutput:text=>parts.push(text),timeoutMs:5000});
  assert.equal(result,text);assert.equal(parts.join(''),text);
 }
});
test('Concurrent stdout and stderr keep independent UTF-8 decoder state',async()=>{
 const script="const a=Buffer.from('中文'),b=Buffer.from('诊断😀');process.stdout.write(a.subarray(0,1));process.stderr.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(a.subarray(1)),100);setTimeout(()=>process.stderr.write(b.subarray(2)),150);";
 const result=await run(process.execPath,['-e',script],{timeoutMs:5000});
 assert.ok(result.includes('中文'));assert.ok(result.includes('诊断😀'));assert.equal(result.includes('\uFFFD'),false);
});

test('Large stdin remains an ordinary rejected operation when the child exits early',async()=>{
 await assert.rejects(run(process.execPath,['-e','process.exit(1)'],{input:'x'.repeat(4*1024*1024),timeoutMs:5000}));
 // The same service process must still be able to run its next operation.
 assert.equal(await run(process.execPath,['-e','process.stdout.write("alive")']),'alive');
});
test('Output callback errors reject the task without crashing the service',async()=>{
 for(const stream of ['stdout','stderr'])await assert.rejects(run(process.execPath,['-e',`process.${stream}.write('ready');setInterval(()=>{},1000);`],{onOutput:()=>{throw Error('private diagnostic');},timeoutMs:5000}),{code:'PROCESS_OUTPUT_HANDLER_FAILED'});
 assert.equal(await run(process.execPath,['-e',"process.stdout.write('alive')"]),'alive');
});

test('Closing stdin without consuming the payload cannot report success',async()=>{
 await assert.rejects(run(process.execPath,['-e','process.stdin.destroy();setTimeout(()=>process.exit(0),1000)'],{input:'x'.repeat(4*1024*1024),timeoutMs:5000}),{code:'PROCESS_INPUT_CLOSED'});
});

test('Large Unicode stdin is delivered completely',async()=>{
 const input='文件传输\n'.repeat(100000),expected=createHash('sha256').update(input).digest('hex');
 const result=await run(process.execPath,['-e','const h=require("node:crypto").createHash("sha256");process.stdin.on("data",c=>h.update(c));process.stdin.on("end",()=>process.stdout.write(h.digest("hex")))'],{input,timeoutMs:5000});
 assert.equal(result,expected);
});
