import type {GuestWindowTarget} from './guest-window.ts';
import {parseGuestLink} from './guest-links.ts';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { cpus, totalmem, freemem, hostname } from 'node:os';
import path from 'node:path';
import type { Environment, Job, Snapshot, NetworkResult, EgressStatus } from '../shared/types.ts';
import { Store } from './store.ts';
import { LimaRuntime } from './runtime.ts';
import type { BrowserHost } from './browser.ts';
import { ChromeHost } from './browser.ts';
import { environmentSchema, validateMounts, proxyUrl, redact } from './validation.ts';
import { AppError, errorMessage } from './errors.ts';
import { run } from './process.ts';
import type { RunOptions } from './process.ts';
import { checkResources, checkHostPorts } from './resource-budget.ts';
import { Snapshots } from './snapshots.ts';
import { Backups } from './backups.ts';
import { DiskRecovery, diskCapacitySchema } from './disk-recovery.ts';
import { readImportSeed } from './import-seed.ts';
import { VERSION } from '../shared/version.ts';
import { EgressMismatchError,egressErrorChecks, measureEgress, parseEgress } from './egress.ts';
import {protectionKind,type ProtectionEvent,type ProtectionResolution} from '../shared/protection-events.ts';
import { NetworkObserver } from './network-observations.ts';
import type { ProbeProvider } from '../shared/network-observations.ts';
import { GuestDesktop,desktopAppSchema } from './guest-desktop.ts';
import type { DesktopAppId } from '../shared/guest-desktop.ts';
import { BROWSER_HOME_URL } from '../shared/browser-home.ts';
import {measureAccessLatency,latencyInput} from './latency.ts';
import type {AccessLatency,LatencyTarget} from '../shared/latency.ts';

export type HostNetworkEvent = 'ready' | 'changed' | 'failed';
export function protectionDiagnosticIssue(input:string){
 return redact(input).replace(/(?:^|\n)MU_EGRESS_DIAGNOSTICS=[^\n]*(?:\n|$)/g,'\n').trim().replace(/(?:https?|socks5h?|claude|grokbot|sand):\/\/[^\s<>"'`]+/gi,raw=>{
  try{const url=new URL(raw);return ['http:','https:','socks5:','socks5h:'].includes(url.protocol)?`${url.protocol}//${url.host}/[链接内容已隐藏]`:`${url.protocol}[链接内容已隐藏]`;}catch{return '[链接内容已隐藏]';}
 }).replace(/\bBearer\s+[^\s,;]+/gi,'Bearer ***');
}

export class Manager {
  store: Store;
  runtime: LimaRuntime;
  browser: BrowserHost;
  snapshots: Snapshots;
  backups: Backups;
  diskRecovery: DiskRecovery;
  tasks = new Map<string, { job: Job; controller: AbortController; promise: Promise<void> }>();
  recoveries = new Map<string, Promise<void>>();
  active = new Map<string, string>();
  reconciling: Promise<void> | null = null;
  lastReconcile = 0;
  monitoring: Promise<void> | null = null;
  closing = false;
  quarantines = new Map<string, Promise<void>>();
  hostSuspended = false;
  hostPowerChanges = new Set<Promise<void>>();
  hostNetwork: { state: 'starting' | 'ready' | 'failed'; issue: string | null } | undefined;
  hostNetworkGeneration = 0;
  hostNetworkChanges = new Set<Promise<void>>();
  generations = new Map<string, number>();
  egress = new Map<string, { key: string; result: EgressStatus }>();
  probes = new Map<string, { key: string; generation: number; promise: Promise<NetworkResult> }>();
  fallbackProtectionEvents=new Map<string,ProtectionEvent>();
  latencies=new Map<string,{key:string;generation:number;result:AccessLatency}>();
  latencyTests=new Map<string,{target:LatencyTarget;controller:AbortController;promise:Promise<AccessLatency>}>();
  protectionTimer: ReturnType<typeof setInterval>;
  networkObserver: NetworkObserver;
  desktop: GuestDesktop;
  onQuarantine?: (id: string) => void | Promise<void>;
  onBeforeStop?: (id:string) => Promise<void>;
  constructor(dataDir: string, browser?: BrowserHost, runtime?: LimaRuntime) {
    this.store = new Store(dataDir);
    this.runtime = runtime ?? new LimaRuntime(dataDir);
    this.browser = browser ?? new ChromeHost(dataDir);
    this.desktop=new GuestDesktop(this.runtime);
    this.snapshots = new Snapshots(this.store, this.runtime);
    this.backups = new Backups(this.store, this.snapshots);
    this.diskRecovery = new DiskRecovery(this.store, this.runtime);
    this.networkObserver=new NetworkObserver(this.store,this.runtime,(e,provider)=>this.measureTrafficExit(e,provider),
      e=>!this.closing&&!this.active.has(e.id)&&!this.quarantines.has(e.id)&&!this.hostSuspended&&(!this.hostNetwork||this.hostNetwork.state==='ready'),id=>this.generations.get(id)??0);
    this.protectionTimer=setInterval(()=>{void this.monitorProtection().catch(error=>{
      if(!this.closing)this.store.log(null,null,`防护监测失败：${redact(errorMessage(error))}`,'error');
    });},8000);
    this.protectionTimer.unref();
  }
  view(e: Environment) { return this.store.public({ ...e, browserRunning: this.browser.running(e.id) }); }
  async reconcile(force = false) {
    if (this.reconciling) return this.reconciling;
    if (!force && Date.now() - this.lastReconcile < 5000) return;
    this.reconciling = (async () => {
      for (const e of this.store.list()) {
        if (e.kind === 'browser' && !this.active.has(e.id) && e.state === 'running' && !this.browser.running(e.id)) this.store.state(e.id, 'stopped');
      }
      const info = await this.runtime.info();
      if (!info.available) return;
      const instances = await this.runtime.list();
      for (const e of this.store.list()) {
        if (e.kind !== 'vm' || this.active.has(e.id) || this.quarantines.has(e.id)) continue;
        const actual = instances.find(i => i.name === e.instanceName);
        if (await this.runtime.diskMaintenancePending(e)) {
          this.store.state(e.id, 'error', '磁盘维护尚未完成，请在设置中重试扩容'); this.invalidate(e.id);
          await this.onQuarantine?.(e.id);
          if (actual?.status === 'Running') await this.runtime.command(['stop', '--force', e.instanceName], { timeoutMs: 120_000 });
          continue;
        }
        if (actual?.status === 'Running') {
          if (e.network.strict && (this.hostSuspended || this.hostPowerChanges.size || (this.hostNetwork && (this.hostNetwork.state !== 'ready' || this.hostNetworkChanges.size)))) {
            await this.quarantine(e, this.hostNetwork?.issue ?? '宿主状态变化，保护环境需要手动重新启动');
            continue;
          }
          if (await this.runtime.sharedMountMaintenancePending(e)) {
            this.store.state(e.id, 'error', '共享目录维护已中断，请重新启动环境以完成安全迁移');
            this.invalidate(e.id);
            await this.onQuarantine?.(e.id);
            await this.runtime.command(['stop', '--force', e.instanceName], { timeoutMs: 120_000 });
            continue;
          }
          const seed = await readImportSeed(this.store.dataDir, e);
          if (seed && !seed.managementReady) {
            this.store.state(e.id, 'error', '导入环境的管理密钥初始化已中断，请重新启动环境');
            await this.runtime.stop(e);
            continue;
          }
        }
        const state = actual?.status === 'Running' ? 'running' : actual ? 'stopped' : 'not_created';
        if (e.state !== state && e.state !== 'error') { this.store.state(e.id, state); this.invalidate(e.id); }
      }
      this.lastReconcile = Date.now();
    })().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }
  async snapshot(): Promise<Snapshot> {
    try { await this.reconcile(); } catch { /* Runtime health is displayed independently below. */ }
    return {
      environments: this.store.list().map(e => this.view(e)), jobs: this.store.jobs(),
      system: { platform: process.platform, arch: process.arch, hostname: hostname(), cpus: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30), freeMemoryGiB: Math.round(freemem() / 2 ** 30), dataDir: this.store.dataDir, version: VERSION, runtime: await this.runtime.info(), browser: { available: await this.browser.available(), native: this.browser.native, engine: this.browser.native ? 'Chromium / Electron' : 'Google Chrome' }, ...(this.hostNetwork ? { hostNetwork: { ...this.hostNetwork } } : {}) },
    };
  }
  ensureIdle(id: string) { if (this.quarantines.has(id)) throw new AppError('环境正在隔离停机',409,'QUARANTINED'); if (this.active.has(id)) throw new AppError('这个环境正在执行其他操作，请等待完成', 409, 'OPERATION_IN_PROGRESS'); }
  private assertHostPowerReady(e: Environment, networkGeneration = this.hostNetworkGeneration) {
    if (e.kind === 'vm' && e.network.strict && (this.hostSuspended || this.hostPowerChanges.size))
      throw new AppError('电脑正在休眠或处理唤醒，保护环境暂不可启动或访问', 409, 'HOST_POWER_TRANSITION');
    if (e.kind === 'vm' && e.network.strict && this.hostNetwork &&
        (this.hostNetwork.state !== 'ready' || this.hostNetworkChanges.size || networkGeneration !== this.hostNetworkGeneration))
      throw new AppError(this.hostNetwork.issue ?? '电脑网络正在变化，请稍后手动启动环境', 409, 'HOST_NETWORK_UNAVAILABLE');
  }
  enableHostNetworkMonitor() { this.hostNetwork = { state: 'starting', issue: '正在核验电脑网络监测组件' }; }
  async handleHostNetworkEvent(event: HostNetworkEvent) {
    if (this.closing || !this.hostNetwork) return;
    if (event === 'ready') {
      if (this.hostNetwork.state === 'starting') this.hostNetwork = { state: 'ready', issue: null };
      return;
    }
    this.hostNetworkGeneration++;
    const issue = event === 'failed' ? '电脑网络监测失效，保护环境已关闭；请重新打开应用' : '电脑网络已变化，保护环境已关闭；请手动重新启动并核验';
    if (event === 'failed') this.hostNetwork = { state: 'failed', issue };
    this.store.log(null, null, issue, 'error');
    const stops = this.store.list().filter(e => e.kind === 'vm' && e.network.strict && ['creating', 'starting', 'running', 'stopping'].includes(e.state))
      .map(e => this.quarantine(e, issue));
    const pending = Promise.allSettled(stops).then(() => {});
    this.hostNetworkChanges.add(pending);
    try { await pending; } finally { this.hostNetworkChanges.delete(pending); }
  }
  async handleHostPowerEvent(event: 'suspend' | 'resume') {
    if (this.closing) return;
    this.hostSuspended = event === 'suspend';
    const issue = event === 'suspend' ? '电脑休眠，保护环境已关闭；唤醒后请手动启动' : '电脑唤醒，保护环境需要手动重新启动并核验';
    // Close access synchronously before any asynchronous guest shutdown.
    const stops = this.store.list().filter(e => e.kind === 'vm' && e.network.strict && ['creating', 'starting', 'running', 'stopping'].includes(e.state))
      .map(e => this.quarantine(e, issue));
    const pending = Promise.allSettled(stops).then(() => {});
    this.hostPowerChanges.add(pending);
    try { await pending; } finally { this.hostPowerChanges.delete(pending); }
  }
  private networkKey(e: Environment) { return JSON.stringify(e.network); }
  private invalidate(id: string) { this.generations.set(id, (this.generations.get(id) ?? 0) + 1); this.egress.delete(id);this.latencies.delete(id);this.latencyTests.get(id)?.controller.abort(); }
  egressStatus(id: string): EgressStatus {
    const e = this.store.get(id);
    if (!e.network.egressLock) return { status: 'disabled' };
    const last = this.egress.get(id);
    if (last?.key === this.networkKey(e)) return last.result;
    return { status: 'unverified', expectedIp: e.network.egressLock.expectedIp };
  }
  protectionEvents(id:string){
    const e=this.store.get(id);
    let events=this.store.protectionEvents(id);
    const fallback=[...this.fallbackProtectionEvents.values()].filter(value=>value.environmentId===id);
    if(!events.length&&!fallback.length){
      const historical=this.store.jobs().filter(job=>job.environmentId===id&&(job.action==='quarantine'||['start','restart'].includes(job.action)&&job.status==='failed'&&/出口|回执|网络防护|防火墙|断网许可/.test(job.message)));
      for(const job of historical)this.recordProtectionFailure(e,job.message,'legacy',job.createdAt);
      if(!historical.length&&e.state==='error'&&e.lastError)this.recordProtectionFailure(e,e.lastError,'legacy');
      events=this.store.protectionEvents(id);
    }
    return [...this.fallbackProtectionEvents.values()].filter(value=>value.environmentId===id).concat(events).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100);
  }
  private recordProtectionFailure(e:Environment,issue:string,source:ProtectionEvent['source']='current',at?:string){
    const cached=this.egress.get(e.id);const proof=cached?.key===this.networkKey(e)&&cached.result.issue===issue?cached.result:undefined;
    const checks=structuredClone(proof?.checks??[]);
    const kind=protectionKind(issue,checks);
    // Older application builds must still be able to read the persisted event.
    // The current UI derives the precise connection class from its evidence.
    const event:ProtectionEvent={id:randomUUID(),environmentId:e.id,at:at??(source==='legacy'?e.updatedAt:new Date().toISOString()),kind:kind==='connection'?'exit-unavailable':kind,issue:protectionDiagnosticIssue(issue).slice(0,2400),source,route:{mode:e.network.mode,host:e.network.host,port:e.network.port},expectedIp:proof?.expectedIp??e.network.egressLock?.expectedIp,
      observedIps:[...new Set([...(proof?.actualIp?[proof.actualIp]:[]),...checks.flatMap(c=>c.ip?[c.ip]:[])])],checks,stopResult:source==='legacy'?'not-confirmed':'requested',resolvedAt:null,persisted:true};
    try{this.store.addProtectionEvent(event);}catch{
      event.persisted=false;this.fallbackProtectionEvents.set(event.id,event);if(this.fallbackProtectionEvents.size>100)this.fallbackProtectionEvents.delete(this.fallbackProtectionEvents.keys().next().value!);
      try{this.store.log(e.id,null,'防护事件暂未能写入磁盘；已保留内存记录，请导出诊断并检查磁盘空间。隔离仍会执行。','error');}catch{/* Recording failure must never prevent revocation. */}
    }return event.id;
  }
  private updateProtectionStop(id:string,status:ProtectionEvent['stopResult'],issue?:string){
    const fallback=this.fallbackProtectionEvents.get(id);if(fallback){fallback.stopResult=status;fallback.stopIssue=issue?redact(issue):undefined;return;}
    try{this.store.updateProtectionStop(id,status,issue);}catch{/* The already requested stop must still complete. */}
  }
  private resolveProtectionFailures(e:Environment){
    const result=this.egressStatus(e.id);
    const proof:ProtectionResolution={at:new Date().toISOString(),...(result.status==='verified'?{ip:result.actualIp}:{}),receipts:result.verification?.receipts??[]};
    try{this.store.resolveProtectionEvents(e.id,proof);}catch{try{this.store.log(e.id,null,'启动已通过，但故障恢复记录保存失败，请检查磁盘并导出诊断','error');}catch{}}
    for(const event of this.fallbackProtectionEvents.values()){
      if(event.environmentId!==e.id||event.resolvedAt)continue;
      const enough=proof.ip&&new Set(proof.receipts.map(r=>r.receiver)).size>=2&&proof.receipts.every(r=>r.ip===proof.ip);
      if(['exit-changed','exit-unavailable','connection','tls','proxy-auth','dns'].includes(event.kind)&&!enough)continue;
      event.resolvedAt=proof.at;event.resolution=proof;
    }
  }
  async measureExit(e: Environment, options: RunOptions = {}) { return measureEgress(this.runtime, e, options); }
  private async verifyExit(e: Environment, options: RunOptions = {}) {
    const expected = e.network.egressLock?.expectedIp;
    if (!expected) return;
    const key = this.networkKey(e), generation = this.generations.get(e.id) ?? 0;
    let pending = this.probes.get(e.id);
    if (!pending || pending.key !== key || pending.generation !== generation) {
      const promise = this.measureExit(e, options);
      pending = { key, generation, promise }; this.probes.set(e.id, pending);
      void promise.finally(() => { if (this.probes.get(e.id)?.promise === promise) this.probes.delete(e.id); }).catch(() => {});
    }
    let result: NetworkResult | undefined, issue = '',checks:ProtectionEvent['checks']=[];
    try {
      result = await pending.promise;
      parseEgress(JSON.stringify(result));
      if (result.ip !== expected) issue = `出口 IP 已变化：批准 ${expected}，检测到 ${result.ip}`;
    } catch (error) {
      checks=egressErrorChecks(error);
      result=error instanceof EgressMismatchError?{ip:error.actualIp,country:'',city:'',latencyMs:0,source:'guest'}:undefined;
      issue=result?`出口 IP 已变化：批准 ${expected}，检测到 ${result.ip}`:`无法确认批准的出口：${protectionDiagnosticIssue(errorMessage(error))}`;
    }
    if ((this.generations.get(e.id) ?? 0) !== generation || this.networkKey(this.store.get(e.id)) !== key)
      throw new AppError('环境在出口检测期间发生变化，请重新检测',409,'CONFIGURATION_CHANGED');
    this.egress.set(e.id, { key, result: { status: issue ? result ? 'changed' : 'unavailable' : 'verified', expectedIp: expected,
      actualIp: result?.ip, checkedAt: new Date().toISOString(), ...(result?.verification?{verification:result.verification}:{}), ...(checks.length?{checks}:{}), ...(issue ? { issue } : {}) } });
    this.networkObserver.recordVerification(e,this.egress.get(e.id)!.result);
    if (issue) throw new AppError(issue,409,'EGRESS_FAILED');
    return result!;
  }
  async assertAccess(id: string, allowBusy = false) {
    if (this.closing || this.quarantines.has(id)) throw new AppError('环境访问已关闭',409,'QUARANTINED');
    if (!allowBusy) this.ensureIdle(id);
    const e = this.store.get(id), key = this.networkKey(e), generation = this.generations.get(id) ?? 0;
    this.assertHostPowerReady(e);
    let measured: NetworkResult | undefined;
    if (e.kind !== 'vm' || e.state !== 'running') throw new AppError('请先启动 Linux 环境',409,'ENVIRONMENT_STOPPED');
    try {
      if (await this.runtime.diskMaintenancePending(e)) throw new AppError('磁盘维护尚未完成，请先重试扩容', 409, 'DISK_RECOVERY_PENDING');
      if (await this.runtime.sharedMountMaintenancePending(e)) throw new AppError('共享目录维护尚未完成，环境访问已关闭', 409, 'SHARED_MOUNT_MIGRATION_PENDING');
      if (e.network.strict) {
        const protection = await this.runtime.networkProtection(e);
        if (!protection.active) throw new AppError(protection.issues?.join('；') || '网络防护未通过核验',409,'GUARD_FAILED');
      }
      await this.browser.assertProtection?.(id);
      await this.desktop.assertProtected(e);
      measured = await this.verifyExit(e);
    } catch (error) {
      if (!this.closing && (this.generations.get(id) ?? 0) === generation && this.networkKey(this.store.get(id)) === key && this.store.get(id).state === 'running')
        void this.quarantine(e, redact(errorMessage(error)));
      throw error;
    }
    if (this.closing || this.quarantines.has(id) || this.store.get(id).state !== 'running' || (this.generations.get(id) ?? 0) !== generation || this.networkKey(this.store.get(id)) !== key)
      throw new AppError('环境在访问核验期间发生变化',409,'CONFIGURATION_CHANGED');
    try { await this.runtime.renewLease(e); }
    catch(error) { if(!this.closing && !this.quarantines.has(id) && (this.generations.get(id)??0)===generation)void this.quarantine(e,redact(errorMessage(error)));throw error; }
    if(this.closing || this.quarantines.has(id) || (this.generations.get(id)??0)!==generation)throw new AppError('环境访问已关闭',409,'CONFIGURATION_CHANGED');
    if (!allowBusy) this.ensureIdle(id);
    return measured;
  }
  private quarantine(e: Environment, issue: string) {
    issue=protectionDiagnosticIssue(issue);
    const current = this.quarantines.get(e.id); if (current) return current;
    const task = this.tasks.get(this.active.get(e.id) ?? '');
    this.generations.set(e.id, (this.generations.get(e.id) ?? 0) + 1);
    const protectionEvent=this.recordProtectionFailure(e,issue);
    this.store.state(e.id, 'stopping');
    this.store.log(e.id,null,`防护异常，撤销访问并停止环境：${issue}`,'error');
    const job = this.store.newJob(e.id,'quarantine');
    task?.controller.abort();
    const revoke = async () => { try { await this.onQuarantine?.(e.id); } catch (error) { this.store.log(e.id,null,`撤销连接时发生错误：${redact(errorMessage(error))}`,'error'); } };
    const pending = Promise.resolve().then(async () => {
      const revoked = revoke();
      let failure = '';
      try { await this.runtime.stop(e); } catch (error) { failure = `隔离停机未能确认完成：${redact(errorMessage(error))}`; }
      this.updateProtectionStop(protectionEvent,failure?'failed':'confirmed',failure||undefined);
      await task?.promise;
      await revoked; await revoke();
      this.store.state(e.id,'error',failure || `环境已停止：${issue}`);
      this.store.finishJob(job.id,failure ? 'failed' : 'succeeded',failure || issue);
    }).catch(error => { this.store.state(e.id,'error',redact(errorMessage(error))); this.store.finishJob(job.id,'failed',redact(errorMessage(error))); })
      .finally(() => { if (this.quarantines.get(e.id) === pending) this.quarantines.delete(e.id); });
    this.quarantines.set(e.id,pending); return pending;
  }
  async monitorProtection() {
    if (this.closing) return;
    if (this.monitoring) return this.monitoring;
    this.monitoring = (async () => {
      const idleGuests = this.store.list().filter(e => e.kind === 'vm' && !this.active.has(e.id) && !this.quarantines.has(e.id));
      const pendingDisks = await Promise.all(idleGuests.map(e => this.runtime.diskMaintenancePending(e)));
      // A surviving Lima startup may finish after the first post-crash reconciliation.
      if (pendingDisks.some(Boolean)) await this.reconcile(true);
      await Promise.allSettled(this.store.list().filter(e => e.kind === 'vm' && e.network.strict && e.state === 'running')
        .map(e => this.assertAccess(e.id,true)));
      await Promise.allSettled([...this.quarantines.values()]);
    })().finally(() => { this.monitoring = null; });
    return this.monitoring;
  }
  async validate(input: unknown) {
    const parsed = environmentSchema.parse(input);
    parsed.mounts = await validateMounts(parsed.mounts, this.store.dataDir);
    if (parsed.cpus > cpus().length) throw new AppError('CPU 数量超过本机可用核心');
    if (parsed.memoryGiB > Math.floor(totalmem() / 2 ** 30 * 0.8)) throw new AppError('环境内存不能超过本机总内存的 80%');
    if (new Set(parsed.ports.map(p => p.hostPort)).size !== parsed.ports.length) throw new AppError('本机端口不能重复');
    return parsed;
  }
  async create(input: unknown, requestedId = randomUUID()) {
    const config = await this.validate(input);
    if (config.network.mode === 'wireguard' && !config.network.wireguard?.privateKey) throw new AppError('请提供隧道私钥');
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestedId))throw new AppError('环境标识无效');
    const id = requestedId;
    const now = new Date().toISOString();
    const e: Environment = { ...config, id, instanceName: `mu-${id.replaceAll('-', '').slice(0, 16)}`, state: 'not_created', lastError: null, createdAt: now, updatedAt: now, browserRunning: false };
    this.store.save(e);
    this.store.log(id, null, `已创建环境「${e.name}」`);
    return this.view(e);
  }
  async update(id: string, input: unknown) {
    this.ensureIdle(id);
    const old = this.store.get(id);
    if (old.state === 'running' || this.browser.running(id)) throw new AppError('请先停止环境和浏览器，再保存配置', 409);
    this.active.set(id, 'configuration-update');
    try {
      if (await this.runtime.diskMaintenancePending(old)) throw new AppError('磁盘维护尚未完成，请先重试扩容', 409, 'DISK_RECOVERY_PENDING');
      const config = await this.validate(input);
      if (config.kind !== old.kind) throw new AppError('环境类型创建后不能修改');
      if (old.kind === 'vm' && config.diskGiB !== old.diskGiB) {
        const imported = await lstat(path.join(this.store.dataDir, 'imports', id, 'seed.json')).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
        if (old.state !== 'not_created' || imported) throw new AppError('已创建或导入的 Linux 磁盘大小暂不支持修改');
      }
      const e = { ...old, ...config, network: { ...config.network, password: config.network.password === undefined ? old.network.password : config.network.password } };
      if (e.network.mode === 'wireguard') {
        e.network.password = undefined;
        e.network.wireguard = { ...config.network.wireguard!, privateKey: config.network.wireguard?.privateKey ?? old.network.wireguard?.privateKey };
        if (!e.network.wireguard.privateKey) throw new AppError('请提供隧道私钥');
      }
      if (e.kind === 'vm' && (await this.runtime.info()).available) await this.runtime.updateConfig(e);
      this.store.save(e);
      this.invalidate(id);
      this.store.log(id, null, '已保存环境配置');
      return this.view(this.store.get(id));
    } finally { this.active.delete(id); }
  }
  async growDisk(id: string, targetGiB: number) {
    diskCapacitySchema.parse(targetGiB); this.ensureIdle(id);
    if (this.closing) throw new AppError('应用正在退出', 409, 'CLOSING');
    const e = this.store.get(id);
    this.assertHostPowerReady(e);
    if (e.kind !== 'vm' || e.state === 'running' || this.browser.running(id)) throw new AppError('请先停止 Linux 环境和浏览器', 409, 'DISK_RECOVERY_STATE');
    if (targetGiB < e.diskGiB) throw new AppError('磁盘容量不能缩小', 409, 'DISK_RECOVERY_SIZE');
    checkResources(e, this.store.list(), { cpus: cpus().length, memoryGiB: totalmem() / 2 ** 30 });
    this.invalidate(id); this.store.state(id, 'starting');
    return this.submit(id, 'disk-grow', async options => {
      await this.onBeforeStop?.(id);
      await this.snapshots.recover(e, options);
      await this.diskRecovery.grow(this.store.get(id), targetGiB, options);
      options.signal?.throwIfAborted();
      await this.diskRecovery.commit(this.store.get(id), targetGiB);
    });
  }
  submit(environmentId: string | null, action: string, execute: (options: RunOptions) => Promise<void>) {
    const key = environmentId ?? 'system';
    this.ensureIdle(key);
    const job = this.store.newJob(environmentId, action);
    const controller = new AbortController();
    this.active.set(key, job.id);
    const onOutput = (text: string) => {
      const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      if (clean) this.store.log(environmentId, job.id, clean);
    };
    const promise = Promise.resolve().then(async () => {
      this.store.log(environmentId, job.id, `开始操作：${action}`);
      try {
        await execute({ signal: controller.signal, onOutput });
        controller.signal.throwIfAborted();
        this.store.finishJob(job.id, 'succeeded', '操作已完成');
        this.store.log(environmentId, job.id, '操作已完成');
      } catch (error) {
        const message = redact(errorMessage(error));
        this.store.finishJob(job.id, controller.signal.aborted ? 'cancelled' : 'failed', message);
        this.store.log(environmentId, job.id, message, 'error');
        if (environmentId && !['install-agent','open-browser','browser-update','browser-recover','browser-reset','desktop-install','desktop-start','desktop-stop','lab-check','bridge-grant','bridge-revoke','backup-export'].includes(action)) this.store.state(environmentId, 'error', message);
      } finally {
        this.active.delete(key);
        this.tasks.delete(job.id);
        await this.reconcile(true).catch(() => {});
      }
    });
    this.tasks.set(job.id, { job, controller, promise });
    return job;
  }
  async lifecycle(id: string, action: 'start' | 'stop' | 'restart' | 'delete' | 'install-agent' | 'prepare-network') {
    const networkGeneration = this.hostNetworkGeneration;
    if (this.closing) throw new AppError('应用正在退出', 409, 'CLOSING');
    if (action === 'start' || action === 'restart') this.assertHostPowerReady(this.store.get(id), networkGeneration);
    this.ensureIdle(id);
    this.active.set(id, 'snapshot-recovery');
    const recovery = Promise.resolve().then(async () => {
      if (!['stop', 'delete'].includes(action) && await this.runtime.diskMaintenancePending(this.store.get(id)))
        throw new AppError('磁盘维护尚未完成，请先重试扩容', 409, 'DISK_RECOVERY_PENDING');
      await this.snapshots.recover(this.store.get(id));
    });
    this.recoveries.set(id, recovery);
    try { await recovery; }
    finally { this.active.delete(id); this.recoveries.delete(id); }
    if (this.closing) throw new AppError('应用正在退出', 409, 'CLOSING');
    this.ensureIdle(id);
    const e = this.store.get(id);
    if (action === 'start' || action === 'restart') this.assertHostPowerReady(e, networkGeneration);
    if (action === 'start' && e.state === 'running') throw new AppError('环境已经运行', 409, 'ALREADY_STARTED');
    if (action === 'install-agent' && (e.kind !== 'vm' || e.state !== 'running')) throw new AppError('请先启动 Linux 环境', 409);
    if (action === 'prepare-network' && (e.kind !== 'vm' || e.state !== 'running' || e.network.strict)) throw new AppError('请在运行中的旧 Linux 环境准备防护', 409);
    if (e.kind === 'vm' && ['start', 'restart', 'install-agent'].includes(action) && !(await this.runtime.info()).available) throw new AppError('请先安装 Lima 运行组件', 409, 'RUNTIME_MISSING');
    if (e.kind === 'vm' && ['start', 'restart'].includes(action)) await validateMounts(e.mounts, this.store.dataDir);
    if (e.kind === 'vm' && ['start', 'restart'].includes(action)) {
      if (e.state !== 'running') await checkHostPorts(e.ports.map(p => p.hostPort));
    }
    this.ensureIdle(id);
    if (action === 'start' || action === 'restart') this.assertHostPowerReady(e, networkGeneration);
    if (this.store.get(id).updatedAt !== e.updatedAt) throw new AppError('环境配置发生变化，请重新执行操作', 409, 'CONFIGURATION_CHANGED');
    if (e.kind === 'vm' && ['start', 'restart'].includes(action)) checkResources(e, this.store.list(), { cpus: cpus().length, memoryGiB: totalmem() / 2 ** 30 });
    if (['start','stop','restart','delete','prepare-network'].includes(action)) this.invalidate(id);
    this.store.state(id, action === 'delete' ? 'deleting' : ['stop', 'prepare-network'].includes(action) ? 'stopping' : action === 'install-agent' ? e.state : 'starting');
    return this.submit(id, action, async options => {
      if(['stop','restart','delete','prepare-network'].includes(action))await this.onBeforeStop?.(id);
      if (action === 'delete') {
        await this.purgeEnvironmentFiles(e,options);
        this.store.remove(id);
      } else if (action === 'prepare-network') { await this.runtime.prepareNetwork(e, options); this.store.state(id, 'stopped'); }
      else if (action === 'install-agent') { await this.assertAccess(id,true); await this.runtime.installAgent(e, options); }
      else if (e.kind === 'browser') {
        if (action === 'stop' || action === 'restart') await this.browser.close(id);
        if (action === 'start' || action === 'restart') await this.browser.open(e);
        this.store.state(id, action === 'stop' ? 'stopped' : 'running');
      } else {
        if(action==='stop'||action==='restart')await this.browser.close(id);
        if (action === 'stop' || action === 'restart') await this.runtime.stop(e, options);
        if (action === 'start' || action === 'restart') {
          options.signal?.throwIfAborted(); this.assertHostPowerReady(e, networkGeneration);
          await this.runtime.start(e, options);
          try {
            const running={...e,state:'running' as const};
            if(e.network.strict && !(await this.runtime.networkProtection(running,false)).active)throw new AppError('启动网络防护未通过核验',409,'GUARD_FAILED');
            await this.verifyExit(running,options); options.signal?.throwIfAborted();
            if(this.closing)throw new AppError('应用正在退出',409,'CLOSING');
            this.assertHostPowerReady(running, networkGeneration);
            await this.runtime.renewLease(running,true,options);options.signal?.throwIfAborted();
          }
          catch (error) {
            const event=options.signal?.aborted?undefined:this.recordProtectionFailure({...e,state:'running'},redact(errorMessage(error)));
            try{await this.runtime.stop(e);if(event)this.updateProtectionStop(event,'confirmed');}catch(stopError){if(event)this.updateProtectionStop(event,'failed',redact(errorMessage(stopError)));this.store.log(id,null,`出口核验失败后的停机错误：${redact(errorMessage(stopError))}`,'error');}
            throw error;
          }
        }
        this.store.state(id, action === 'stop' ? 'stopped' : 'running');
        if(action==='start'||action==='restart')this.resolveProtectionFailures(this.store.get(id));
      }
    });
  }
  async openBrowser(id: string,showWindow=true) {
    const e = this.store.get(id);
    if(e.kind==='vm'&&e.state!=='running')throw new AppError('请先启动 Linux 环境',409);
    if (e.network.strict&&e.kind!=='vm') throw new AppError('本机浏览器不受 Linux 防火墙约束', 409, 'GUEST_ONLY_POLICY');
    return this.submit(id, 'open-browser', async options => { await this.browser.open(e,options,showWindow); if (e.kind === 'browser') this.store.state(id, 'running'); });
  }
  async closeBrowser(id: string) {
    this.ensureIdle(id);
    const e = this.store.get(id);
    if(this.browser.closeApplication)await this.browser.closeApplication(id);
    else await this.browser.close(id);
    if (e.kind === 'browser') this.store.state(id, 'stopped');
  }
  async maintainBrowser(id: string, action: 'update' | 'recover' | 'reset') {
    const e = this.store.get(id);
    if(e.kind!=='vm'||e.state!=='running')throw new AppError('请先启动 Linux 环境',409);
    const operation = this.browser[action];
    if(!operation)throw new AppError('当前运行组件不支持浏览器维护',409);
    return this.submit(id, `browser-${action}`, async options => {
      await this.assertAccess(id,true);
      await operation.call(this.browser,e,options);
    });
  }
  async launchDesktop(e:Environment,app:DesktopAppId,options:RunOptions={}){
    try{
      await this.desktop.start(e,app,options);
      let protectedRenderer=false,consecutiveProtected=0,lastIssue='no-renderer';
      for(let i=0;i<120;i++){
        options.signal?.throwIfAborted();
        const status=(await this.desktop.status(e)).apps.find(a=>a.id===app);
        // Electron can replace its first renderer while bringing up the real window.
        // One early protected renderer is not sufficient evidence of completed startup.
        consecutiveProtected=status?.running&&status.rendererProtected===true?consecutiveProtected+1:0;
        lastIssue=status?.issue||(!status?.running?'not-running':'no-renderer');
        if(consecutiveProtected>=4){protectedRenderer=true;break;}
        await new Promise(r=>setTimeout(r,250));
      }
      if(!protectedRenderer){await this.desktop.stop(e,app);throw new AppError(`桌面客户端渲染进程保护未通过，已关闭客户端（${app}：${lastIssue}）`,409,'DESKTOP_SANDBOX_FAILED');}
      this.desktop.tracked.add(e.id);
    }finally{this.desktop.finishStart(e.id,app);}
  }
  async focusApplication(id:string,target:GuestWindowTarget){
    const e=this.store.get(id);await this.assertAccess(id,true);
    if(this.active.has(id))return {focused:false,pending:true};
    return {focused:await this.browser.focus?.(e,target)??false,pending:false};
  }
  async openExternalLink(id:string,url:string){
    const link=parseGuestLink(url);this.ensureIdle(id);const e=this.store.get(id);
    return this.submit(id,'open-external-link',async options=>{
      await this.assertAccess(id,true);
      const linkOptions={...options,onOutput:undefined};
      try{
      if(link.application){
        if(!this.browser.ensureDisplay)throw new AppError('当前组件不支持客体显示',409);
        await this.browser.ensureDisplay(e,linkOptions);await this.launchDesktop(e,link.application,linkOptions);
        await this.desktop.deliverLink(e,link.application,link.url,linkOptions);
        await this.browser.focus?.(e,link.application);
        await this.browser.showGuestApplication?.(e,'desktop',link.application);
      }else{
        if(!this.browser.openLink)throw new AppError('当前组件不支持受管网页打开',409);
        await this.browser.openLink(e,link.url,linkOptions);
      }
      await this.assertAccess(id,true);
      }catch(error){
        if(error instanceof AppError&&['GUARD_FAILED','QUARANTINED','DESKTOP_SANDBOX_FAILED','BROWSER_SANDBOX_FAILED','ENVIRONMENT_STOPPED'].includes(error.code))throw error;
        throw new AppError('客户端网页或返回链接未能完成，请确认网络防护后重试',409,'GUEST_HANDOFF_FAILED');
      }
    });
  }
  async desktopAction(id:string,app:DesktopAppId,action:'install'|'start'|'stop') {
    desktopAppSchema.parse(app);this.ensureIdle(id);const e=this.store.get(id);
    if(e.kind!=='vm'||e.state!=='running'||!e.network.strict||!e.network.transparent)throw new AppError('请先启动受保护的 Linux 透明代理环境',409);
    return this.submit(id,`desktop-${action}`,async options=>{
      if(action==='stop'){await this.desktop.stop(e,app,options);return;}
      await this.assertAccess(id,true);
      if(action==='install')await this.desktop.install(e,app,options);
      else {
        if(!this.browser.ensureDisplay)throw new AppError('当前组件不支持独立桌面显示，请更新本机应用',409);
        await this.browser.ensureDisplay(e,options);await this.assertAccess(id,true);
        await this.launchDesktop(e,app,options);
        await this.browser.focus?.(e,app);
      }
      await this.assertAccess(id,true);
    });
  }
  async cleanRebuild(id:string) {
    this.ensureIdle(id);const old=this.store.get(id);
    if(old.kind!=='vm')throw new AppError('彻底重建只支持 Linux 环境',409);
    const input={name:old.name,description:old.description,kind:'vm',color:old.color,cpus:old.cpus,memoryGiB:old.memoryGiB,diskGiB:old.diskGiB,identity:old.identity,network:old.network,mounts:[],ports:[],browserUrl:BROWSER_HOME_URL};
    await this.validate(input);this.ensureIdle(id);
    if(this.store.get(id).updatedAt!==old.updatedAt)throw new AppError('环境配置已变化，请重新确认重建',409,'CONFIGURATION_CHANGED');
    const replacementEnvironmentId=randomUUID();this.invalidate(id);this.store.state(id,'deleting');
    const job=this.submit(id,'environment-rebuild',async options=>{
      await this.onBeforeStop?.(id);await this.purgeEnvironmentFiles(old,options);
      options.signal?.throwIfAborted();
      await this.create(input,replacementEnvironmentId);
      this.store.remove(id);
    });
    return {job,replacementEnvironmentId};
  }
  private async purgeEnvironmentFiles(e:Environment,options:RunOptions={}) {
    await this.browser.clear(e.id);
    if(e.kind==='vm'&&(await this.runtime.info()).available)await this.runtime.remove(e,options);
    else if(e.kind==='vm'&&e.state!=='not_created')throw new AppError('运行组件不可用，无法确认 Linux 磁盘已删除',409);
    for(const directory of ['browsers','snapshots','imports','disk-recovery','restore'])await rm(path.join(this.store.dataDir,directory,e.id),{recursive:true,force:true});
    this.desktop.tracked.delete(e.id);
    this.networkObserver.forget(e.id);
  }
  async testNetwork(id: string): Promise<NetworkResult> {
    const e = this.store.get(id);
    const started = performance.now();
    const url = 'https://ipwho.is/';
    if (e.network.egressLock) {
      const measured=(await this.assertAccess(id))!;
      if(measured.verification){
        for(const value of measured.verification.receipts)if(value.receiver!=='icanhazip')
          this.networkObserver.record(e,value.receiver,{ip:value.ip,country:value.country??'',city:value.city??'',latencyMs:value.latencyMs,source:'guest'});
      }else this.networkObserver.record(e,'ipwho',measured);
      return measured;
    }
    const args = ['-q', '--fail', '--silent', '--show-error', '--max-time', '18', '--connect-timeout', '8', '--max-filesize', '65536'];
    const proxy = proxyUrl(e.network, e.kind === 'vm');
    if (!e.network.strict) { args.push('--noproxy', e.network.noProxy, '--proxy', proxy || ''); }
    args.push(url);
    const output = e.kind === 'vm' ? await this.runtime.guest(e, ['curl', ...args], { timeoutMs: 22_000 }) : await run('/usr/bin/curl', args, { timeoutMs: 22_000 });
    const result = parseEgress(output);
    this.store.log(id, null, `出口检测成功：${result.ip} / ${result.country}`);
    const measured:NetworkResult={ ip: result.ip, country: result.country??'', city: result.city??'', latencyMs: Math.round(performance.now() - started), source: e.kind === 'vm' ? 'guest' : 'host' };
    if(e.kind==='vm')this.networkObserver.record(e,'ipwho',measured);return measured;
  }
  accessLatency(id:string):AccessLatency|null{
    const e=this.store.get(id),last=this.latencies.get(id);
    return e.state==='running'&&last?.key===this.networkKey(e)&&last.generation===(this.generations.get(id)??0)?last.result:null;
  }
  async testAccessLatency(id:string,target:LatencyTarget='google'):Promise<AccessLatency>{
    latencyInput.parse({target});this.ensureIdle(id);
    const e=this.store.get(id);
    if(e.kind!=='vm'||e.state!=='running')throw new AppError('请先启动 Linux 沙箱再检测延迟',409,'ENVIRONMENT_STOPPED');
    const existing=this.latencyTests.get(id);
    if(existing){if(existing.target===target)return existing.promise;throw new AppError('此环境正在检测另一个站点，请等待完成',409,'LATENCY_BUSY');}
    const key=this.networkKey(e),generation=this.generations.get(id)??0,controller=new AbortController();
    this.latencies.delete(id);
    let pending!:{target:LatencyTarget;controller:AbortController;promise:Promise<AccessLatency>};
    const unchanged=()=>!this.closing&&!controller.signal.aborted&&this.store.get(id).state==='running'&&this.networkKey(this.store.get(id))===key&&(this.generations.get(id)??0)===generation;
    const promise=(async()=>{try{
      await this.assertAccess(id);
      if(!unchanged())throw new AppError('环境或线路已变化，请重新检测延迟',409,'CONFIGURATION_CHANGED');
      const result=await measureAccessLatency(this.runtime,e,target,{signal:controller.signal});
      await this.assertAccess(id);
      if(!unchanged())throw new AppError('环境或线路已变化，请重新检测延迟',409,'CONFIGURATION_CHANGED');
      this.latencies.set(id,{key,generation,result});
      this.store.log(id,null,`线路延迟：${target} · ${result.medianMs===null?'检测失败':`${result.medianMs} ms`} · ${result.successfulSamples}/3 次成功`,result.medianMs===null?'error':'info');
      return result;
    }finally{if(this.latencyTests.get(id)===pending)this.latencyTests.delete(id);}})();
    pending={target,controller,promise};this.latencyTests.set(id,pending);return promise;
  }
  async measureTrafficExit(e:Environment,provider:ProbeProvider):Promise<NetworkResult> {
    const started=performance.now();
    // Business identity observes the actual guest route. No pre-access permission is opened.
    const output=await this.runtime.guest(e,['/usr/bin/curl','-q','--ipv4','--fail','--silent','--show-error','--proto','=https',
      '--max-time','8','--connect-timeout','4','--max-filesize','65536',provider==='ipwho'?'https://ipwho.is/':'https://api.ipify.org/?format=json'],{timeoutMs:12_000});
    const result=parseEgress(output);return {ip:result.ip,country:result.country??'',city:result.city??'',latencyMs:Math.round(performance.now()-started),source:'guest'};
  }
  async sampleNetwork(id:string) {
    this.ensureIdle(id);const e=this.store.get(id);
    if(e.kind!=='vm'||e.state!=='running')throw new AppError('请先启动 Linux 环境',409);
    await this.networkObserver.sample(e);return this.networkObserver.info(this.store.get(id));
  }
  cancel(jobId: string) {
    const task = this.tasks.get(jobId);
    if (!task) throw new AppError('操作已经结束', 409);
    task.controller.abort();
  }
  async close() {
    this.closing = true;
    for(const test of this.latencyTests.values())test.controller.abort();
    clearInterval(this.protectionTimer);
    const observationsClosed=this.networkObserver.close();
    await Promise.allSettled(this.store.list().filter(e=>e.kind==='vm'&&e.network.strict).map(e=>this.runtime.revokeLease(e)));
    await this.monitoring;
    await observationsClosed;
    await Promise.allSettled([...this.latencyTests.values()].map(test=>test.promise));
    for (const task of this.tasks.values()) task.controller.abort();
    await Promise.allSettled([...this.tasks.values()].map(t => t.promise));
    await Promise.allSettled([...this.recoveries.values()]);
    await Promise.allSettled([...this.quarantines.values()]);
    await this.browser.dispose();
    this.store.close();
  }
}
