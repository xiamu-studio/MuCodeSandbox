import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {run} from '../server/process.ts';

test('Large stdin remains an ordinary rejected operation when the child exits early',async()=>{
 await assert.rejects(run(process.execPath,['-e','process.exit(1)'],{input:'x'.repeat(4*1024*1024),timeoutMs:5000}));
 // The same service process must still be able to run its next operation.
 assert.equal(await run(process.execPath,['-e','process.stdout.write("alive")']),'alive');
});

test('Closing stdin without consuming the payload cannot report success',async()=>{
 await assert.rejects(run(process.execPath,['-e','process.stdin.destroy();setTimeout(()=>process.exit(0),1000)'],{input:'x'.repeat(4*1024*1024),timeoutMs:5000}),{code:'PROCESS_INPUT_CLOSED'});
});

test('Large Unicode stdin is delivered completely',async()=>{
 const input='文件传输\n'.repeat(100000),expected=createHash('sha256').update(input).digest('hex');
 const result=await run(process.execPath,['-e','const h=require("node:crypto").createHash("sha256");process.stdin.on("data",c=>h.update(c));process.stdin.on("end",()=>process.stdout.write(h.digest("hex")))'],{input,timeoutMs:5000});
 assert.equal(result,expected);
});
