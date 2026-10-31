import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {GuestExchange,inlineTranslationText} from '../server/guest-exchange.ts';
import {DEEPSEEK_TRANSLATE_PYTHON,TRANSLATE_BOOTSTRAP,TRANSLATION_PROMPT} from '../server/deepseek-translation.ts';
import {TRANSLATION_INPUT_LIMIT,TRANSLATION_OUTPUT_LIMIT,TRANSLATION_MAX_TOKENS,TRANSLATION_TIMEOUT_SECONDS,TRANSLATION_RESPONSE_BYTES,TRANSLATION_MODEL,translationTarget} from '../shared/translation.ts';
import {LimaRuntime} from '../server/runtime.ts';
import {environmentSchema} from '../server/validation.ts';
import type {Environment} from '../shared/types.ts';
import {AppError} from '../server/errors.ts';
const e={...environmentSchema.parse({name:'Translate fixture'}),id:'fixture',instanceName:'fixture',state:'running',updatedAt:'one'} as Environment;
const key='sk-local-fixture-not-a-real-key';
const credentials={revision:0,credential(){return{apiKey:key,revision:this.revision};}};
const input=(text='private source',target='zh')=>({text,apiKey:key,target,model:TRANSLATION_MODEL,prompt:TRANSLATION_PROMPT});
const response=(text='English',target='en')=>({text,provider:'DeepSeek',target,model:TRANSLATION_MODEL});
function guest(stub:string,request=input()) {
 const bootstrap='import sys,json;exec(compile(json.loads(sys.stdin.buffer.readline()), "<translation-fixture>", "exec"))';
 return execFileSync(process.platform==='win32'?'python':'python3',['-I','-X','utf8','-c',bootstrap],{input:JSON.stringify(stub+DEEPSEEK_TRANSLATE_PYTHON)+'\n'+JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:2*1024*1024});
}

test('Translation goes through guarded guest stdin, with no key/source in argv and no host fallback',async()=>{
 const runtime=new LimaRuntime('/tmp/mu-inline-unused');let allowed=true,calls=0;
 runtime.guest=async(_e,args,opts)=>{calls++;assert.equal(args[2],TRANSLATE_BOOTSTRAP);assert.ok(args.join(' ').length<200);assert.ok(!args.join(' ').includes(key)&&!args.join(' ').includes('中文 secret'));const [program,data]=opts!.input!.split('\n');assert.equal(JSON.parse(program),DEEPSEEK_TRANSLATE_PYTHON);assert.deepEqual(JSON.parse(data),input('中文 secret','en'));assert.equal(opts!.onOutput,undefined);assert.equal(opts!.timeoutMs,(TRANSLATION_TIMEOUT_SECONDS+6)*1000);assert.equal(opts!.maxBytes,TRANSLATION_RESPONSE_BYTES);return JSON.stringify(response());};
 const exchange=new GuestExchange(runtime,async()=>{if(!allowed)throw Error('revoked');return e;},credentials);
 assert.equal((await exchange.translate(e.id,'中文 secret')).text,'English');assert.equal(calls,1);
 allowed=false;await assert.rejects(exchange.translate(e.id,'中文 secret'),/revoked/);assert.equal(calls,1);
 allowed=true;runtime.guest=async()=>{allowed=false;return JSON.stringify(response());};await assert.rejects(exchange.translate(e.id,'中文 secret'),/revoked/);
});
test('Auto direction and explicit overrides support both languages without changing input',()=>{
 assert.equal(translationTarget('中文 English','auto'),'en');assert.equal(translationTarget('How are you?','auto'),'zh');
 assert.equal(translationTarget('中文 English','zh'),'zh');assert.equal(translationTarget('English','en'),'en');
 for(const value of ['', ' ', 'x'.repeat(TRANSLATION_INPUT_LIMIT+1), '\0'])assert.equal(inlineTranslationText.safeParse(value).success,false);
});
test('Missing or changed credentials do not issue or deliver a request',async()=>{
 const runtime=new LimaRuntime('/tmp/mu-inline-unused');let calls=0;runtime.guest=async()=>{calls++;credentials.revision++;return JSON.stringify(response());};
 await assert.rejects(new GuestExchange(runtime,async()=>e).translate(e.id,'中文'),/Key/);assert.equal(calls,0);
 await assert.rejects(new GuestExchange(runtime,async()=>e,credentials).translate(e.id,'中文'),/密钥已更改/);assert.equal(calls,1);
});
test('Raw runtime/provider errors cannot leak source, key or body and never cause retries',async()=>{
 const runtime=new LimaRuntime('/tmp/mu-inline-unused');let calls=0;runtime.guest=async()=>{calls++;throw Error(key+' private source');};
 await assert.rejects(new GuestExchange(runtime,async()=>e,credentials).translate(e.id,'private source'),err=>!String(err).includes(key)&&!String(err).includes('private source')&&String(err).includes('原文已保留'));assert.equal(calls,1);
});

test('Cancelling translation aborts authorization/guest work and never delivers a late result',async()=>{
 const runtime=new LimaRuntime('/tmp/mu-inline-unused'),controller=new AbortController();let entered=false,cancelled=0;
 runtime.guest=async(_e,_args,options={})=>{entered=true;return new Promise<string>((_resolve,reject)=>options.signal?.addEventListener('abort',()=>{cancelled++;reject(new AppError('cancelled',409,'CANCELLED'));},{once:true}));};
 const exchange=new GuestExchange(runtime,async(_id,signal)=>{signal?.throwIfAborted();return e;},credentials);const pending=exchange.translate(e.id,'中文 secret','en',controller.signal);while(!entered)await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,{code:'CANCELLED'});assert.equal(cancelled,1);assert.equal(exchange.busy.has(e.id),false);
});
test('Both languages use fixed official endpoint and translation-only prompt, with thinking/tools disabled',()=>{
 for(const target of ['en','zh']){
  const stub=`import subprocess,json,types\ndef run(args,**kwargs):\n assert '--location' not in args and '--insecure' not in args and '--retry' not in args\n assert '--max-time' in args and '--max-filesize' in args and '--ipv4' in args\n assert '${key}' not in ' '.join(args) and 'private question?' not in ' '.join(args)\n conf=dict(line.split(' = ',1) for line in kwargs['input'].splitlines() if not line.startswith('header'))\n assert json.loads(conf['url'])=='https://api.deepseek.com/chat/completions'\n assert 'Authorization: Bearer ${key}' in kwargs['input']\n body=json.loads(json.loads(conf['data']))\n assert body['model']=='deepseek-flash' and body['thinking']=={'type':'disabled'} and body['stream'] is False\n assert body['max_tokens']==${TRANSLATION_MAX_TOKENS} and 'tools' not in body\n assert len(body['messages'])==2 and body['messages'][1]=={'role':'user','content':'private question?'}\n assert 'never answer' in body['messages'][0]['content'] and '${target==='en'?'English':'Simplified Chinese'}' in body['messages'][0]['content']\n return types.SimpleNamespace(returncode=0,stdout=json.dumps({'choices':[{'finish_reason':'stop','message':{'content':'local translation'}}]})+'\\n200')\nsubprocess.run=run\n`;
  const result=guest(stub,input('private question?',target));assert.deepEqual(JSON.parse(result),response('local translation',target));assert.ok(!result.includes(key));
 }
});
test('Provider errors distinguish authentication, balance, quota, TLS and incomplete output without echoing body',async()=>{
 const cases=[{rc:28,status:0,reason:'timeout'},{rc:6,status:0,reason:'dns_failed'},{rc:7,status:0,reason:'connect_failed'},{rc:60,status:0,reason:'tls_failed'},{rc:0,status:401,reason:'unauthorized'},{rc:0,status:402,reason:'balance'},{rc:0,status:429,reason:'rate_limited'},{rc:0,status:403,reason:'refused'},{rc:0,status:503,reason:'http_failed'},{rc:0,status:302,reason:'http_failed'},{rc:63,status:200,reason:'response_too_large'},{rc:56,status:0,reason:'transport_failed'},{rc:0,status:200,reason:'response_invalid'},{rc:0,status:200,reason:'incomplete',body:JSON.stringify({choices:[{finish_reason:'length',message:{content:'partial private source'}}]})}];
 for(const entry of cases){const body=entry.body??'private source '+key;const stub=`import subprocess,types\ndef run(*args,**kwargs):\n return types.SimpleNamespace(returncode=${entry.rc},stdout=${JSON.stringify(body+'\n'+String(entry.status).padStart(3,'0'))})\nsubprocess.run=run\n`;
  const raw=guest(stub);assert.deepEqual(JSON.parse(raw),{error:entry.reason,httpStatus:entry.status});assert.ok(!raw.includes(key)&&!raw.includes('private source'));
  const runtime=new LimaRuntime('/tmp/mu-inline-unused');runtime.guest=async()=>raw;
  await assert.rejects(new GuestExchange(runtime,async()=>e,credentials).translate(e.id,'private source'),err=>String(err).includes('原文已保留')&&(err as any).code==='TRANSLATION_'+entry.reason.toUpperCase()&&!String(err).includes(key));
 }
});
test('Incomplete, tool-only, empty or oversized replies are never pasted as translations',()=>{
 for(const choice of [{finish_reason:'tool_calls',message:{tool_calls:[{}]}},{finish_reason:'stop',message:{content:''}},{finish_reason:'stop',message:{content:'x'.repeat(TRANSLATION_OUTPUT_LIMIT+1)}},{finish_reason:'stop',message:{content:'text',tool_calls:[{}]}}]){
  const stub=`import subprocess,types\nsubprocess.run=lambda *a,**k:types.SimpleNamespace(returncode=0,stdout=${JSON.stringify(JSON.stringify({choices:[choice]})+'\n200')})\n`;
  assert.equal(JSON.parse(guest(stub)).error,'response_invalid');
 }
});

// Production Python, synthetic curl only: verify no line folding, stripping or
// UTF-16 disagreement at the source/result limits, including astral characters.
test('Long translations retain blank lines, tabs, Markdown, code and trailing newline',()=>{
 const text=('标题\n\n1. 列表\n\t缩进\n```js\n  const n = 1;\n```\n').repeat(65);
 assert.ok(text.length>2000);assert.equal(inlineTranslationText.safeParse(text).success,true);
 const translated=('Title\n\n1. List\n\tIndent\n```js\n  const n = 1;\n```\n').repeat(200);
 const stub=`import subprocess,types,json\ndef run(*args,**kwargs):\n conf=dict(line.split(' = ',1) for line in kwargs['input'].splitlines() if not line.startswith('header'))\n body=json.loads(json.loads(conf['data']))\n assert body['messages'][1]['content']==${JSON.stringify(text)}\n return types.SimpleNamespace(returncode=0,stdout=${JSON.stringify(JSON.stringify({choices:[{finish_reason:'stop',message:{content:translated}}]})+'\n200')})\nsubprocess.run=run\n`;
 assert.equal(JSON.parse(guest(stub,input(text))).text,translated);
 const echo=`import subprocess,types,json\nsubprocess.run=lambda *a,**k:types.SimpleNamespace(returncode=0,stdout=json.dumps({'choices':[{'finish_reason':'stop','message':{'content':'ok'}}]})+'\\n200')\n`;
 for(const value of ['x'.repeat(TRANSLATION_INPUT_LIMIT),'😀'.repeat(TRANSLATION_INPUT_LIMIT/2)]){assert.equal(inlineTranslationText.safeParse(value).success,true);assert.equal(JSON.parse(guest(echo,input(value))).text,'ok');}
 for(const value of ['x'.repeat(TRANSLATION_INPUT_LIMIT+1),'😀'.repeat(TRANSLATION_INPUT_LIMIT/2)+'x']){assert.equal(inlineTranslationText.safeParse(value).success,false);assert.equal(JSON.parse(guest(echo,input(value))).error,'response_invalid');}
});
