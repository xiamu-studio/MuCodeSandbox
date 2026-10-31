import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {run} from '../server/process.ts';
import {frameWindowsDesktopProgram,windowsDesktopComponentInvocation,WINDOWS_DESKTOP_FRAME_BOOTSTRAP} from '../server/platform/windows/desktop-component-transport.ts';

const executable=promisify(execFile)(process.platform==='win32'?'python':'python3',['-I','-c','import sys,json;print(json.dumps(sys.executable,ensure_ascii=True))'],{windowsHide:true}).then(result=>JSON.parse(result.stdout.trim()) as string);
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function invoke(frame:ReturnType<typeof frameWindowsDesktopProgram>,bytes:Uint8Array=frame.inputBytes,command=frame.command){return run(await executable,command.slice(1),{inputBytes:bytes,timeoutMs:4000,maxBytes:16384});}
async function rejected(frame:ReturnType<typeof frameWindowsDesktopProgram>,bytes:Uint8Array=frame.inputBytes,command=frame.command){await assert.rejects(invoke(frame,bytes,command),(error:unknown)=>{const e=error as Error&{code:string};assert.ok(['PROCESS_FAILED','PROCESS_INPUT_CLOSED'].includes(e.code),e.message);assert.ok(!e.message.includes('SYNTHETIC_SUCCESS_4d'));return true;});}
async function untilFile(file:string){const deadline=Date.now()+4000;while(true){try{return await readFile(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}assert.ok(Date.now()<deadline,'Python did not reach the synthetic marker');await delay(10);}}
async function temporary(work:(root:string)=>Promise<void>){const root=await mkdtemp(path.join(tmpdir(),'mu-desktop-frame-'));try{await work(root);}finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.match(path.basename(root),/^mu-desktop-frame-/);await rm(root,{recursive:true,force:true});}}

test('Both fixed desktop programs stay out of the Windows command line and mode/length mismatches refuse before invocation',()=>{
 for(const id of ['grok-bot','claude-desktop'] as const){const frame=windowsDesktopComponentInvocation(id,'inspect');assert.ok(frame.command.join(' ').length<6000);assert.equal(frame.command[0],'/usr/bin/python3');assert.equal(frame.archiveBytes,0);assert.equal(digest(frame.inputBytes.subarray(16)),frame.programSha256);if(id==='claude-desktop')assert.ok(frame.programBytes>32767);assert.throws(()=>windowsDesktopComponentInvocation(id,'inspect',new Uint8Array()),{code:'DESKTOP_COMPONENT_INPUT'});assert.throws(()=>windowsDesktopComponentInvocation(id,'install',new Uint8Array(1)),{code:'DESKTOP_COMPONENT_INPUT'});}
 assert.throws(()=>windowsDesktopComponentInvocation('grok-bot','unexpected' as 'inspect'),{code:'DESKTOP_COMPONENT_INPUT'});
 assert.throws(()=>frameWindowsDesktopProgram(''),{code:'DESKTOP_COMPONENT_INPUT'});
 assert.throws(()=>frameWindowsDesktopProgram('x'.repeat(2*1024*1024+1)),{code:'DESKTOP_COMPONENT_INPUT'});
});

test('Actual Python accepts a program above the Windows argv limit and preserves binary payload boundaries and UTF8 source',async()=>{
 const payload=randomBytes(131079),program='#'+'x'.repeat(700000)+'\nimport sys,json,hashlib\nfirst=sys.stdin.buffer.read(7);rest=sys.stdin.buffer.read()\nprint(json.dumps({"message":"本地合成数据","bytes":len(first)+len(rest),"sha256":hashlib.sha256(first+rest).hexdigest()}))\n',frame=frameWindowsDesktopProgram(program,payload),result=JSON.parse(await invoke(frame));
 assert.deepEqual(result,{message:'本地合成数据',bytes:payload.length,sha256:digest(payload)});
});

test('Malformed frames, oversized fields and wrong program hashes cannot execute the program',async()=>temporary(async root=>{
 const marker=path.join(root,'never-executed'),program=`import pathlib\npathlib.Path(${JSON.stringify(marker)}).write_text('SYNTHETIC_SUCCESS_4d')\n`,frame=frameWindowsDesktopProgram(program);
 const badMagic=Buffer.from(frame.inputBytes);badMagic[0]^=1;
 const oversized=Buffer.from(frame.inputBytes);oversized.writeUInt32BE(2097153,8);
 const oversizedArchive=Buffer.from(frame.inputBytes);oversizedArchive.writeUInt32BE(268435457,12);
 const changed=Buffer.from(frame.inputBytes);changed[17]^=1;
 for(const bytes of [frame.inputBytes.subarray(0,8),frame.inputBytes.subarray(0,-1),badMagic,oversized,oversizedArchive,changed]){await rejected(frame,bytes);await assert.rejects(access(marker),{code:'ENOENT'});}
 await rejected(frame,frame.inputBytes,[...frame.command.slice(0,-1),'0'.repeat(64)]);await assert.rejects(access(marker),{code:'ENOENT'});
}));

test('Ignored payload is bounded and drained, while truncation and trailing data cannot publish an early success',async()=>{
 const frame=frameWindowsDesktopProgram("print('SYNTHETIC_SUCCESS_4d')\n",randomBytes(65539));assert.equal((await invoke(frame)).trim(),'SYNTHETIC_SUCCESS_4d');
 await rejected(frame,frame.inputBytes.subarray(0,-1));await rejected(frame,Buffer.concat([frame.inputBytes,Buffer.from('extra')]));
 const reader=frameWindowsDesktopProgram("import sys\nsys.stdin.buffer.read()\nprint('SYNTHETIC_SUCCESS_4d')\n",Buffer.from('binary'));await rejected(reader,reader.inputBytes.subarray(0,-1));
});

test('Python output is held until the binary frame reaches a verified EOF',async()=>temporary(async root=>{
 const marker=path.join(root,'started'),payload=randomBytes(65536),frame=frameWindowsDesktopProgram(`import pathlib\npathlib.Path(${JSON.stringify(marker)}).write_text('started')\nprint('SYNTHETIC_SUCCESS_4d')\n`,payload),child=spawn(await executable,frame.command.slice(1),{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});child.stdin.on('error',()=>{});
 const closed=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 void closed.catch(()=>{});
 try{child.stdin.write(frame.inputBytes.subarray(0,16+frame.programBytes));await untilFile(marker);assert.equal(stdout,'');child.stdin.write(payload);await delay(25);assert.equal(stdout,'');child.stdin.end();assert.equal(await closed,0,stderr);assert.equal(stdout.trim(),'SYNTHETIC_SUCCESS_4d');}finally{if(child.exitCode===null){child.kill();await closed;}}
}));

test('Oversized output fails without releasing the component success prefix',async()=>{
 await rejected(frameWindowsDesktopProgram("print('SYNTHETIC_SUCCESS_4d'+'x'*8192)\n"));
});

test('Production runner cancellation terminates the direct Python reader, and pre-aborted calls never execute',async()=>temporary(async root=>{
 const marker=path.join(root,'started-pid'),frame=frameWindowsDesktopProgram(`import pathlib,os,time\npathlib.Path(${JSON.stringify(marker)}).write_text(str(os.getpid()))\ntime.sleep(30)\nprint('SYNTHETIC_SUCCESS_4d')\n`),abort=new AbortController(),promise=run(await executable,frame.command.slice(1),{inputBytes:frame.inputBytes,signal:abort.signal,timeoutMs:8000});
 const outcome=promise.then(()=>({ok:true,error:null}),error=>({ok:false,error}));let pid:number|undefined;
 try{pid=Number(await untilFile(marker));abort.abort();const result=await outcome;assert.equal(result.ok,false);assert.equal(result.error.code,'CANCELLED');assert.throws(()=>process.kill(pid!,0),{code:'ESRCH'});}finally{abort.abort();await outcome;}
 const before=path.join(root,'pre-abort'),never=frameWindowsDesktopProgram(`import pathlib\npathlib.Path(${JSON.stringify(before)}).write_text('unexpected')\n`),cancelled=new AbortController();cancelled.abort();await assert.rejects(run(await executable,never.command.slice(1),{inputBytes:never.inputBytes,signal:cancelled.signal}),{code:'CANCELLED'});await assert.rejects(access(before),{code:'ENOENT'});
}));
