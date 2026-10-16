import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { environmentSchema } from '../server/validation.ts';
import { BROWSER_HOME_URL, usesBrowserHome } from '../shared/browser-home.ts';
import { browserHomePath, guestBrowserStartUrl, GUEST_HOME_URL, browserHomeInstallScript } from '../server/browser-startpage.ts';

test('Built-in and legacy start pages resolve only to the fixed guest page; custom URLs survive',()=>{
  assert.equal(environmentSchema.parse({name:'Home'}).browserUrl,BROWSER_HOME_URL);
  assert.equal(guestBrowserStartUrl(BROWSER_HOME_URL),GUEST_HOME_URL);
  assert.equal(guestBrowserStartUrl('https://example.com'),GUEST_HOME_URL);
  assert.equal(guestBrowserStartUrl('https://example.com/docs'),'https://example.com/docs');
  assert.equal(usesBrowserHome('https://home.mucodesandbox.invalid/other'),false);
  for(const url of ['file:///etc/passwd','javascript:alert(1)','data:text/html,X'])assert.throws(()=>environmentSchema.parse({name:'X',browserUrl:url}));
});
test('Guest home publication is rooted and atomic, with no new service or socket',async()=>{
  const script=await browserHomeInstallScript();
  assert.match(script,/O_DIRECTORY \| os\.O_NOFOLLOW/);assert.match(script,/s\.st_uid != 0/);
  assert.match(script,/os\.replace\(temp, 'browser-home\.html'/);
  assert.match(script,/os\.fchmod\(f\.fileno\(\), 0o644\)/);
  assert.doesNotMatch(script,/http\.server|socket|chmod 777/);
});
async function homeHarness(responses:Array<any>){
  const html=await readFile(browserHomePath(),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const elements=new Map<string,any>(),requests:string[]=[],navigation:string[]=[];
  const element=(id:string)=>{if(!elements.has(id)){const e:any={value:'',textContent:'',className:'',disabled:false,listeners:{},addEventListener:(n:string,f:any)=>{e.listeners[n]=f;}};
    Object.defineProperty(e,'innerHTML',{set(){throw new Error('Unsafe HTML rendering');}});elements.set(id,e);}return elements.get(id);};
  const context=vm.createContext({document:{getElementById:element},navigator:{language:'en-US',platform:'Linux'},Intl,Date,URL,AbortSignal,
    location:{assign:(url:string)=>navigation.push(url)},fetch:async(url:string)=>{requests.push(url);const value=responses.shift();if(value instanceof Error)throw value;return {ok:true,json:async()=>value};}});
  vm.runInContext(script,context);await new Promise(resolve=>setImmediate(resolve));
  return {elements,requests,navigation,element,submit:(value:string)=>{element('address').value=value;element('address-form').listeners.submit({preventDefault(){}});}};
}
test('The homepage uses browser receipts and renders provider text without HTML execution',async()=>{
  const h=await homeHarness([{ip:'160.191.52.242',country:'VN',city:'<img src=x onerror=alert(1)>'}]);
  assert.deepEqual(h.requests,['https://ipinfo.io/json']);assert.equal(h.element('ip').textContent,'160.191.52.242');
  assert.match(h.element('location').textContent,/越南/);assert.match(h.element('location').textContent,/<img/);
  assert.equal(h.element('network-state').className,'state ok');assert.equal(h.element('refresh').disabled,false);
  for(const value of ['javascript:alert(1)','file:///etc/passwd','data:text/html,X','https://user:secret@example.com'])h.submit(value);
  assert.deepEqual(h.navigation,[]);assert.ok(h.element('address-error').textContent);
  h.submit('www.wikipedia.org');assert.deepEqual(h.navigation,['https://www.wikipedia.org/']);
});
test('Invalid or failed IP receipts use a bounded fallback and never show detection success',async()=>{
  const h=await homeHarness([{ip:'999.1.1.1'},new Error('offline')]);
  assert.deepEqual(h.requests,['https://ipinfo.io/json','https://api.ipify.org?format=json']);
  assert.equal(h.element('ip').textContent,'暂时无法检测');assert.equal(h.element('network-state').className,'state error');
  assert.equal(h.element('refresh').disabled,false);
});
