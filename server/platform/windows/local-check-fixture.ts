import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {FEATURES_JS} from '../../probe-assets.ts';
import {windowsCheckProbeSchema,type WindowsCheckProbe} from '../../../shared/windows-local-check.ts';

// Fulfilled only on the private CDP connection: no listener, DNS/STUN endpoint,
// service credential, host forwarding or route to a model provider.
export const WINDOWS_CHECK_ORIGIN='https://mucodesandbox-check.invalid';
const credential='mu-windows-local-synthetic-only';
const html='<!doctype html><meta charset="utf-8"><title>MuCodeSandbox local check</title><link rel="icon" href="data:,"><script type="module" src="/probe.js"></script><main>MuCodeSandbox 本地无账号检测</main>';
export const WINDOWS_CHECK_PROBE_JS=String.raw`import {measure} from '/features.js';
async function timed(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timeout')),6000)})]);}finally{clearTimeout(timer);}}
async function run(){
 const page=await measure();
 const worker=await timed(new Promise((resolve,reject)=>{const url=URL.createObjectURL(new Blob([/*MU_WORKER_SOURCE*/],{type:'text/javascript'}));const worker=new Worker(url,{type:'module'});worker.onmessage=event=>{URL.revokeObjectURL(url);worker.terminate();resolve(event.data);};worker.onerror=()=>{URL.revokeObjectURL(url);worker.terminate();reject(Error('Worker failed'));};}),'Worker');
 const frame=await timed(new Promise((resolve,reject)=>{const frame=document.createElement('iframe');frame.hidden=true;const receive=event=>{if(event.source===frame.contentWindow&&event.origin===location.origin){removeEventListener('message',receive);frame.remove();resolve(event.data);}};addEventListener('message',receive);frame.onerror=()=>{removeEventListener('message',receive);frame.remove();reject(Error('Frame failed'));};frame.src='/frame';document.body.append(frame);}),'iframe');
 const receipt=await(await fetch('/api/receipts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({page,worker,frame})})).json();
 const login=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:'synthetic-a'})});if(!login.ok)throw Error('Synthetic login failed');
 const session=await(await fetch('/api/session')).json();
 const response=await fetch('/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':'mu-windows-local-synthetic-only'},body:JSON.stringify({model:'mu-mock',stream:true,max_tokens:128,messages:[{role:'user',content:'Hello local test'}]})});
 if(!response.ok||!response.body)throw Error('Synthetic stream failed');
 const reader=response.body.getReader(),decoder=new TextDecoder();let stream='',bytes=0;
 for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>16384){await reader.cancel();throw Error('Synthetic stream exceeds bound');}stream+=decoder.decode(next.value,{stream:true});}stream+=decoder.decode();
 const events=stream.split('\n\n').filter(Boolean).map(block=>{const line=block.split('\n').find(line=>line.startsWith('data: '));if(!line)throw Error('Synthetic event missing');return JSON.parse(line.slice(6)).type;});
 globalThis.__MU_WINDOWS_CHECK__={receiptId:receipt.id,account:session.account,events};
}
run().catch(()=>{globalThis.__MU_WINDOWS_CHECK_ERROR__='Local fixture did not complete';});
`.replace('/*MU_WORKER_SOURCE*/',JSON.stringify(FEATURES_JS+'\nmeasure().then(result=>postMessage(result));'));
export interface WindowsCheckRequest{url:string;method:string;headers:Record<string,string>;postData?:string}
export interface WindowsCheckResponse{status:number;headers:{name:string;value:string}[];body:string}
export class WindowsLocalCheckFixture{
 readonly runId=randomUUID();readonly url=WINDOWS_CHECK_ORIGIN+'/?run='+this.runId;readonly cookie=randomBytes(24).toString('base64url');
 requests=0;syntheticModelCalls=0;loggedIn=false;receipt:{id:string;probe:WindowsCheckProbe}|undefined;
 private response(status:number,type:string,body:string,extra:{name:string;value:string}[]=[]):WindowsCheckResponse{return {status,body,headers:[{name:'Content-Type',value:type},{name:'Cache-Control',value:'no-store'},{name:'X-Content-Type-Options',value:'nosniff'},{name:'Content-Security-Policy',value:"default-src 'self'; script-src 'self'; style-src 'none'; worker-src blob:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"},...extra]};}
 handle(request:WindowsCheckRequest):WindowsCheckResponse{
  if(++this.requests>64)throw Error('Local check request budget exceeded');
  const url=new URL(request.url);if(url.origin!==WINDOWS_CHECK_ORIGIN||url.username||url.password||url.hash||request.postData&&Buffer.byteLength(request.postData)>98304)throw Error('Unexpected local check request');
  const headers=Object.fromEntries(Object.entries(request.headers).map(([key,value])=>[key.toLowerCase(),value]));
  const json=(status:number,value:unknown,extra:{name:string;value:string}[]=[])=>this.response(status,'application/json',JSON.stringify(value),extra);
  if(request.method==='GET'&&!request.postData){
   if(url.pathname==='/'&&url.search==='?run='+this.runId)return this.response(200,'text/html; charset=utf-8',html);
   if(url.search)throw Error('Unexpected local check query');
   if(url.pathname==='/features.js')return this.response(200,'text/javascript; charset=utf-8',FEATURES_JS);
   if(url.pathname==='/probe.js')return this.response(200,'text/javascript; charset=utf-8',WINDOWS_CHECK_PROBE_JS);
   if(url.pathname==='/frame')return this.response(200,'text/html; charset=utf-8','<!doctype html><script type="module" src="/frame.js"></script>');
   if(url.pathname==='/frame.js')return this.response(200,'text/javascript; charset=utf-8',"import {measure} from '/features.js';measure().then(result=>parent.postMessage(result,location.origin));");
   if(url.pathname==='/favicon.ico')return this.response(204,'image/x-icon','');
   if(url.pathname==='/api/session')return json(200,{account:this.loggedIn&&(headers.cookie??'').split(';').map(value=>value.trim()).includes('mu-lab='+this.cookie)?'synthetic-a':null});
  }
  if(request.method==='POST'&&!url.search&&headers['content-type']?.split(';')[0]==='application/json'){
   const body=JSON.parse(request.postData??'');
   if(url.pathname==='/api/receipts'){if(this.receipt)throw Error('Duplicate local check receipt');this.receipt={id:randomUUID(),probe:windowsCheckProbeSchema.parse(body)};return json(201,{id:this.receipt.id});}
   if(url.pathname==='/api/login'){z.object({account:z.literal('synthetic-a')}).strict().parse(body);this.loggedIn=true;return json(200,{account:'synthetic-a'},[{name:'Set-Cookie',value:'mu-lab='+this.cookie+'; Path=/; HttpOnly; Secure; SameSite=Strict'}]);}
   if(url.pathname==='/v1/messages'){
    if(headers['x-api-key']!==credential||this.syntheticModelCalls!==0)throw Error('Synthetic message request refused');
    z.object({model:z.literal('mu-mock'),stream:z.literal(true),max_tokens:z.literal(128),messages:z.tuple([z.object({role:z.literal('user'),content:z.literal('Hello local test')}).strict()])}).strict().parse(body);
    this.syntheticModelCalls++;
    const events=[{type:'message_start',message:{id:'mu-synthetic',role:'assistant',content:[]}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'MU_LOCAL_TASK_OK'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}];
    return this.response(200,'text/event-stream',events.map(value=>'event: '+value.type+'\ndata: '+JSON.stringify(value)+'\n\n').join(''));
   }
  }
  throw Error('Local check route refused');
 }
}
