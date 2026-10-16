import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createSocket } from 'node:dgram';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runManagedMac } from '../server/mac-policy.ts';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(homedir(), '.mu-mac-browser-'));
let proxyHits = 0, udpHits = 0;
const target = createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>MU_BROWSER_FIXTURE</title><body>Fixture</body>');});
await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));
const targetPort=(target.address() as {port:number}).port;
const proxy=createServer((req,res)=>{proxyHits++;const remote=request(`http://127.0.0.1:${targetPort}/`,response=>response.pipe(res));remote.on('error',()=>res.end());req.pipe(remote);});
await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const proxyPort=(proxy.address() as {port:number}).port;
const udp=createSocket('udp4');udp.on('message',()=>udpHits++);await new Promise<void>(resolve=>udp.bind(0,'127.0.0.1',resolve));
const udpPort=udp.address().port;
const report:Record<string,unknown>={passed:false,experimental:true,accountFree:true};
try {
  const output=await runManagedMac([{address:'127.0.0.1',port:proxyPort}],require('electron'),[path.join(root,'scripts/mac-browser-fixture.cjs')],{timeoutMs:25_000,env:{...process.env,MU_MAC_BROWSER_FIXTURE:JSON.stringify({dataDir:temporary,proxyPort,targetPort,udpPort})}});
  const line=output.split('\n').find(l=>l.startsWith('MU_BROWSER_RESULT='));assert.ok(line,output);
  const result=JSON.parse(line.slice('MU_BROWSER_RESULT='.length));
  assert.equal(result.title,'MU_BROWSER_FIXTURE');assert.equal(result.rendererSandbox,true);assert.equal(result.canvas,true);assert.ok(result.worker.language);assert.ok(proxyHits>0);assert.equal(udpHits,0);
  report.actualSandboxedChromium=result;report.proxyUsed=true;report.stunPacketsBlocked=true;report.passed=true;
} catch(error){report.error=(error as Error).message;process.exitCode=1;}
finally { target.closeAllConnections();proxy.closeAllConnections();await new Promise<void>(resolve=>target.close(()=>resolve()));await new Promise<void>(resolve=>proxy.close(()=>resolve()));await new Promise<void>(resolve=>udp.close(()=>resolve()));await rm(temporary,{recursive:true,force:true});await mkdir(path.join(root,'test-results'),{recursive:true});await writeFile(path.join(root,'test-results/mac-browser.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2)); }
