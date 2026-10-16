import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {GuestExchange,INLINE_TRANSLATE_PYTHON,INLINE_TRANSLATE_BOOTSTRAP,inlineTranslationText} from '../server/guest-exchange.ts';
import {LimaRuntime} from '../server/runtime.ts';
import {environmentSchema} from '../server/validation.ts';
import type {Environment} from '../shared/types.ts';
const e={...environmentSchema.parse({name:'Translate fixture'}),id:'fixture',instanceName:'fixture',state:'running',updatedAt:'one'} as Environment;
test('Text translation uses guest stdin and refuses revoked or changed access',async()=>{
 const runtime=new LimaRuntime('/tmp/mu-inline-unused');let allowed=true,calls=0;
 runtime.guest=async(_e,args,opts)=>{calls++;assert.equal(args[2],INLINE_TRANSLATE_BOOTSTRAP);assert.ok(args.join(' ').length<200&&!args.join(' ').includes('中文 secret'));const [program,input]=opts!.input!.split('\n');assert.equal(JSON.parse(program),INLINE_TRANSLATE_PYTHON);assert.deepEqual(JSON.parse(input),{text:'中文 secret'});assert.equal(opts!.onOutput,undefined);return JSON.stringify({text:'English',provider:'Google'});};
 const exchange=new GuestExchange(runtime,async()=>{if(!allowed)throw new Error('revoked');return e;});
 assert.equal((await exchange.translate(e.id,'中文 secret')).text,'English');assert.equal(calls,1);
 allowed=false;await assert.rejects(exchange.translate(e.id,'中文 secret'),/revoked/);assert.equal(calls,1);
 allowed=true;runtime.guest=async()=>{allowed=false;return JSON.stringify({text:'English',provider:'Google'});};await assert.rejects(exchange.translate(e.id,'中文 secret'),/revoked/);
});
test('Provider output is bounded and failures never expose source or try a host fallback',async()=>{
 const runtime=new LimaRuntime('/tmp/mu-inline-unused');let calls=0;runtime.guest=async()=>{calls++;throw new Error('private source or URL');};
 const exchange=new GuestExchange(runtime,async()=>e);
 await assert.rejects(exchange.translate(e.id,'private source'),error=>!String(error).includes('private source')&&String(error).includes('原文已保留'));assert.equal(calls,1);
 for(const text of ['', ' ', 'x'.repeat(2001), '\0'])assert.equal(inlineTranslationText.safeParse(text).success,false);
});
test('Guest request uses a fixed HTTPS endpoint, bounded curl and handles segmented translation',()=>{
 const fake=`import subprocess,json,urllib.parse,types
 def_run=None
`.replace(' def_run=None\n','');
 const stub=`
def run(args,**kwargs):
 assert '--location' not in args and '--insecure' not in args
 assert '--max-time' in args and '--max-filesize' in args
 assert '私密' not in ' '.join(args)
 url=json.loads(kwargs['input'].split(' = ',1)[1])
 parsed=urllib.parse.urlparse(url)
 assert parsed.scheme=='https' and parsed.netloc=='translate.googleapis.com'
 assert urllib.parse.parse_qs(parsed.query)['q']==['私密 & ?\\n文本']
 return types.SimpleNamespace(returncode=0,stdout=json.dumps([[['Hello ',None],['world.',None]],None,'zh-CN'])+'\\n200')
subprocess.run=run
`;
 const result=execFileSync('python3',['-c',fake+stub+INLINE_TRANSLATE_PYTHON],{input:JSON.stringify({text:'私密 & ?\n文本'}),encoding:'utf8'});
 assert.deepEqual(JSON.parse(result),{text:'Hello world.',provider:'Google'});
});
test('Provider failures distinguish transport, refusal, quota and invalid replies without returning private data',async()=>{
 const cases=[
  {rc:28,status:0,body:'',reason:'timeout'},
  {rc:6,status:0,body:'',reason:'dns_failed'},
  {rc:7,status:0,body:'',reason:'connect_failed'},
  {rc:60,status:0,body:'',reason:'tls_failed'},
  {rc:22,status:429,body:'private source',reason:'rate_limited'},
  {rc:22,status:403,body:'private source',reason:'refused'},
  {rc:22,status:503,body:'private source',reason:'http_failed'},
  {rc:0,status:302,body:'private source',reason:'http_failed'},
  {rc:63,status:200,body:'',reason:'response_too_large'},
  {rc:56,status:0,body:'private source',reason:'transport_failed'},
  {rc:0,status:200,body:'private source',reason:'response_invalid'},
 ];
 for(const entry of cases){
  const stub=`import subprocess,types\ndef run(*args,**kwargs):\n return types.SimpleNamespace(returncode=${entry.rc},stdout=${JSON.stringify(entry.body+'\n'+String(entry.status).padStart(3,'0'))})\nsubprocess.run=run\n`;
  const raw=execFileSync('python3',['-c',stub+INLINE_TRANSLATE_PYTHON],{input:JSON.stringify({text:'private source'}),encoding:'utf8'});
  assert.deepEqual(JSON.parse(raw),{error:entry.reason,httpStatus:entry.status});assert.ok(!raw.includes('private source'));
  const runtime=new LimaRuntime('/tmp/mu-inline-unused');runtime.guest=async()=>raw;
  await assert.rejects(new GuestExchange(runtime,async()=>e).translate(e.id,'private source'),error=>String(error).includes('原文已保留')&&(error as any).code==='TRANSLATION_'+entry.reason.toUpperCase()&&!String(error).includes('private source'));
 }
});
