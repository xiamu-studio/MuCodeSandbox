import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createService } from '../server/service.ts';
import { CONTEXT_ORIGIN } from './browser-context-fixture.ts';
import { BROWSER_PROCESS_INSPECTION } from './browser-media-fixture.ts';
import type { Job } from '../shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const hostOnly = process.argv.includes('--host-only');
const worker = `self.onmessage=async event=>{try{
 const family='MuDiagnostic_'+crypto.randomUUID().replaceAll('-',''),text='iii WWW MuCodeSandbox 123 ABC';
 const canvas=new OffscreenCanvas(600,80),context=canvas.getContext('2d');
 const font='24px "'+family+'", monospace';
 const width=()=>{context.font=font;return context.measureText(text).width;};
 const before=width(),face=new FontFace(family,'url('+event.data.url+')');self.fonts.add(face);await face.load();
 const immediately=width();
 context.font='25px monospace';const afterReset=width();
 const fresh=new OffscreenCanvas(600,80).getContext('2d');fresh.font=font;const newCanvas=fresh.measureText(text).width;
 await self.fonts.load(font,text);const afterSetLoad=width();
 await new Promise(resolve=>setTimeout(resolve,100));const afterTurn=width();
 self.fonts.delete(face);self.fonts.add(face);const afterReadd=width();
 const other=family+'After',loaded=new FontFace(other,'url('+event.data.url+')');await loaded.load();self.fonts.add(loaded);
 const later=new OffscreenCanvas(600,80).getContext('2d');later.font='24px "'+other+'", monospace';const addedAfterLoad=later.measureText(text).width;
 self.postMessage({before,immediately,afterReset,newCanvas,afterSetLoad,afterTurn,afterReadd,addedAfterLoad,status:face.status,font:context.font});
}catch(error){self.postMessage({error:String(error)});}};`;
const expression = (origin: string) => `new Promise((resolve,reject)=>{
 const worker=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}],{type:'text/javascript'})));
 const timer=setTimeout(()=>{worker.terminate();reject(Error('Worker font diagnosis timed out'));},10000);
 worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data);};worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(Error(event.message));};
 worker.postMessage({url:${JSON.stringify(`${origin}/font.ttf`)}});
})`;
const report: Record<string, any> = { passed: false, startedAt: new Date().toISOString(), accountFree: true, paidModelCalls: 0 };
let service: Awaited<ReturnType<typeof createService>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const server = createServer(async (request, response) => {
  if (request.url === '/font.ttf') {
    try { response.setHeader('Content-Type', 'font/ttf'); response.end(await readFile('/System/Library/Fonts/Supplemental/Arial.ttf')); }
    catch { response.writeHead(404); response.end(); }
  } else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Owned worker font diagnostic</title>'); }
});
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage(); await page.goto(origin);
  report.hostBaseline = { browserVersion: browser.version(), result: await page.evaluate(expression(origin)) };
  assert.equal(report.hostBaseline.result.error, undefined);
  assert.notEqual(report.hostBaseline.result.before, report.hostBaseline.result.addedAfterLoad);
  report.hostBaseline.lateFontCacheObserved = report.hostBaseline.result.before === report.hostBaseline.result.immediately;
  await browser.close(); browser = undefined;
  if (!hostOnly) {
  const dataDir = process.argv.find(value => value.startsWith('--data-dir='))?.slice(11);
  assert.ok(dataDir, 'Supply --data-dir with a stopped retained browser fixture, or use --host-only');
  assert.ok(path.dirname(dataDir) === homedir() && /^\.mu-context-verification-[A-Za-z0-9]+$/.test(path.basename(dataDir)));
  await access(path.join(dataDir, 'state.sqlite'));
  process.env.MU_LIMA_PATH ??= path.join(homedir(), '.mucodesandbox/tools/lima/bin/limactl');
  service = await createService({ rootDir: root, dataDir, port: 0 });
  const manager = service.manager;
  const id = process.argv.find(value => value.startsWith('--environment-id='))?.slice(17);
  const environment = id ? manager.store.get(id) : manager.store.list().find(value => value.name === 'Browser contexts A'); assert.ok(environment);
  const finish = async (job: Job) => { await manager.tasks.get(job.id)?.promise; assert.equal(manager.store.jobs().find(entry => entry.id === job.id)?.status, 'succeeded'); };
  await finish(await manager.lifecycle(environment.id, 'start'));
  await finish(await manager.openBrowser(environment.id));
  const entry = service.guestBrowser.entries.get(environment.id)!; assert.ok(entry?.ready && entry.tools);
  const targets = (await entry.tools.send('Target.getTargets')).targetInfos;
  const target = targets.find((value: any) => value.type === 'page' && value.url.startsWith(CONTEXT_ORIGIN));
  const session = entry.sessions.get(target.targetId); assert.ok(session);
  const result = await entry.tools.send('Runtime.evaluate', { expression: expression(CONTEXT_ORIGIN), awaitPromise: true, returnByValue: true }, session);
  assert.equal(result.exceptionDetails, undefined);
  report.guest = result.result.value; assert.equal(report.guest.error, undefined);
  report.gpuDiagnostics = await entry.tools.send('SystemInfo.getInfo');
  report.processSecurity = JSON.parse((await manager.runtime.management(manager.store.get(environment.id), ['sudo', 'python3', '-'], { input: BROWSER_PROCESS_INSPECTION, timeoutMs: 10_000 })).trim());
  report.processMetadata = JSON.parse((await manager.runtime.management(manager.store.get(environment.id), ['sudo', 'python3', '-'], { timeoutMs: 10_000, input: `import pathlib,json
rows=[]
for process in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  raw=process.joinpath('cmdline').read_bytes()
  if b'--type=renderer' not in raw and b'--type=gpu-process' not in raw:continue
  args=raw.split(bytes([0]))
  rows.append(dict(pid=int(process.name),executable=process.joinpath('exe').readlink().as_posix(),firstArgument=args[0].decode(),argumentCount=len(args),arguments=[arg.decode() for arg in args[1:4]]))
 except (FileNotFoundError,ProcessLookupError):pass
print(json.dumps(rows))
` })).trim());
  report.guestCommands = (await manager.runtime.management(manager.store.get(environment.id), ['bash', '-c', 'ps -eo args | sed -n "/[c]hrome.*--type=gpu-process/p"'], { timeoutMs: 10_000 })).trim();
  await manager.closeBrowser(environment.id); await finish(await manager.lifecycle(environment.id, 'stop'));
  }
  report.passed = true;
} catch (error) { report.error = (error as Error).stack; process.exitCode = 1; }
finally {
  await browser?.close();
  if (service) {
    for (const instance of await service.manager.runtime.list()) if (instance.status === 'Running') await service.manager.runtime.command(['stop', '--force', instance.name], { timeoutMs: 60_000 });
    await service.close();
  }
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'test-results', hostOnly ? 'worker-font-host-diagnosis.json' : 'worker-font-diagnosis.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, hostBaseline: report.hostBaseline, guest: report.guest, gpuFeatureStatus: report.gpuDiagnostics?.gpu?.featureStatus, gpuAuxAttributes: report.gpuDiagnostics?.gpu?.auxAttributes, error: report.error }, null, 2));
}
