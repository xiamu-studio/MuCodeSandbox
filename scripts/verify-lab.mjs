import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import dns from 'dns2';
import stun from 'stun';
import { createAcceptanceLab } from '../dist-server/server/acceptance-lab.js';

const root=path.resolve(import.meta.dirname,'..');
const lab=await createAcceptanceLab();
const info=lab.info();
const temporary=await mkdtemp(path.join(homedir(),'.mu-lab-'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const report={passed:false,accountFree:true,paidModelCalls:0};
try {
  const answer=await dns.UDPClient({dns:'127.0.0.1',port:info.dnsPort})('positive-control.test');
  assert.equal(answer.answers[0].address,'198.51.100.99');report.dnsPositiveControl=true;
  const binding=await stun.request(`127.0.0.1:${info.stunPort}`);
  assert.equal(binding.getXorAddress().address,'127.0.0.1');report.stunPositiveControl=true;
  const a=await browser.newContext({locale:'en-US',timezoneId:'America/New_York',viewport:{width:1440,height:960}});
  const b=await browser.newContext({locale:'ja-JP',timezoneId:'Asia/Tokyo',viewport:{width:390,height:844}});
  const first=await a.newPage();const second=await b.newPage();
  report.measurements=[];
  for(const [page,locale,timezone] of [[first,'en-US','America/New_York'],[second,'ja-JP','Asia/Tokyo']]){
    await page.goto(info.url);
    await page.waitForFunction(()=>window.__MU_PROBE__||window.__MU_PROBE_ERROR__);
    const result=await page.evaluate(()=>({result:window.__MU_PROBE__,error:window.__MU_PROBE_ERROR__}));
    assert.equal(result.error,undefined,result.error);
    assert.equal(result.result.page.timezone,timezone);
    assert.equal(result.result.page.language,locale);
    report.measurements.push(result.result);
    const keys=['timezone','locale','language','languages','platform','userAgent','hardwareConcurrency','deviceMemoryGiB','clientHints','canvasHash','gpu'];
    assert.deepEqual(result.result.mismatches,keys.filter(key=>[result.result.worker,result.result.frame].some(context=>JSON.stringify(context[key])!==JSON.stringify(result.result.page[key]))));
    assert.match(result.result.page.canvasHash,/^[a-f0-9]{64}$/);
    assert.ok(result.result.headers.acceptLanguage.startsWith(locale));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  report.crossContextDetectorVerified=true;
  report.testBrowserConsistent=report.measurements.every(result=>result.mismatches.length===0);
  report.headersAndCanvasMeasured=true;
  const stb=lab.events.filter(e=>e.kind==='stun').length;
  assert.ok(stb>1);report.browserActuallyContactedStun=true;
  await first.getByRole('button',{name:'模拟登录'}).click();
  await first.getByText('synthetic-a',{exact:true}).waitFor();
  assert.equal(await second.evaluate(async()=> (await(await fetch('/api/session')).json()).account),null);
  await a.close();
  const clean=await browser.newContext();const fresh=await clean.newPage();await fresh.goto(info.url);
  assert.equal(await fresh.evaluate(async()=> (await(await fetch('/api/session')).json()).account),null);
  report.syntheticLoginIsolated=true;
  const completion=await fetch(`${info.url}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Write synthetic output'}]})}).then(r=>r.json());
  const task=JSON.parse(completion.choices[0].message.tool_calls[0].function.arguments);
  assert.equal(task.path,'result.txt');
  await writeFile(path.join(temporary,task.path),task.content);
  const stream=await fetch(`${info.url}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stream:true,messages:[]})});
  assert.equal(stream.headers.get('x-mu-mock'),'true');assert.match(await stream.text(),/data: \[DONE\]/);
  assert.equal(lab.info().modelCalls,2);report.mockToolTaskAndStream=true;
  assert.equal((await fetch(`${info.url}/api/login`,{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:JSON.stringify({account:'synthetic-a'})})).status,403);
  assert.equal((await fetch(`${info.url}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:'real-account',password:'must-not-be-used'})})).status,400);
  report.foreignOriginAndRealCredentialsRejected=true;
  await mkdir(path.join(root,'test-results'),{recursive:true});
  await second.screenshot({path:path.join(root,'test-results/lab-mobile.png'),fullPage:true});
  report.receipts=lab.receipts;
  report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{await browser.close();await lab.close();await rm(temporary,{recursive:true,force:true});await mkdir(path.join(root,'test-results'),{recursive:true});await writeFile(path.join(root,'test-results/account-free-lab.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,receipts:undefined,measurements:report.measurements?.map(r=>({mismatches:r.mismatches}))},null,2));}
