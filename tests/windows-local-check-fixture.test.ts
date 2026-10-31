import {test} from 'node:test';import assert from 'node:assert/strict';
import {WindowsLocalCheckFixture,WINDOWS_CHECK_ORIGIN} from '../server/platform/windows/local-check-fixture.ts';import {syntheticBrowserCheck} from './fixtures/windows-local-check-data.ts';
test('Local fixture routes accept only bounded synthetic browser records and the one mock message request',()=>{
 const fixture=new WindowsLocalCheckFixture(),get=(path:string)=>fixture.handle({url:WINDOWS_CHECK_ORIGIN+path,method:'GET',headers:{}}),post=(path:string,body:unknown,headers={})=>fixture.handle({url:WINDOWS_CHECK_ORIGIN+path,method:'POST',headers:{'content-type':'application/json',...headers},postData:JSON.stringify(body)});
 assert.equal(fixture.handle({url:fixture.url,method:'GET',headers:{}}).status,200);
 for(const path of ['/features.js','/probe.js','/frame','/frame.js'])assert.equal(get(path).status,200);
 assert.ok(JSON.parse(post('/api/receipts',syntheticBrowserCheck().probe).body).id);assert.throws(()=>post('/api/receipts',syntheticBrowserCheck().probe));
 const login=post('/api/login',{account:'synthetic-a'});assert.ok(login.headers.find(value=>value.name==='Set-Cookie')!.value.includes('Secure; SameSite=Strict'));
 assert.equal(JSON.parse(get('/api/session').body).account,null);assert.equal(JSON.parse(fixture.handle({url:WINDOWS_CHECK_ORIGIN+'/api/session',method:'GET',headers:{cookie:'mu-lab='+fixture.cookie}}).body).account,'synthetic-a');
 const response=post('/v1/messages',{model:'mu-mock',stream:true,max_tokens:128,messages:[{role:'user',content:'Hello local test'}]},{'x-api-key':'mu-windows-local-synthetic-only'});assert.equal(response.status,200);assert.ok(response.body.includes('"type":"message_stop"'));assert.equal(fixture.syntheticModelCalls,1);
});
test('Unknown origins, real credentials/prompts, replayed calls and oversized bodies never route to a service',()=>{
 const attempts=[
 {url:'https://external.invalid/'},{url:'http://mucodesandbox-check.invalid/'},{url:'https://user:secret@mucodesandbox-check.invalid/'},{url:WINDOWS_CHECK_ORIGIN+'/unknown'},{url:WINDOWS_CHECK_ORIGIN+'/features.js?unknown=1'},
 {url:WINDOWS_CHECK_ORIGIN+'/api/login',method:'POST',postData:JSON.stringify({account:'actual-person'})},
 {url:WINDOWS_CHECK_ORIGIN+'/api/receipts',method:'POST',postData:'x'.repeat(98305)},
 {url:WINDOWS_CHECK_ORIGIN+'/v1/messages',method:'POST',postData:JSON.stringify({model:'actual-provider-model',stream:true,messages:[]})},
 ];
 for(const attempt of attempts){const fixture=new WindowsLocalCheckFixture();assert.throws(()=>fixture.handle({method:'GET',headers:{'content-type':'application/json'},...attempt}));assert.equal(fixture.syntheticModelCalls,0);assert.equal(fixture.receipt,undefined);}
 const bounded=new WindowsLocalCheckFixture();for(let index=0;index<64;index++)bounded.handle({url:WINDOWS_CHECK_ORIGIN+'/favicon.ico',method:'GET',headers:{}});assert.throws(()=>bounded.handle({url:bounded.url,method:'GET',headers:{}}),/budget/);
});
