import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,mkdtemp,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {BROWSER_HOME_URL} from '../shared/browser-home.ts';
import {windowsBrowserStartPage,WINDOWS_BLANK_PAGE_URL} from '../shared/windows-browser-start.ts';
import {windowsBrowserStartupPlan,applyWindowsBrowserStartup,prepareWindowsBrowserHome,type WindowsBrowserStartupActions} from '../server/platform/windows/browser-startup.ts';
import {browserHomePath,GUEST_HOME_URL} from '../server/browser-startpage.ts';
import {copyWindowsBrowserHome} from '../scripts/windows/package-runtime.ts';
import {startWindowsChrome} from '../server/platform/windows/browser-guest.ts';
import type {Environment} from '../shared/types.ts';

test('Windows startup choices map reserved URLs locally while preserving valid custom URLs',()=>{
 assert.deepEqual(windowsBrowserStartPage(WINDOWS_BLANK_PAGE_URL),{kind:'blank',url:WINDOWS_BLANK_PAGE_URL});assert.equal(windowsBrowserStartPage('about:blank').kind,'blank');assert.equal(windowsBrowserStartPage(BROWSER_HOME_URL).kind,'home');assert.equal(windowsBrowserStartPage('https://example.com').kind,'home');assert.deepEqual(windowsBrowserStartPage('https://docs.example/path?q=中文'),{kind:'url',url:'https://docs.example/path?q=%E4%B8%AD%E6%96%87'});
 for(const value of [undefined,'file:///etc/passwd','javascript:alert(1)','data:text/html,X','https://user:password@docs.example/','https://docs.example/'+'a'.repeat(2048)])assert.throws(()=>windowsBrowserStartPage(value));
 assert.throws(()=>windowsBrowserStartPage('https://docs.example/'+'中'.repeat(300)),/2048/);
});
test('Legacy browser-open calls remain blank without using their saved URL',()=>{
 for(const input of [BROWSER_HOME_URL,'https://docs.example/','javascript:unsafe',undefined])assert.deepEqual(windowsBrowserStartupPlan(input),{kind:'blank',url:'about:blank'});
 assert.deepEqual(windowsBrowserStartupPlan(BROWSER_HOME_URL,'configured'),{kind:'home',url:GUEST_HOME_URL});assert.deepEqual(windowsBrowserStartupPlan(WINDOWS_BLANK_PAGE_URL,'configured'),{kind:'blank',url:'about:blank'});
 assert.throws(()=>windowsBrowserStartupPlan('file:///etc/passwd','configured'),{code:'BROWSER_STARTUP_INVALID'});
});
function fixture(){const calls:string[]=[],control=new AbortController();let current=true;const actions:WindowsBrowserStartupActions={signal:control.signal,assertCurrent:()=>{if(!current)throw Error('Old browser session');},verifyProtection:async()=>{calls.push('guard');},prepareHome:async()=>{calls.push('prepare');return 'fixed-root-home-script';},installHome:async script=>{assert.equal(script,'fixed-root-home-script');calls.push('install');},navigate:async url=>{calls.push('navigate:'+url);}};return {calls,control,actions,retire:()=>{current=false;}};}
test('Configured home publication and navigation wait for protection checks; blank does neither',async()=>{
 const f=fixture();await applyWindowsBrowserStartup(windowsBrowserStartupPlan(BROWSER_HOME_URL,'configured'),f.actions);assert.deepEqual(f.calls,['prepare','guard','install','guard','navigate:'+GUEST_HOME_URL,'guard']);
 const blank=fixture();await applyWindowsBrowserStartup(windowsBrowserStartupPlan(BROWSER_HOME_URL),blank.actions);assert.deepEqual(blank.calls,[]);
});
test('Custom URL navigation never enters a guest shell or publishes homepage contents',async()=>{
 const f=fixture(),plan=windowsBrowserStartupPlan("https://docs.example/$(echo-test)?q='value'",'configured');await applyWindowsBrowserStartup(plan,f.actions);assert.deepEqual(f.calls,['guard','navigate:'+plan.url,'guard']);assert.equal(f.calls.includes('install'),false);
});
test('Guard rejection after local preparation prevents guest publication and navigation',async()=>{
 const f=fixture();f.actions.verifyProtection=async()=>{throw Error('Guard denied');};await assert.rejects(applyWindowsBrowserStartup(windowsBrowserStartupPlan(BROWSER_HOME_URL,'configured'),f.actions),/Guard denied/);assert.deepEqual(f.calls,['prepare']);
});
test('Retirement during local homepage preparation prevents any guest publication',async()=>{
 const f=fixture();let release!:(script:string)=>void;f.actions.prepareHome=async()=>new Promise(resolve=>{release=resolve;});const pending=applyWindowsBrowserStartup(windowsBrowserStartupPlan(BROWSER_HOME_URL,'configured'),f.actions);while(!release)await new Promise(resolve=>setImmediate(resolve));f.retire();release('fixed-root-home-script');await assert.rejects(pending,/Old browser session/);assert.deepEqual(f.calls,[]);
});
test('Retirement or cancellation after home publication cannot navigate a replacement browser',async()=>{
 for(const cancel of [false,true]){const f=fixture();f.actions.installHome=async()=>{f.calls.push('install');if(cancel)f.control.abort();else f.retire();};await assert.rejects(applyWindowsBrowserStartup(windowsBrowserStartupPlan(BROWSER_HOME_URL,'configured'),f.actions));assert.equal(f.calls.some(call=>call.startsWith('navigate:')),false);}
});
test('A lost navigation reply or revoked guard cannot be reported as successful startup',async()=>{
 for(const phase of ['reply','guard']){const f=fixture();if(phase==='reply')f.actions.navigate=async()=>{throw Error('Navigation reply lost');};else f.actions.navigate=async()=>{f.retire();};await assert.rejects(applyWindowsBrowserStartup(windowsBrowserStartupPlan('https://docs.example/','configured'),f.actions));}
});
test('A CDP navigation error or download reply cannot be reported as an opened startup page',async()=>{
 for(const reply of [{errorText:'net::ERR_CONNECTION_CLOSED PRIVATE_URL'},{isDownload:true}]){const f=fixture();f.actions.navigate=async()=>reply;await assert.rejects(applyWindowsBrowserStartup(windowsBrowserStartupPlan('https://docs.example/','configured'),f.actions),{code:'BROWSER_STARTUP_FAILED'});assert.deepEqual(f.calls,['guard']);}
});
test('The actual Chrome launch script remains blank even with a configured website',()=>{
 const script=startWindowsChrome({identity:{locale:'en-US',timezone:'UTC'},browserUrl:'https://docs.example/private-start'} as Environment);assert.match(script,/'about:blank'/);assert.equal(script.includes('docs.example'),false);
});
test('Windows homepage installation uses the shared fixed-path atomic publisher and exact asset',async()=>{
 const script=await prepareWindowsBrowserHome(),encoded=script.match(/base64\.b64decode\('([^']+)'/)![1];assert.deepEqual(Buffer.from(encoded,'base64'),await readFile(browserHomePath()));assert.match(script,/O_DIRECTORY \| os\.O_NOFOLLOW/);assert.match(script,/s\.st_uid != 0/);assert.match(script,/os\.replace\(temp, 'browser-home\.html'/);assert.doesNotMatch(script,/http\.server|socket\.bind|chmod 777/);
});
test('Windows homepage reuses only exact protected contents and otherwise publishes atomically',async()=>{
 const result=spawnSync('python',['tests/fixtures/windows-browser-home-reuse.py'],{input:JSON.stringify({script:await prepareWindowsBrowserHome(),content:(await readFile(browserHomePath())).toString('base64')}),encoding:'utf8'});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
});
test('Windows packaging copies a homepage readable by the actual compiled server layout',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'mu-windows-home-layout-'));try{await mkdir(path.join(root,'desktop'));await mkdir(path.join(root,'dist-server/server'),{recursive:true});await mkdir(path.join(root,'dist-server/shared'),{recursive:true});await writeFile(path.join(root,'package.json'),'{"type":"module"}');await copyWindowsBrowserHome(root);await copyFile('dist-server/server/browser-startpage.js',path.join(root,'dist-server/server/browser-startpage.js'));await copyFile('dist-server/shared/browser-home.js',path.join(root,'dist-server/shared/browser-home.js'));const packaged=await import(pathToFileURL(path.join(root,'dist-server/server/browser-startpage.js')).href);assert.equal(packaged.browserHomePath(),path.join(root,'desktop/browser-home.html'));const script=await packaged.browserHomeInstallScript(),encoded=script.match(/base64\.b64decode\('([^']+)'/)![1];assert.deepEqual(Buffer.from(encoded,'base64'),await readFile(browserHomePath()));}finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
