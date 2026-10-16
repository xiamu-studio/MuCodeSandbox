import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {GuestLinks} from './guest-links.ts';
import {latencyInput} from './latency.ts';
import { displayRequestSchema } from '../shared/guest-display.ts';
import { Manager } from './manager.ts';
import type { BrowserHost } from './browser.ts';
import { TerminalServer } from './terminal.ts';
import { AppError, errorMessage } from './errors.ts';
import { run } from './process.ts';
import { redact } from './validation.ts';
import { createAcceptanceLab } from './acceptance-lab.ts';
import { LocalChecks } from './local-check.ts';
import { LocalProxy } from './local-proxy.ts';
import { HostBridge } from './host-bridge.ts';
import { GuestBrowserHost } from './guest-browser.ts';
import { GuestAudioHost, createGuestAudioCapture } from './guest-audio.ts';
import { VERSION } from '../shared/version.ts';
import { HOST_COMMANDS } from '../shared/types.ts';
import { createUISession } from './ui-session.ts';
import { backupPasswordSchema, backupPathSchema } from './backups.ts';
import { diskCapacitySchema } from './disk-recovery.ts';
import { HostNetworkMonitor } from './host-network.ts';
import { desktopAppSchema } from './guest-desktop.ts';
import {GuestExchange,inlineTranslationText,clipboardText,transferName,transferZone} from './guest-exchange.ts';
import {TRANSFER_MAX_BYTES} from '../shared/guest-exchange.ts';

export interface ServiceOptions { dataDir?: string; port?: number; rootDir: string; dev?: boolean; browser?: BrowserHost; picker?: () => Promise<string | null>; backupPicker?: (mode: 'open' | 'save') => Promise<string | null> }

function acquireLock(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'service.lock');
  if (existsSync(file)) {
    let stale = false;
    try { const pid = Number(readFileSync(file, 'utf8')); if (!Number.isSafeInteger(pid) || pid < 1) stale = true; else process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') stale = true; else if ((error as NodeJS.ErrnoException).code === 'ENOENT') stale = true; }
    if (!stale) throw new AppError('MuCodeSandbox 已在运行，请使用已打开的窗口', 409, 'ALREADY_RUNNING');
    try { unlinkSync(file); } catch { /* A stale file may already be gone. */ }
  }
  writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  return () => { try { if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file); } catch { /* Cleanup is idempotent. */ } };
}

export async function createService(options: ServiceOptions) {
  const dataDir = path.resolve(options.dataDir ?? process.env.MU_DATA_DIR ?? path.join(homedir(), '.mucodesandbox'));
  const unlock = acquireLock(dataDir);
  const manager = new Manager(dataDir, options.browser);
  try { await manager.backups.cleanupInterrupted(); } catch (error) { await manager.close(); unlock(); throw error; }
  const guestBrowser=new GuestBrowserHost(manager.runtime,manager.browser);
  manager.browser=guestBrowser;
  guestBrowser.authorize=(e,allowBusy)=>manager.assertAccess(e.id,allowBusy);
  const guestLinks=new GuestLinks(manager.runtime,id=>{try{return manager.store.get(id);}catch{return undefined;}},id=>manager.active.has(id),async(e,link)=>{await manager.openExternalLink(e.id,link.url);});
  const guestExchange=new GuestExchange(manager.runtime,async id=>{await manager.assertAccess(id);return manager.store.get(id);});
  guestBrowser.prepareLinks=(e,runOptions)=>guestLinks.prepare(e,runOptions);
  const guestAudio=new GuestAudioHost({
    getSession:id=>guestBrowser.entries.get(id),
    authorize:async session=>{
      await manager.assertAccess(session.environment.id,true);
      if(session.environment.network.strict){
        const protection=await manager.runtime.networkProtection(session.environment);
        if(!protection.active||protection.integrity!=='verified')throw new AppError('音频连接的网络防护未通过核验',409,'GUARD_FAILED');
      }
    },
    capture:session=>createGuestAudioCapture(manager.runtime,session),
  });
  guestBrowser.revokeAudio=id=>guestAudio.revoke(id);
  const localChecks=new LocalChecks(manager,guestBrowser);
  await localChecks.restore();
  const localProxy=new LocalProxy(dataDir);
  const localProxyRestore=await localProxy.restore();
  const application={channel:process.versions.electron?'desktop-test' as const:'source-preview' as const,buildId:'working-tree',builtAt:null as string|null};
  try{
    const info=JSON.parse(await readFile(path.join(options.rootDir,'build-info.json'),'utf8'));
    if(/^[a-f0-9]{8,64}$/.test(info.buildId))application.buildId=info.buildId;
    if(typeof info.builtAt==='string'&&Number.isFinite(Date.parse(info.builtAt)))application.builtAt=info.builtAt;
  }catch{/* Source previews have no frozen build identity. */}
  const app = express();
  app.disable('x-powered-by');
  const token = randomBytes(32).toString('hex');
  const nonce = randomBytes(18).toString('base64');
  const server = createServer(app);
  const terminal = new TerminalServer(manager);
  const bridge = new HostBridge(manager.store, manager.runtime, options.rootDir);
  bridge.authorize=id=>manager.assertAccess(id,true);
  let lab: Awaited<ReturnType<typeof createAcceptanceLab>> | null = null;
  let startingLab: Promise<void> | null = null;
  manager.onQuarantine = async id => { guestAudio.revoke(id);terminal.closeEnvironment(id); await Promise.allSettled([guestBrowser.close(id,false),bridge.revokeEnvironment(id)]); };
  manager.onBeforeStop = id => { guestAudio.revoke(id);return bridge.revokeEnvironment(id); };
  const hostNetwork = process.platform === 'darwin' ? new HostNetworkMonitor(path.join(options.rootDir, 'native/bin/mu-network-monitor'), event => manager.handleHostNetworkEvent(event)) : null;
  if (hostNetwork) { manager.enableHostNetworkMonitor(); await hostNetwork.start(); }
  let port = options.port ?? 4367;
  const origins = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const allowedOrigin = (origin?: string) => !origin || origins().includes(origin);
  const uiSession=createUISession({allowedOrigin});
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (!host || !origins().some(origin => new URL(origin).host === host) || !allowedOrigin(req.headers.origin)) { res.status(403).json({ error: '请求来源无效', code: 'INVALID_ORIGIN' }); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    const scripts = options.dev ? "'self' 'unsafe-inline'" : `'self' 'nonce-${nonce}'`;
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`);
    next();
  });
  app.use(uiSession.middleware);
  app.use('/api', (req, res, next) => {
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { res.status(401).json({ error: '本机会话无效，请刷新页面', code: 'UNAUTHORIZED' }); return; }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  app.get('/api/snapshot', async (_req, res) => {const snapshot=await manager.snapshot();res.json({...snapshot,system:{...snapshot.system,application}});});
  app.get('/api/local-proxy',async(_req,res)=>res.json({...await localProxy.info(),...localProxyRestore}));
  app.post('/api/local-proxy/line',async(req,res)=>{
    const input=z.object({name:z.string().min(1).max(160)}).strict().parse(req.body);
    if(manager.store.list().some(e=>e.state==='running'&&e.network.host==='127.0.0.1'&&e.network.port===24897))throw new AppError('请先停止使用独立线路的环境，再更换节点',409);
    res.json(await localProxy.start(input.name));
  });
  app.get('/api/lab', (_req,res)=>res.json(lab?.info()??{running:false}));
  app.get('/api/lab/checks',(_req,res)=>res.json([...localChecks.reports.values()]));
  app.post('/api/environments/:id/lab/check',(_req,res)=>res.status(202).json(localChecks.start(z.uuid().parse(_req.params.id))));
  app.post('/api/lab/start', async (_req,res)=>{
    if(!lab){startingLab??=(async()=>{lab=await createAcceptanceLab()})().finally(()=>{startingLab=null});await startingLab;}
    res.json(lab!.info());
  });
  app.post('/api/lab/stop', async (_req,res)=>{await startingLab;const current=lab;lab=null;await current?.close();res.json({running:false});});
  app.get('/api/lab/receipts',(_req,res)=>res.json({receipts:lab?.receipts??[],events:lab?.events??[]}));
  app.post('/api/environments', async (req, res) => res.status(201).json(await manager.create(req.body)));
  app.get('/api/environments/:id/bridge', (req,res)=>{const e=manager.store.get(z.uuid().parse(req.params.id));res.json(bridge.list(e.id));});
  app.post('/api/environments/:id/bridge',(req,res)=>{
    const e=manager.store.get(z.uuid().parse(req.params.id));
    const input=z.object({root:z.string().min(1).max(2048),writable:z.boolean().default(false),minutes:z.number().int().min(1).max(480).default(60),commands:z.array(z.enum(HOST_COMMANDS)).max(HOST_COMMANDS.length).default([])}).strict().parse(req.body);
    res.status(202).json(manager.submit(e.id,'bridge-grant',async options=>{await bridge.create(e,input.root,input.writable,input.minutes,true,options,input.commands);}));
  });
  app.delete('/api/environments/:id/bridge/:grantId',(req,res)=>{
    const e=manager.store.get(z.uuid().parse(req.params.id));const id=z.uuid().parse(req.params.grantId);
    if(!bridge.list(e.id).some(g=>g.id===id))throw new AppError('此宿主授权不存在',404);
    res.status(202).json(manager.submit(e.id,'bridge-revoke',()=>bridge.revoke(id)));
  });
  app.get('/api/environments/:id/snapshots', async (req, res) => res.json(await manager.snapshots.list(manager.store.get(z.uuid().parse(req.params.id)))));
  app.post('/api/backups/import', (req, res) => {
    const input = z.object({ path: backupPathSchema, password: backupPasswordSchema, name: z.string().trim().min(1).max(60) }).strict().parse(req.body);
    res.status(202).json(manager.submit(null, 'backup-import', async options => { await manager.backups.import(input.path, input.password, input.name, options); }));
  });
  app.post('/api/environments/:id/snapshots/:snapshotId/export', (req, res) => {
    const e = manager.store.get(z.uuid().parse(req.params.id)); const id = z.uuid().parse(req.params.snapshotId);
    const input = z.object({ path: backupPathSchema, password: backupPasswordSchema }).strict().parse(req.body);
    res.status(202).json(manager.submit(e.id, 'backup-export', options => manager.backups.export(e, id, input.path, input.password, options)));
  });
  app.post('/api/backups/pick', async (req, res) => {
    const { mode } = z.object({ mode: z.enum(['open', 'save']) }).strict().parse(req.body);
    if (options.backupPicker) { res.json({ path: await options.backupPicker(mode) }); return; }
    res.json({ path: null });
  });
  app.post('/api/environments/:id/snapshots', (req, res) => {
    const e = manager.store.get(z.uuid().parse(req.params.id));
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).strict().parse(req.body);
    res.status(202).json(manager.submit(e.id, 'snapshot-create', options => manager.snapshots.create({ ...e, browserRunning: manager.browser.running(e.id) }, name, options)));
  });
  app.post('/api/environments/:id/snapshots/:snapshotId/restore', (req, res) => {
    const e = manager.store.get(z.uuid().parse(req.params.id)); const id = z.uuid().parse(req.params.snapshotId);
    res.status(202).json(manager.submit(e.id, 'snapshot-restore', options => manager.snapshots.restore({ ...e, browserRunning: manager.browser.running(e.id) }, id, options)));
  });
  app.delete('/api/environments/:id/snapshots/:snapshotId', async (req, res) => {
    const e = manager.store.get(z.uuid().parse(req.params.id)); manager.ensureIdle(e.id);
    await manager.snapshots.remove(e, z.uuid().parse(req.params.snapshotId)); res.json({ ok: true });
  });
  app.put('/api/environments/:id', async (req, res) => res.json(await manager.update(z.uuid().parse(req.params.id), req.body)));
  app.get('/api/environments/:id/disk', async (req, res) => res.json(await manager.diskRecovery.status(manager.store.get(z.uuid().parse(req.params.id)))));
  app.post('/api/environments/:id/disk', async (req, res) => {
    const { diskGiB } = z.object({ diskGiB: diskCapacitySchema }).strict().parse(req.body);
    res.status(202).json(await manager.growDisk(z.uuid().parse(req.params.id), diskGiB));
  });
  app.post('/api/environments/:id/actions/:action', async (req, res) => {
    const action = z.enum(['start', 'stop', 'restart', 'delete', 'install-agent', 'prepare-network']).parse(req.params.action);
    const id = z.uuid().parse(req.params.id);
    const job = await manager.lifecycle(id, action);
    if (['stop', 'restart', 'delete', 'prepare-network'].includes(action)) terminal.closeEnvironment(id);
    res.status(202).json(job);
  });
  app.post('/api/environments/:id/browser/open', async (req, res) => {
    const input=z.object({showWindow:z.boolean().optional()}).strict().parse(req.body??{});
    res.status(202).json(await manager.openBrowser(z.uuid().parse(req.params.id),input.showWindow??true));
  });
  app.get('/api/environments/:id/desktop-apps',async(req,res)=>{
    const id=z.uuid().parse(req.params.id);manager.ensureIdle(id);res.json(await manager.desktop.status(manager.store.get(id)));
  });
  app.post('/api/environments/:id/desktop-apps/:application/:action',async(req,res)=>{
    z.object({}).strict().parse(req.body??{});
    res.status(202).json(await manager.desktopAction(z.uuid().parse(req.params.id),desktopAppSchema.parse(req.params.application),z.enum(['install','start','stop']).parse(req.params.action)));
  });
  app.post('/api/environments/:id/rebuild-clean',async(req,res)=>{
    z.object({confirm:z.literal('erase-entire-environment')}).strict().parse(req.body);
    const id=z.uuid().parse(req.params.id);terminal.closeEnvironment(id);res.status(202).json(await manager.cleanRebuild(id));
  });
  app.post('/api/environments/:id/browser/close', async (req, res) => { await manager.closeBrowser(z.uuid().parse(req.params.id)); res.json({ ok: true }); });
  app.get('/api/environments/:id/browser/version',async(req,res)=>{
    const id=z.uuid().parse(req.params.id);manager.ensureIdle(id);
    if(!manager.browser.versionStatus)throw new AppError('当前运行组件不支持版本检测',409);
    res.json(await manager.browser.versionStatus(manager.store.get(id)));
  });
  app.post('/api/environments/:id/browser/:maintenance',async(req,res,next)=>{
    if(req.params.maintenance!=='update'&&req.params.maintenance!=='recover'&&req.params.maintenance!=='reset'){next();return;}
    if(req.params.maintenance==='reset')z.object({confirm:z.literal('erase-browser-profile')}).strict().parse(req.body);
    res.status(202).json(await manager.maintainBrowser(z.uuid().parse(req.params.id),req.params.maintenance));
  });
  app.post('/api/environments/:id/guest-focus',async(req,res)=>{const input=z.object({target:z.enum(['browser','grok-bot','claude-desktop'])}).strict().parse(req.body);res.json(await manager.focusApplication(z.uuid().parse(req.params.id),input.target));});
  app.get('/api/environments/:id/protection-events',(req,res)=>res.json(manager.protectionEvents(z.uuid().parse(req.params.id))));
  app.post('/api/environments/:id/protection-events/retry',async(req,res)=>{
    z.object({}).strict().parse(req.body??{});const id=z.uuid().parse(req.params.id),e=manager.store.get(id);
    if(e.kind!=='vm'||!e.network.strict||!['error','stopped'].includes(e.state))throw new AppError('请在受保护环境停止后重试核验；不会修改批准 IP 或防护配置',409,'RECOVERY_STATE');
    res.status(202).json(await manager.lifecycle(id,'start'));
  });
  app.get('/api/environments/:id/transfer-files',async(req,res)=>{
    const id=z.uuid().parse(req.params.id);
    if(req.query.paged==='1')res.json(await guestExchange.listPage(id,z.string().optional().parse(req.query.cursor)));
    else res.json(await guestExchange.list(id));
  });
  app.post('/api/environments/:id/transfer-files',async(req,_res,next)=>{await manager.assertAccess(z.uuid().parse(req.params.id));next();},express.raw({type:'application/octet-stream',limit:TRANSFER_MAX_BYTES}),async(req,res)=>{
    const name=transferName.parse(req.query.name);if(!Buffer.isBuffer(req.body))throw new AppError('请选择一个文件',400);
    res.json(await guestExchange.upload(z.uuid().parse(req.params.id),name,req.body));
  });
  app.post('/api/environments/:id/transfer-download',async(req,res)=>{
    const input=z.object({zone:transferZone,name:transferName}).strict().parse(req.body);
    const data=await guestExchange.download(z.uuid().parse(req.params.id),input.zone,input.name);
    res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(input.name)}`);res.type('application/octet-stream').send(data);
  });
  app.post('/api/environments/:id/translate-text',async(req,res)=>{
    const id=z.uuid().parse(req.params.id);manager.ensureIdle(id);
    const input=z.object({text:inlineTranslationText}).strict().parse(req.body);
    res.json(await guestExchange.translate(id,input.text));
  });
  app.post('/api/environments/:id/clipboard/read',async(req,res)=>{z.object({}).strict().parse(req.body??{});res.json(await guestExchange.readClipboard(z.uuid().parse(req.params.id)));});
  app.post('/api/environments/:id/clipboard/write',async(req,res)=>{const input=z.object({text:clipboardText}).strict().parse(req.body);res.json(await guestExchange.writeClipboard(z.uuid().parse(req.params.id),input.text));});
  app.get('/api/environments/:id/guest-browser',(req,res)=>{const e=manager.store.get(z.uuid().parse(req.params.id));const active=manager.active.get(e.id),job=active&&manager.store.jobs().find(j=>j.id===active);res.json({...guestBrowser.info(e.id),preparing:!!job&&['open-browser','desktop-start','open-external-link'].includes(job.action)});});
  app.post('/api/environments/:id/guest-browser/translate',async(req,res)=>{
    const id=z.uuid().parse(req.params.id);manager.ensureIdle(id);
    const input=z.object({text:z.string().max(5000).refine(text=>!text.includes('\0'))}).strict().parse(req.body);
    await manager.assertAccess(id);
    res.json(await guestBrowser.openTranslation(manager.store.get(id),input.text));
  });
  app.post('/api/environments/:id/guest-browser/display',async(req,res)=>{const id=z.uuid().parse(req.params.id);manager.ensureIdle(id);manager.store.get(id);res.json(await guestBrowser.resize(id,displayRequestSchema.parse(req.body)));});
  app.post('/api/environments/:id/guest-browser-ticket',async(req,res)=>{
    const id=z.uuid().parse(req.params.id);const e=manager.store.get(id);
    if(e.kind!=='vm'||e.state!=='running')throw new AppError('请先启动 Linux 环境',409);
    await manager.assertAccess(id,true);
    res.json(guestBrowser.issue(id));
  });
  app.post('/api/environments/:id/guest-audio-ticket',async(req,res)=>{
    z.object({}).strict().parse(req.body??{});
    const id=z.uuid().parse(req.params.id);manager.ensureIdle(id);manager.store.get(id);
    const ticket=await guestAudio.issue(id);manager.ensureIdle(id);res.json(ticket);
  });
  app.post('/api/environments/:id/network/test', async (req, res) => res.json(await manager.testNetwork(z.uuid().parse(req.params.id))));
  app.get('/api/environments/:id/network/latency',(req,res)=>res.json(manager.accessLatency(z.uuid().parse(req.params.id))));
  app.post('/api/environments/:id/network/latency',async(req,res)=>{const input=latencyInput.parse(req.body??{});res.json(await manager.testAccessLatency(z.uuid().parse(req.params.id),input.target));});
  app.get('/api/environments/:id/network/observations', (req,res)=>res.json(manager.networkObserver.info(manager.store.get(z.uuid().parse(req.params.id)))));
  app.post('/api/environments/:id/network/observations', async (req,res)=>{z.object({}).strict().parse(req.body);res.json(await manager.sampleNetwork(z.uuid().parse(req.params.id)));});
  app.get('/api/environments/:id/network/egress',(req,res)=>res.json(manager.egressStatus(z.uuid().parse(req.params.id))));
  app.get('/api/environments/:id/network/protection', async (req, res) => {
    const e = manager.store.get(z.uuid().parse(req.params.id));
    if (e.kind !== 'vm') throw new AppError('客体防火墙只适用于 Linux 环境', 409);
    res.json(await manager.runtime.networkProtection(e));
  });
  app.get('/api/environments/:id/browser/inspect', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    manager.store.get(id);
    if (!manager.browser.inspect || !manager.browser.running(id)) throw new AppError('请先在桌面版打开这个浏览器', 409);
    res.json(await manager.browser.inspect(id));
  });
  app.get('/api/environments/:id/metrics', async (req, res) => res.json(await manager.runtime.metrics(manager.store.get(z.uuid().parse(req.params.id)))));
  app.get('/api/environments/:id/agent', async (req, res) => res.json(await manager.runtime.agentStatus(manager.store.get(z.uuid().parse(req.params.id)))));
  app.get('/api/logs', (req, res) => {
    const id = req.query.environmentId ? z.uuid().parse(req.query.environmentId) : null;
    const after = z.coerce.number().int().min(0).parse(req.query.after ?? 0);
    res.json(manager.store.logs(id, after));
  });
  app.post('/api/jobs/:id/cancel', (req, res) => { manager.cancel(z.uuid().parse(req.params.id)); res.json({ ok: true }); });
  app.post('/api/runtime/install', (_req, res) => {
    if (manager.store.list().some(e => e.kind === 'vm' && e.state === 'running')) throw new AppError('请先停止所有 Linux 环境再安装运行组件', 409);
    res.status(202).json(manager.submit(null, 'install-runtime', options => manager.runtime.install(options)));
  });
  app.post('/api/directories/pick', async (_req, res) => {
    if (options.picker) { res.json({ path: await options.picker() }); return; }
    try {
      const folder = await run('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "选择 MuCodeSandbox 项目目录")'], { timeoutMs: 120_000 });
      res.json({ path: folder.trim().replace(/\/$/, '') });
    } catch (error) { if (errorMessage(error).includes('(-128)')) res.json({ path: null }); else throw error; }
  });
  app.post('/api/environments/:id/terminal-ticket', async (req, res) => {
    const input = z.object({ command: z.enum(['shell', 'claude']).default('shell'), cols: z.number().int().min(20).max(300).default(100), rows: z.number().int().min(5).max(100).default(28) }).strict().parse(req.body);
    const id = z.uuid().parse(req.params.id);
    manager.ensureIdle(id);
    const e = manager.store.get(id);
    await manager.assertAccess(id);
    manager.ensureIdle(id);
    await guestLinks.prepare(e);
    manager.ensureIdle(id);await manager.assertAccess(id);
    res.json({ ticket: terminal.issue(id, input.command, input.cols, input.rows) });
  });
  server.on('upgrade', (req, socket, head) => {
    if(closing){socket.destroy();return;}
    if(!req.headers.host||!origins().some(origin=>new URL(origin).host===req.headers.host)){socket.destroy();return;}
    const url=new URL(req.url??'/','http://127.0.0.1');
    if(url.pathname==='/guest-browser'){void guestBrowser.upgrade(req,socket,head,request=>!!request.headers.host&&origins().some(origin=>new URL(origin).host===request.headers.host)&&!!request.headers.origin&&allowedOrigin(request.headers.origin)).catch(()=>socket.destroy());return;}
    if(url.pathname==='/guest-audio'){void guestAudio.upgrade(req,socket,head,request=>!!request.headers.host&&origins().some(origin=>new URL(origin).host===request.headers.host)&&!!request.headers.origin&&allowedOrigin(request.headers.origin)).catch(()=>socket.destroy());return;}
    void terminal.upgrade(req, socket, head, allowedOrigin).catch(() => socket.destroy());
  });
  const bootstrap = `<script nonce="${nonce}">window.__MU_CONFIG__=${JSON.stringify({ token, version: VERSION })};</script>`;
  if (options.dev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ root: options.rootDir, server: { middlewareMode: true }, appType: 'custom' });
    app.use(vite.middlewares);
    app.get('/', async (_req, res) => res.type('html').send(await vite.transformIndexHtml('/', (await readFile(path.join(options.rootDir, 'index.html'), 'utf8')).replace('<!-- MU_BOOTSTRAP -->', bootstrap))));
    server.on('close', () => void vite.close());
  } else {
    app.get('/', async (_req, res) => {
      if (!existsSync(path.join(options.rootDir, 'dist/index.html'))) throw new AppError('请先构建界面：npm run build', 503);
      const html = await readFile(path.join(options.rootDir, 'dist/index.html'), 'utf8');
      res.type('html').send(html.replace('<!-- MU_BOOTSTRAP -->', bootstrap));
    });
    app.use(express.static(path.join(options.rootDir, 'dist'), { index: false, dotfiles: 'deny' }));
  }
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；'), code: 'VALIDATION_ERROR' });
    else if(error&&typeof error==='object'&&'type' in error&&error.type==='entity.too.large')res.status(413).json({error:'请求内容过大；文件最多25 MiB，文字最多64 KiB',code:'CONTENT_TOO_LARGE'});
    else if (error instanceof AppError) res.status(error.status).json({ error: redact(error.message), code: error.code });
    else res.status(500).json({ error: redact(errorMessage(error)), code: 'INTERNAL_ERROR' });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
    const address = server.address();
    if (typeof address === 'object' && address) port = address.port;
  } catch (error) { await hostNetwork?.close(); await guestAudio.dispose();await bridge.close(); await manager.close(); unlock(); throw error; }
  let closing: Promise<void> | null = null;
  const close = () => closing ??= (async () => {
    await guestLinks.close();
    await hostNetwork?.close();
    await startingLab;
    await lab?.close();lab=null;
    terminal.close();
    await guestAudio.dispose();
    await bridge.close();
    // Upgraded viewer sockets are closed by manager.close(); waiting for them first deadlocks shutdown.
    const serverClosed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    try { await manager.close(); }
    finally { await localProxy.close();await serverClosed; unlock(); }
  })();
  const url=`http://127.0.0.1:${port}`;
  const launchUrl=(pathname='/')=>uiSession.launchUrl(url,pathname);
  guestBrowser.onOpen=e=>options.browser?.openGuest?.(e,launchUrl(`/?guestBrowser=${e.id}`))??Promise.resolve();
  guestBrowser.onClose=id=>options.browser?.closeGuest?.(id)??Promise.resolve();
  return { app, server, manager, guestLinks, terminal, bridge, guestBrowser, guestAudio, hostNetwork, token, port, url, launchUrl, close };
}
