import { access, lstat, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import { z } from 'zod';
import { parse, stringify } from 'yaml';
import type { Environment, Metrics, AgentStatus, NetworkProtection } from '../shared/types.ts';
import { run } from './process.ts';
import type { Runner, RunOptions } from './process.ts';
import { AppError, errorMessage } from './errors.ts';
import { buildLimaConfig, limaPortForwards, METRICS_SCRIPT, INSTALL_AGENT_SCRIPT, UBUNTU_IMAGE } from './lima-config.ts';
import { proxyUrl } from './validation.ts';
import { GUARD_VERSION, INSTALL_GUARD_SCRIPT, INSPECT_GUARD_SCRIPT, applyGuardScript, firewallRules, guestEnvironment, identityScript, linuxLocales, shellQuote } from './network-guard.ts';
import { LEASE_HELPER_PATH, LEASE_RECIPE, leaseRules, leaseFiles, leaseBootHash } from './guest-lease.ts';
import { SING_BOX_VERSION, SING_BOX_SHA256, SING_BOX_ARCHIVE, SING_BOX_URL, installTransparentScript, startTransparentScript, STOP_TRANSPARENT_SCRIPT, transparentConfig } from './transparent-network.ts';
import { PREPARE_BASE_SCRIPT, CLEAN_BASE_SCRIPT, FINISH_BOOT_CAPTURE_SCRIPT, allBaseLocales, baseDiskHash } from './protected-base.ts';
import { PREPARE_DEVELOPER_SCRIPT } from './guest-privileges.ts';
import { inspectSharedMountsScript, installSharedMountPoliciesScript, parseSharedMountInspection, sharedMountBootScript, sharedMounts } from './guest-mounts.ts';
import { networkdBootFingerprint } from './guest-networkd.ts';
import { GUEST_TASK_RUN, GUEST_TASK_CANCEL } from './guest-task.ts';
import { wireguardStateHash } from './wireguard.ts';
import { loadImportSeed, markImportReady, readImportSeed } from './import-seed.ts';
import { environmentWireguard, startWireguardScript, STOP_WIREGUARD_SCRIPT, wireguardDnsConfig, wireguardBootHash, INSPECT_WIREGUARD_PYTHON } from './wireguard-network.ts';
import { ProxyTransports, type ProxyTransportIdentity } from './proxy-transport.ts';

const LIMA_VERSION = '2.2.0';
const LIMA_SHA256 = 'bbdef91774885a0d05f7b048c4eb89ae2bcf3a0c252ae7ca7934e63df76d93c3';

export function parseLimaList(output: string): { name: string; status: string }[] {
  if (!output.trim()) return [];
  if (output.trim().startsWith('[')) return JSON.parse(output);
  return output.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
}

export class LimaRuntime {
  dataDir: string;
  limaHome: string;
  runner: Runner;
  preparingBase: Promise<Environment> | null = null;
  leaseSessions = new Map<string,string>();
  proxyTransports: ProxyTransports;
  private probePorts = new Map<string, number>();
  constructor(dataDir: string, runner: Runner = run) {
    this.dataDir = dataDir;
    this.limaHome = path.join(dataDir, 'lima');
    this.runner = runner;
    this.proxyTransports = new ProxyTransports(this.limaHome);
  }
  async executable() {
    const candidates = [process.env.MU_LIMA_PATH, path.join(this.dataDir, 'tools/lima/bin/limactl'), '/opt/homebrew/bin/limactl', '/usr/local/bin/limactl'];
    for (const candidate of candidates) {
      if (!candidate || !path.isAbsolute(candidate)) continue;
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* Check the next known location. */ }
    }
    return null;
  }
  env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, LIMA_HOME: this.limaHome, TERM: 'xterm-256color', LC_ALL: 'en_US.UTF-8' };
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'MU_SESSION_TOKEN']) delete env[key];
    return env;
  }
  async command(args: string[], options: RunOptions = {}) {
    const executable = await this.executable();
    if (!executable) throw new AppError('请先在系统设置中安装 Lima 运行组件', 409, 'RUNTIME_MISSING');
    await mkdir(this.limaHome, { recursive: true, mode: 0o700 });
    return this.runner(executable, ['--tty=false', ...args], { ...options, env: this.env() });
  }
  async info() {
    const executable = await this.executable();
    if (!executable) return { available: false, path: null, version: null, error: null };
    try { return { available: true, path: executable, version: (await this.runner(executable, ['--version'], { timeoutMs: 5000, env: this.env() })).trim(), error: null }; }
    catch (error) { return { available: false, path: executable, version: null, error: errorMessage(error) }; }
  }
  async install(options: RunOptions = {}) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new AppError('此版本的运行组件安装器支持 Apple Silicon Mac');
    const staging = path.join(this.dataDir, 'tools', `lima-staging-${randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const archive = path.join(staging, 'runtime.tar.gz');
    try {
      options.onOutput?.(`Downloading Lima ${LIMA_VERSION} from the official release\n`);
      await this.runner('/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--max-time', '300', '--output', archive, `https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/lima-${LIMA_VERSION}-Darwin-arm64.tar.gz`], { ...options, timeoutMs: 330_000 });
      const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
      if (hash !== LIMA_SHA256) throw new AppError('Lima 下载校验失败，未安装此文件', 500, 'CHECKSUM_MISMATCH');
      options.onOutput?.('SHA-256 verified. Extracting runtime.\n');
      const extracted = path.join(staging, 'unpacked');
      await mkdir(extracted);
      await this.runner('/usr/bin/tar', ['-xzf', archive, '-C', extracted], options);
      const target = path.join(this.dataDir, 'tools/lima');
      if (await this.executable() === path.join(target, 'bin/limactl')) return;
      await rename(extracted, target);
      options.onOutput?.('Lima installed.\n');
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  async list() { return parseLimaList(await this.command(['list', '--json'], { timeoutMs: 10_000 })); }
  async diskMaintenancePending(e: Environment) {
    return lstat(path.join(this.dataDir, 'disk-recovery', e.id, 'journal.json')).then(() => true, error => {
      if (error.code === 'ENOENT') return false; throw error;
    });
  }
  private guardFile(e: Environment) { return path.join(this.dataDir, 'security', `${e.instanceName}.json`); }
  private sharedMountFile(e: Environment) { return path.join(this.dataDir, 'security', `${e.instanceName}-shares.json`); }
  private sharedMountRecipe(e: Environment) { return createHash('sha256').update(sharedMountBootScript(e)).digest('hex'); }
  async sharedMountMaintenancePending(e: Environment) {
    const file = path.join(this.dataDir, 'security', `${e.instanceName}-shares-migration.json`);
    try {
      const value = z.object({ version: z.literal(1), instanceName: z.literal(e.instanceName), original: z.string(), stage: z.enum(['pending', 'completed']) }).passthrough()
        .parse(JSON.parse(await readFile(file, 'utf8')));
      return value.stage === 'pending';
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async migrateSharedMounts(e: Environment, options: RunOptions = {}) {
    if (!e.mounts.length) return;
    const instance = (await this.list()).find(row => row.name === e.instanceName);
    if (instance?.status !== 'Stopped') throw new AppError('共享目录迁移只能在环境停止后进行', 409, 'SHARED_MOUNT_MIGRATION_STATE');
    const file = path.join(this.limaHome, e.instanceName, 'lima.yaml');
    const journal = path.join(this.dataDir, 'security', `${e.instanceName}-shares-migration.json`);
    await mkdir(path.dirname(journal), { recursive: true, mode: 0o700 });
    const pending = await readFile(journal, 'utf8').then(raw => JSON.parse(raw)).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (pending && (pending.version !== 1 || pending.instanceName !== e.instanceName || typeof pending.original !== 'string' || !['pending', 'completed'].includes(pending.stage))) {
      throw new AppError('共享目录迁移记录无效，启动已拒绝', 409, 'SHARED_MOUNT_MIGRATION_JOURNAL');
    }
    const original = pending?.stage === 'pending' ? pending.original : await readFile(file, 'utf8');
    const configuration = parse(original);
    const next = parse(buildLimaConfig(e));
    const maintenance = parse(buildLimaConfig({ ...e, mounts: [] }));
    if (configuration.rosetta) maintenance.rosetta = configuration.rosetta;
    if (configuration.vmOpts) maintenance.vmOpts = configuration.vmOpts;
    if (configuration.firmware) maintenance.firmware = configuration.firmware;
    const replace = async (target: string, bytes: string) => {
      const temporary = `${target}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, target); }
      finally { await rm(temporary, { force: true }); }
    };
    await replace(journal, JSON.stringify({ version: 1, instanceName: e.instanceName, original, stage: 'pending' }));
    // Remove exports and old provisioning together. A resumed maintenance boot
    // cannot execute original provisioning against shared host files.
    await replace(file, stringify(maintenance));
    let stopped = false;
    try {
      options.onOutput?.('Preparing shared-directory isolation without exporting host projects\n');
      await this.command(['start', '--timeout', '15m', e.instanceName], { ...options, timeoutMs: 950_000 });
      const listed = parseLimaList(await this.command(['list', '--json'], { ...options, timeoutMs: 15_000 })) as { name: string; status: string; config?: { mounts?: unknown[] } }[];
      const actual = listed.find(row => row.name === e.instanceName);
      if (actual?.status !== 'Running' || !actual.config || (actual.config.mounts?.length ?? 0) !== 0) {
        throw new AppError('维护环境仍提供共享目录，迁移已拒绝', 409, 'SHARED_MOUNT_MIGRATION_EXPORTS');
      }
      const bare = { ...e, mounts: [] };
      const output = await this.management(bare, ['bash', '-s'], { ...options, input: installSharedMountPoliciesScript(e), timeoutMs: 30_000 });
      const measured = z.object({ maintenanceSources: z.array(z.literal('vz-rosetta')), policiesInstalled: z.literal(e.mounts.length) }).strict()
        .parse(JSON.parse(output.split('\n').find(line => line.startsWith('{')) ?? '{}'));
      const inspection = parseSharedMountInspection(await this.management(bare, ['bash', '-s'], { ...options, input: inspectSharedMountsScript(e, false), timeoutMs: 15_000 }));
      if (inspection.issues.length) throw new AppError('共享目录开机策略安装未通过核验', 409, 'SHARED_MOUNT_MIGRATION_POLICY');
      await this.stop(bare, options); stopped = (await this.list()).find(row => row.name === e.instanceName)?.status === 'Stopped';
      if (!stopped) throw new AppError('维护环境未停止，宿主项目不会恢复共享', 409, 'SHARED_MOUNT_MIGRATION_STOP');
      await replace(file, stringify({ ...configuration, ...next }));
      await replace(this.sharedMountFile(e), JSON.stringify({ version: 1, recipe: this.sharedMountRecipe(e), preparedWithoutShares: true, ...measured }));
      await replace(journal, JSON.stringify({ version: 1, instanceName: e.instanceName, original, stage: 'completed', ...measured, finishedAt: new Date().toISOString() }));
    } catch (error) {
      stopped = false;
      try { await this.command(['stop', '--force', e.instanceName], { timeoutMs: 120_000 }); stopped = (await this.list()).find(row => row.name === e.instanceName)?.status === 'Stopped'; }
      catch { /* Keep the no-share configuration when stopping is unverified. */ }
      if (stopped) await replace(file, original);
      throw error;
    }
  }
  private async approveSharedMountBoot(e: Environment, options: RunOptions) {
    if (!e.mounts.length) return;
    const text = await this.management(e, ['cat', '/run/mucodesandbox-shares/boot.json'], { ...options, timeoutMs: 15_000 });
    const rows = z.array(z.object({ target: z.string(), alreadyMounted: z.boolean(), previousOptions: z.string().nullable() }).strict()).parse(JSON.parse(text));
    if (rows.length !== e.mounts.length || rows.some((row, i) => row.target !== sharedMounts(e)[i].target ||
        row.alreadyMounted && !['nosuid', 'nodev'].every(flag => row.previousOptions?.split(',').includes(flag)))) {
      throw new AppError('共享目录在本次启动早期没有安全隔离，环境不会开放', 409, 'SHARED_MOUNT_UNSAFE_BOOT');
    }
    const file = this.sharedMountFile(e); const temporary = `${file}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, recipe: this.sharedMountRecipe(e), boot: rows }), { mode: 0o600 });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  private async guardMarker(e: Environment): Promise<{ version?: number; prepared: boolean; bootArmed: boolean; conservative?: boolean; expectedHash?: string; bootFileHash?: string; tunnelConfigHash?: string; expectedLeaseHash?: string; leaseBootHash?: string; proxyTransport?: ProxyTransportIdentity }> {
    try { return JSON.parse(await readFile(this.guardFile(e), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { prepared: false, bootArmed: false }; throw error; }
  }
  private async saveGuard(e: Environment, bootArmed: boolean, conservative: boolean, expectedHash: string, bootFileHash: string, tunnelConfigHash = '', proxyTransport?: ProxyTransportIdentity) {
    const file = this.guardFile(e);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const next = `${file}.${randomUUID()}.tmp`;
    await writeFile(next, JSON.stringify({ ...(await this.guardMarker(e)), version: GUARD_VERSION, prepared: true, bootArmed, conservative, expectedHash, bootFileHash, tunnelConfigHash,
      ...(conservative ? { proxyTransport: undefined } : proxyTransport ? { proxyTransport } : {}) }), { mode: 0o600 });
    await rename(next, file);
  }
  private basicArgs(e: Environment, command: string[], withProxy = false) {
    const vars = ['PATH=/home/mu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'TERM=xterm-256color', `TZ=${e.identity.timezone}`, `LANG=${linuxLocales[e.identity.locale]}`, `LC_ALL=${linuxLocales[e.identity.locale]}`];
    const proxy = withProxy ? proxyUrl(e.network, true) : '';
    if (proxy) for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) vars.push(`${name}=${proxy}`);
    vars.push(`NO_PROXY=${e.network.noProxy}`, `no_proxy=${e.network.noProxy}`);
    return ['shell', '--workdir', '/workspace', e.instanceName, 'env', ...vars, ...command];
  }
  private async gateway(e: Environment) {
    const output = await this.command(this.basicArgs(e, ['ip', '-4', 'route', 'show', 'default']), { timeoutMs: 15_000 });
    const gateway = output.match(/default via (\S+)/)?.[1];
    if (!gateway || !isIPv4(gateway)) throw new AppError('无法确认 Linux 网络网关，拒绝启用防护', 409);
    return gateway;
  }
  async networkProtection(e: Environment, requireLease = true): Promise<NetworkProtection> {
    const policy = e.network.mode === 'wireguard' ? 'packet-tunnel' : e.network.transparent ? 'transparent' : e.network.strict ? 'proxy-only' : e.network.mode === 'direct' ? 'direct' : 'application-proxy';
    const marker = await this.guardMarker(e);
    if (e.state !== 'running') return { prepared: marker.prepared, bootArmed: marker.bootArmed, active: false, firewallActive: false, transparentReady: false, transparentActive: false, integrity: 'inactive', issues: [], policy, proxyEndpoints: [], blockedPackets: 0, checkedAt: new Date().toISOString() };
    const output = await this.command(this.basicArgs(e, ['bash', '-s']), { input: INSPECT_GUARD_SCRIPT.replace('# MU_PACKET_STATUS', INSPECT_WIREGUARD_PYTHON), timeoutMs: 15_000 });
    const actual = z.object({ prepared: z.boolean(), bootArmed: z.boolean(), active: z.boolean(), firewallActive: z.boolean(), transparentReady: z.boolean(), transparentActive: z.boolean(), proxyEndpoints: z.array(z.string()), blockedPackets: z.number(), checkedAt: z.string(), firewallHash: z.string(), bootFileHash: z.string(), tunnelConfigHash: z.string(), routingReady: z.boolean(), dnsGuardActive: z.boolean(), leasePrepared: z.boolean().default(false), leaseActive: z.boolean().default(false), leaseRemainingMs: z.number().nonnegative().default(0), leaseRulesHash: z.string().default(''), leaseBootHash: z.string().default(''), wireguardStateHash: z.string().default(''), wireguardBootHash: z.string().default(''), wireguardHandshakeAge: z.number().default(-1) }).parse(JSON.parse(output.split('\n').find(line => line.startsWith('{')) ?? '{}'));
    const integrity = !marker.expectedHash ? 'unverified' : actual.firewallHash === marker.expectedHash && actual.bootFileHash === marker.bootFileHash ? 'verified' : 'changed';
    const issues: string[] = [];
    if (e.mounts.length) {
      const shares = parseSharedMountInspection(await this.command(this.basicArgs(e, ['bash', '-s']), { input: inspectSharedMountsScript(e), timeoutMs: 15_000 }));
      if (!Array.isArray(shares.issues) || shares.issues.length) issues.push('共享目录的权限隔离未通过核验');
    }
    if (e.network.strict) {
      if (!actual.firewallActive) issues.push('默认拒绝防火墙未生效');
      if (!actual.bootArmed) issues.push('开机防护依赖失效');
      if (!actual.leasePrepared || !marker.expectedLeaseHash || actual.leaseRulesHash !== marker.expectedLeaseHash || !marker.leaseBootHash || actual.leaseBootHash !== marker.leaseBootHash) issues.push('自动断网许可的规则或开机配置未通过核验');
      if (requireLease && !actual.leaseActive) issues.push('自动断网许可未启用或已过期，请重新启动环境');
      if (integrity !== 'verified') issues.push(integrity === 'changed' ? '实际或开机网络策略与宿主批准内容不一致' : '规则尚未由宿主核验');
      if (e.network.transparent) {
        if (!actual.transparentActive || !actual.routingReady) issues.push(e.network.mode === 'wireguard' ? '整包隧道服务或路由未生效' : '透明代理服务或路由未生效');
        if (!actual.dnsGuardActive) issues.push('受控 DNS 配置失效');
        if (!marker.tunnelConfigHash || actual.tunnelConfigHash !== marker.tunnelConfigHash) issues.push('网络转发配置与宿主批准内容不一致');
        if (marker.proxyTransport && !this.proxyTransports.matches(e.id, marker.proxyTransport)) issues.push('宿主代理通道已关闭，请重新启动环境');
      }
      if (e.network.mode === 'wireguard') {
        const config = environmentWireguard(e);
        if (actual.wireguardStateHash !== wireguardStateHash(config)) issues.push('内核隧道的设备、密钥或端点与批准配置不一致');
        if (actual.wireguardBootHash !== wireguardBootHash(e)) issues.push('内核隧道文件或权限未通过核验');
        if (actual.wireguardHandshakeAge < 0 || actual.wireguardHandshakeAge > 180) issues.push('隧道对端握手已失效');
      }
    }
    return { ...actual, integrity, issues, active: actual.firewallActive && (!e.network.strict || issues.length === 0), policy };
  }
  private async configureLease(e: Environment, options: RunOptions = {}) {
    const gateway = await this.gateway(e);
    await this.command(this.basicArgs(e,['bash','-s']), { ...options, input: `set -eu\nif ! id mu-probe >/dev/null 2>&1; then sudo useradd --system --no-create-home --shell /usr/sbin/nologin mu-probe; fi\n`, timeoutMs:15_000 });
    const uid = async (user: string) => Number((await this.command(this.basicArgs(e,['id','-u',user]),{...options,timeoutMs:15_000})).trim());
    const packet = e.network.mode === 'wireguard' ? environmentWireguard(e) : undefined;
    const rules = leaseRules(gateway,await uid('systemd-network'),await uid('mu-probe'),!packet && (e.network.transparent || e.id === '00000000-0000-4000-8000-000000000001') ? await uid('mu-net') : undefined,packet);
    const session = randomUUID();
    const script = `set -euo pipefail
sudo install -d -m 0755 /etc/mucodesandbox /usr/local/libexec /etc/systemd/system/mucodesandbox-egress.service.d
sudo install -d -o root -g root -m 0700 /run/mucodesandbox-lease
${Object.entries(leaseFiles(rules)).map(([file,content])=>`printf '%s' ${shellQuote(content)} | sudo tee ${file}.next >/dev/null\nsudo chown root:root ${file}.next\nsudo chmod ${file===LEASE_HELPER_PATH ? '0700' : '0600'} ${file}.next\nsudo mv ${file}.next ${file}`).join('\n')}
sudo nft --check -f /etc/mucodesandbox/lease.nft
sudo systemctl daemon-reload
sudo systemctl enable mucodesandbox-lease.service >/dev/null
sudo systemctl restart mucodesandbox-lease.service
sudo python3 - <<'MU_LEASE_STATE'
import json, os
os.umask(0o077)
with open('/proc/sys/kernel/random/boot_id') as f: boot = f.read().strip()
with open('/run/mucodesandbox-lease/state', 'w') as f: json.dump({'session':${JSON.stringify(session)},'boot':boot,'state':'pending','deadline':0},f)
MU_LEASE_STATE
`;
    await this.command(this.basicArgs(e,['bash','-s']),{...options,input:script,timeoutMs:30_000});
    const inspected=await this.networkProtection({...e,state:'running'},false);
    const expected=leaseBootHash(rules);
    if(!inspected.leasePrepared || inspected.leaseBootHash!==expected || !inspected.leaseRulesHash) throw new AppError('自动断网许可安装未通过核验',500,'LEASE_FAILED');
    const file=this.guardFile(e);
    await mkdir(path.dirname(file),{recursive:true,mode:0o700});
    const next=`${file}.${randomUUID()}.tmp`;
    await writeFile(next,JSON.stringify({...(await this.guardMarker(e)),expectedLeaseHash:inspected.leaseRulesHash,leaseBootHash:expected}),{mode:0o600});
    await rename(next,file);this.leaseSessions.set(e.id,session);
  }
  async renewLease(e: Environment, activate=false, options: RunOptions = {}) {
    if(!e.network.strict)return;
    const session=this.leaseSessions.get(e.id);
    if(!session)throw new AppError('自动断网许可的管理会话已失效，请重新启动环境',409,'LEASE_FAILED');
    await this.command(this.basicArgs(e,['sudo',LEASE_HELPER_PATH,activate?'activate':'renew',session]),{...options,timeoutMs:15_000});
  }
  async revokeLease(e: Environment) {
    this.probePorts.delete(e.id);
    const session=this.leaseSessions.get(e.id);this.leaseSessions.delete(e.id);
    try { if(session)await this.command(this.basicArgs(e,['sudo',LEASE_HELPER_PATH,'revoke',session]),{timeoutMs:15_000}); }
    finally { await this.proxyTransports.close(e.id); }
  }
  egressProbeProxy(e: Environment) {
    const port = this.probePorts.get(e.id);
    if (!port) {
      if(e.network.egressLock && e.network.transparent && e.network.mode!=='wireguard')
        throw new AppError('出口检测代理通道未就绪或已关闭',409,'PROXY_TRANSPORT_CLOSED');
      return '';
    }
    const transport = this.proxyTransports.entries.get(e.id);
    if (!transport || !this.proxyTransports.matches(e.id, transport)) throw new AppError('出口检测代理通道已关闭', 409, 'PROXY_TRANSPORT_CLOSED');
    // The local controlled listener resolves names. curl's own DoH request
    // must not try to dial externally while the business lease is closed.
    return `socks5h://127.0.0.1:${port}`;
  }
  private async configureGuard(e: Environment, proxyIPs: string[], enabled: boolean, options: RunOptions = {}, transparentUid?: number, packet = false, relayPort?: number, probe?: { port: number; uid: number }) {
    options.onOutput?.('Checking the management gateway before applying network rules.\n');
    const gateway = await this.gateway(e);
    const networkUid = Number((await this.command(this.basicArgs(e, ['id', '-u', 'systemd-network']), { ...options, timeoutMs: 15_000 })).trim());
    if (!Number.isSafeInteger(networkUid) || networkUid < 1) throw new AppError('无法确认系统网络服务身份，拒绝启用防护', 409);
    const config = packet ? environmentWireguard(e) : undefined;
    const rules = firewallRules(proxyIPs, e.network.port, e.ports.map(p => p.guestPort), gateway, transparentUid, networkUid,config,relayPort,probe);
    const endpoints = config ? [`${config.endpoint.address}:${config.endpoint.port}`] : proxyIPs.map(ip => `${ip}:${e.network.port}`);
    const proxy = proxyIPs.length ? proxyUrl({ ...e.network, host: proxyIPs[0] }) : enabled ? '' : proxyUrl(e.network, true);
    await this.command(this.basicArgs(e, ['bash', '-s']), { ...options, input: applyGuardScript(rules, endpoints, guestEnvironment(e, proxy), enabled), timeoutMs: 30_000 });
    options.onOutput?.('Inspecting applied firewall and boot dependencies.\n');
    const status = await this.networkProtection({ ...e, state: 'running' });
    if (enabled && (!status.firewallActive || !status.bootArmed)) throw new AppError('Linux 防火墙未生效，环境不会开放', 500, 'GUARD_FAILED');
    const bootFingerprint = networkdBootFingerprint(createHash('sha256').update(rules).digest('hex'));
    if (enabled && (proxyIPs.length || packet) && status.bootFileHash !== bootFingerprint) throw new AppError('系统网络组件未采用受保护的路由策略，环境不会开放', 500, 'GUARD_FAILED');
    await this.saveGuard(e, enabled, enabled && proxyIPs.length === 0 && !packet, status.firewallHash ?? '', bootFingerprint);
  }
  private async installTransparent(e: Environment, options: RunOptions) {
    const installed = await this.command(this.basicArgs(e, ['bash', '-c', '/usr/local/bin/mu-sing-box version 2>/dev/null || true']), { ...options, timeoutMs: 15_000 });
    if (!installed.split('\n').some(line => line.trim() === `sing-box version ${SING_BOX_VERSION}`)) {
      const cache = path.join(this.dataDir, 'tools', 'sing-box');
      await mkdir(cache, { recursive: true, mode: 0o700 });
      const archive = path.join(cache, SING_BOX_ARCHIVE);
      let valid = false;
      try { valid = createHash('sha256').update(await readFile(archive)).digest('hex') === SING_BOX_SHA256; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!valid) {
        const next = `${archive}.${randomUUID()}.tmp`;
        try {
          options.onOutput?.(`Downloading sing-box ${SING_BOX_VERSION} from the official release\n`);
          await this.runner('/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--max-time', '300', '--output', next, SING_BOX_URL], { ...options, timeoutMs: 330_000, env: this.env() });
          if (createHash('sha256').update(await readFile(next)).digest('hex') !== SING_BOX_SHA256) throw new AppError('透明代理组件下载校验失败，环境不会开放', 500, 'CHECKSUM_MISMATCH');
          await rename(next, archive);
        } finally { await rm(next, { force: true }); }
      }
      const guestArchive = `/tmp/mu-network-${randomUUID()}.tar.gz`;
      await this.command(['copy', archive, `${e.instanceName}:${guestArchive}`], { ...options, timeoutMs: 60_000 });
      await this.command(this.basicArgs(e, ['bash', '-s']), { ...options, input: installTransparentScript(guestArchive), timeoutMs: 60_000 });
    }
    const uid = Number((await this.command(this.basicArgs(e, ['id', '-u', 'mu-net']), { ...options, timeoutMs: 15_000 })).split('\n').find(line => /^\d+$/.test(line.trim())));
    if (!Number.isInteger(uid) || uid < 1) throw new AppError('无法确认透明代理服务身份，环境不会开放', 500, 'TUNNEL_FAILED');
    return uid;
  }
  async prepareNetwork(e: Environment, options: RunOptions = {}) {
    if (e.state !== 'running') throw new AppError('请先启动旧环境，准备防护后会自动停止', 409);
    try {
      await this.revokeLease(e);
      if (e.mounts.length) {
        const shares = parseSharedMountInspection(await this.management(e, ['bash', '-s'], { ...options, input: inspectSharedMountsScript(e), timeoutMs: 15_000 }));
        if (!Array.isArray(shares.issues) || shares.issues.length) throw new AppError('共享目录未安全挂载，环境不会开放', 409, 'SHARED_MOUNT_UNSAFE');
      }
      await this.management(e, ['bash', '-s'], { ...options, input: PREPARE_DEVELOPER_SCRIPT, timeoutMs: 30_000 });
      await this.command(this.basicArgs(e, ['bash', '-s'], true), { ...options, input: INSTALL_GUARD_SCRIPT, timeoutMs: 300_000 });
      await this.configureGuard(e, [], true, options);
      if(!(await this.networkProtection({...e,state:'running'},false)).leasePrepared)await this.configureLease(e,options);
      await this.command(this.basicArgs(e, ['bash', '-s']), { ...options, input: STOP_TRANSPARENT_SCRIPT, timeoutMs: 30_000 });
      await this.command(this.basicArgs(e, ['bash', '-s']), { ...options, input: STOP_WIREGUARD_SCRIPT, timeoutMs: 30_000 });
    } catch (error) { await this.command(['stop', '--force', e.instanceName], { timeoutMs: 120_000 }).catch(() => {}); throw error; }
    try { await this.command(['stop', e.instanceName], { timeoutMs: 120_000 }); }
    catch (error) { await this.command(['stop', '--force', e.instanceName], { timeoutMs: 120_000 }).catch(() => {}); throw error; }
  }
  private async protectedBase(options: RunOptions) {
    if (this.preparingBase) return this.preparingBase;
    this.preparingBase = (async () => {
      const base: Environment = { id: '00000000-0000-4000-8000-000000000001', instanceName: 'mu-protected-base-v1', name: 'Trusted protected base', description: '', kind: 'vm', color: 'green', cpus: 2, memoryGiB: 2, diskGiB: 10, mounts: [], ports: [], network: { mode: 'direct', host: '', port: 7890, username: '', noProxy: '', strict: false, transparent: false }, identity: { timezone: 'UTC', locale: 'en-US' }, browserUrl: 'https://example.com', state: 'stopped', lastError: null, browserRunning: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const packetTools = `set -eu\nsudo apt-get update -qq\nsudo apt-get install -y -qq wireguard-tools\n`;
      const recipe = createHash('sha256').update(String(GUARD_VERSION) + LEASE_RECIPE + buildLimaConfig(base) + INSTALL_GUARD_SCRIPT + PREPARE_BASE_SCRIPT + CLEAN_BASE_SCRIPT + PREPARE_DEVELOPER_SCRIPT + allBaseLocales(base) + SING_BOX_SHA256 + packetTools).digest('hex');
      const directory = path.join(this.dataDir, 'tools', 'protected-base');
      const file = path.join(directory, 'manifest.json');
      const key = await readFile(path.join(this.dataDir, 'credentials.key'));
      const sign = (body: string) => createHmac('sha256', key).update('MuCodeSandbox protected base v1\n').update(body).digest('hex');
      let valid = false;
      const instance = (await this.list()).find(i => i.name === base.instanceName);
      if (instance?.status === 'Stopped') {
        try {
          const signed = z.object({ body: z.string(), mac: z.string() }).parse(JSON.parse(await readFile(file, 'utf8')));
          const manifest = z.object({ version: z.literal(1), recipe: z.string(), image: z.string(), hash: z.string() }).parse(JSON.parse(signed.body));
          valid = signed.mac === sign(signed.body) && manifest.recipe === recipe && manifest.image === UBUNTU_IMAGE.digest && manifest.hash === await baseDiskHash(path.join(this.limaHome, base.instanceName, 'disk'), options.signal);
        } catch (error) { if (options.signal?.aborted) throw error; }
      }
      if (valid) { const marker = await this.guardMarker(base); if (marker.prepared && marker.bootArmed && marker.conservative) return base; }
      options.onOutput?.('Preparing a trusted base image. No accounts or project folders are present.\n');
      if (instance) await this.remove(base, options);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const config = path.join(directory, 'base.yaml');
      await writeFile(config, buildLimaConfig(base), { mode: 0o600 });
      try {
        await this.command(['start', '--name', base.instanceName, '--timeout', '15m', config], { ...options, timeoutMs: 950_000 });
        await this.management(base, ['bash', '-s'], { ...options, input: PREPARE_DEVELOPER_SCRIPT, timeoutMs: 30_000 });
        await this.command(this.basicArgs(base, ['bash', '-s']), { ...options, input: INSTALL_GUARD_SCRIPT + '\n' + allBaseLocales(base), timeoutMs: 300_000 });
        await this.installTransparent(base, options);
        await this.command(this.basicArgs(base, ['bash','-s']), { ...options, input: packetTools, timeoutMs: 300_000 });
        await this.command(this.basicArgs(base, ['bash', '-s']), { ...options, input: PREPARE_BASE_SCRIPT, timeoutMs: 300_000 });
        options.onOutput?.('Base management socket identities:\n');
        await this.command(this.basicArgs(base, ['sudo', 'ss', '-tnpe']), { ...options, timeoutMs: 15_000 });
        await this.configureLease(base,options);
        await this.configureGuard(base, [], true, options);
        await this.command(this.basicArgs(base, ['bash', '-s']), { ...options, input: CLEAN_BASE_SCRIPT, timeoutMs: 30_000 });
        options.onOutput?.('Stopping the verified base before sealing its disk.\n');
        await this.command(['stop', base.instanceName], { ...options, timeoutMs: 120_000 });
        const body = JSON.stringify({ version: 1, recipe, image: UBUNTU_IMAGE.digest, hash: await baseDiskHash(path.join(this.limaHome, base.instanceName, 'disk'), options.signal) });
        const next = `${file}.tmp`; await writeFile(next, JSON.stringify({ body, mac: sign(body) }), { mode: 0o600 }); await rename(next, file);
        options.onOutput?.('Protected base verified. User environments boot with an armed default-deny guard.\n');
        return base;
      } catch (error) { await this.command(['stop', '--force', base.instanceName], { timeoutMs: 120_000 }).catch(() => {}); throw error; }
    })().finally(() => { this.preparingBase = null; });
    return this.preparingBase;
  }
  async start(e: Environment, options: RunOptions) {
    if (await this.diskMaintenancePending(e)) throw new AppError('磁盘维护尚未完成，请先重试扩容', 409, 'DISK_RECOVERY_PENDING');
    if (e.network.mode === 'wireguard') environmentWireguard(e);
    const instances = await this.list();
    let instance = instances.find(i => i.name === e.instanceName);
    const migration = await readFile(path.join(this.dataDir, 'security', `${e.instanceName}-shares-migration.json`), 'utf8').then(raw => JSON.parse(raw)).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (migration?.stage === 'pending' && instance?.status === 'Running') {
      options.onOutput?.('Stopping interrupted no-share maintenance before resuming migration\n');
      await this.command(['stop', '--force', e.instanceName], { ...options, timeoutMs: 120_000 });
      const actual = (await this.list()).find(row => row.name === e.instanceName);
      if (actual?.status !== 'Stopped') throw new AppError('中断的维护环境尚未停止，迁移不会开放共享', 409, 'SHARED_MOUNT_MIGRATION_STOP');
      instance = actual;
    }
    const imported = await readImportSeed(this.dataDir, e);
    if (imported && !imported.managementReady && instance?.status === 'Running') {
      await this.command(['stop', '--force', e.instanceName], { ...options, timeoutMs: 120_000 });
      instance = { ...instance, status: 'Stopped' };
    }
    let marker = await this.guardMarker(e);
    if (e.network.strict && instance && (!marker.prepared || !marker.bootArmed)) throw new AppError('旧环境须先以原网络启动，执行「准备防护并停止」，再启用仅代理联网', 409, 'GUARD_NOT_PREPARED');
    if (e.network.strict && instance && (marker.version??0)<GUARD_VERSION && !marker.conservative) throw new AppError('旧环境须先通过原版本停止，关闭旧代理端点后再升级防护',409,'GUARD_NOT_CONSERVATIVE');
    const localProxy = ['localhost', '127.0.0.1', '::1', 'host.lima.internal'].includes(e.network.host);
    const proxyIPs = e.network.strict && !localProxy && e.network.mode !== 'wireguard' ? (await lookup(e.network.host, { family: 4, all: true })).map(r => r.address) : [];
    if (instance?.status === 'Running') {
      if (e.mounts.length) {
        const shares = parseSharedMountInspection(await this.management(e, ['bash', '-s'], { ...options, input: inspectSharedMountsScript(e), timeoutMs: 15_000 }));
        if (shares.issues.length) throw new AppError('共享目录的权限隔离已失效，请停止环境', 409, 'SHARED_MOUNT_UNSAFE');
      }
      if (e.network.strict && !(await this.networkProtection({ ...e, state: 'running' })).active) throw new AppError('Linux 防火墙已失效，请停止后重新启动', 409, 'GUARD_FAILED');
      return;
    }
    try {
      if (instance) {
        if (e.mounts.length) {
          const installed = parse(await readFile(path.join(this.limaHome, e.instanceName, 'lima.yaml'), 'utf8'));
          const expected = parse(buildLimaConfig(e)).provision[0];
          const approved = await readFile(this.sharedMountFile(e), 'utf8').then(raw => JSON.parse(raw)).catch(error => {
            if (error.code === 'ENOENT') return null; throw error;
          });
          if (migration?.stage === 'pending' || approved?.recipe !== this.sharedMountRecipe(e) || !installed.provision?.some((item: unknown) => JSON.stringify(item) === JSON.stringify(expected))) {
            await this.migrateSharedMounts(e, options);
          }
        }
        await this.migratePortForwards(e);
        await this.command(['start', '--timeout', '15m', e.instanceName], { ...options, timeoutMs: 950_000 });
      }
      else {
        const seed = await loadImportSeed(this.dataDir, e, options.signal);
        if (seed) {
          options.onOutput?.('Creating a fresh VM identity from the verified imported disk\n');
          const file = path.join(this.dataDir, 'configs', `${e.instanceName}.yaml`);
          await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          const config = { ...parse(buildLimaConfig(e)), images: [{ location: seed.file, arch: 'aarch64', digest: `sha256:${seed.hash}` }] };
          await writeFile(file, stringify(config), { mode: 0o600 });
          if (seed.guard) {
            await mkdir(path.dirname(this.guardFile(e)), { recursive: true, mode: 0o700 });
            await writeFile(this.guardFile(e), JSON.stringify(seed.guard), { mode: 0o600 });
            marker = await this.guardMarker(e);
          }
          await this.command(['start', '--name', e.instanceName, '--timeout', '15m', file], { ...options, timeoutMs: 950_000 });
        } else if (e.network.strict) {
          const base = await this.protectedBase(options);
          await this.command(['clone', base.instanceName, e.instanceName, '--mount-none', '--cpus', String(e.cpus), '--memory', String(e.memoryGiB), '--disk', String(e.diskGiB)], { ...options, timeoutMs: 120_000 });
          await mkdir(path.dirname(this.guardFile(e)), { recursive: true, mode: 0o700 });
          await writeFile(this.guardFile(e), await readFile(this.guardFile(base)), { mode: 0o600 });
          marker = await this.guardMarker(e);
          await this.updateConfig(e);
          await this.command(['start', '--timeout', '15m', e.instanceName], { ...options, timeoutMs: 950_000 });
        } else {
        const file = path.join(this.dataDir, 'configs', `${e.instanceName}.yaml`);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, buildLimaConfig(e), { mode: 0o600 });
        await this.command(['start', '--name', e.instanceName, '--timeout', '15m', file], { ...options, timeoutMs: 950_000 });
        }
      }
      if (e.mounts.length) {
        const shares = parseSharedMountInspection(await this.management(e, ['bash', '-s'], { ...options, input: inspectSharedMountsScript(e), timeoutMs: 15_000 }));
        if (!Array.isArray(shares.issues) || shares.issues.length) throw new AppError('共享目录未安全挂载，环境不会开放', 409, 'SHARED_MOUNT_UNSAFE');
      }
      await this.management(e, ['bash', '-s'], { ...options, input: PREPARE_DEVELOPER_SCRIPT, timeoutMs: 30_000 });
      if (imported) {
        const publicKey = (await readFile(path.join(this.limaHome, '_config', 'user.pub'), 'utf8')).trim();
        if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(publicKey)) throw new AppError('本机管理公钥无效，导入环境不会开放', 409, 'BACKUP_MANAGEMENT_KEY');
        options.onOutput?.('Revoking previous host management keys before opening the imported environment\n');
        await this.management(e, ['bash', '-s'], { ...options, input: `set -eu
sudo install -d -o mu -g mu -m 0700 /home/mu/.ssh
printf '%s\\n' ${shellQuote(publicKey)} | sudo tee /home/mu/.ssh/authorized_keys.next >/dev/null
sudo chown mu:mu /home/mu/.ssh/authorized_keys.next
sudo chmod 0600 /home/mu/.ssh/authorized_keys.next
sudo mv /home/mu/.ssh/authorized_keys.next /home/mu/.ssh/authorized_keys
if sudo test -f /root/.ssh/authorized_keys; then sudo truncate -s 0 /root/.ssh/authorized_keys; fi
`, timeoutMs: 30_000 });
        const authorized = (await this.management(e, ['sudo', 'cat', '/home/mu/.ssh/authorized_keys'], { ...options, timeoutMs: 15_000 })).trim();
        if (authorized !== publicKey) throw new AppError('导入环境的管理密钥撤销未通过核验', 409, 'BACKUP_MANAGEMENT_KEY');
        await markImportReady(this.dataDir, e);
      }
      if (e.network.strict || marker.prepared) {
        if (!marker.prepared) await this.command(this.basicArgs(e, ['bash', '-s'], true), { ...options, input: INSTALL_GUARD_SCRIPT, timeoutMs: 300_000 });
        await this.command(this.basicArgs(e, ['bash', '-s']), { ...options, input: identityScript(e), timeoutMs: 300_000 });
        await this.configureGuard(e, [], true, options);
        await this.command(this.basicArgs(e, ['bash', '-s']), { ...options, input: STOP_TRANSPARENT_SCRIPT, timeoutMs: 30_000 });
        await this.command(this.basicArgs(e, ['bash', '-s']), { ...options, input: STOP_WIREGUARD_SCRIPT, timeoutMs: 30_000 });
        const endpoints = localProxy ? [await this.gateway(e)] : proxyIPs;
        if (e.network.mode === 'wireguard') {
          const tools = await this.command(this.basicArgs(e,['bash','-c','command -v wg || true']),{...options,timeoutMs:15_000});
          if (!tools.trim()) throw new AppError('此旧环境缺少整包隧道组件，请创建新环境；旧环境可先在原代理模式中安装 wireguard-tools 后再切换',409,'PACKET_TOOLS_MISSING');
          await this.installTransparent(e, options);
          await this.configureLease(e, options);
          await this.configureGuard(e, [], true, options, undefined, true);
          await this.command(this.basicArgs(e,['bash','-s']), { ...options, input: startWireguardScript(e), timeoutMs: 60_000 });
          const approved = await this.guardMarker(e);
          await this.saveGuard(e,true,false,approved.expectedHash ?? '',approved.bootFileHash ?? '',createHash('sha256').update(JSON.stringify(wireguardDnsConfig(e))).digest('hex'));
          const status = await this.networkProtection({...e,state:'running'},false);
          if (!status.active) throw new AppError(`整包隧道未通过启动核验：${status.issues?.join('；')}`,500,'TUNNEL_FAILED');
        } else if (e.network.transparent) {
          const uid = await this.installTransparent(e, options);
          await this.configureLease(e,options);
          const routesText = await this.command(this.basicArgs(e, ['ip', '-j', '-4', 'route', 'show']), { ...options, timeoutMs: 15_000 });
          const routes = JSON.parse(routesText.split('\n').find(line => line.startsWith('[')) ?? '[]') as { dst?: string; scope?: string }[];
          // Restrict the private listener before SSH is allowed to create it.
          const relayPort = Number((await this.management(e, ['python3', '-c', "import socket\nwith socket.socket() as s:\n s.bind(('127.0.0.1',0));print(s.getsockname()[1])"], { ...options, timeoutMs: 15_000 })).trim());
          if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) throw new AppError('无法预留私有代理端口', 500, 'PROXY_TRANSPORT_FAILED');
          const relayEnvironment = { ...e, network: { ...e.network, port: relayPort } };
          let probe: { port: number; uid: number } | undefined;
          if (e.network.egressLock) {
            const probeUid = Number((await this.management(e, ['id', '-u', 'mu-probe'], options)).trim());
            const probePort = Number((await this.management(e, ['python3', '-c', "import socket,sys\ns=socket.socket();s.bind(('127.0.0.1',int(sys.argv[1])))\np=socket.socket();p.bind(('127.0.0.1',0));print(p.getsockname()[1])", String(relayPort)], options)).trim());
            probe = { port: probePort, uid: probeUid };
          }
          await this.configureGuard(relayEnvironment, ['127.0.0.1'], true, options, uid, false, relayPort, probe);
          const transport = await this.proxyTransports.open(e.id, e.instanceName, localProxy ? '127.0.0.1' : endpoints[0], e.network.port, options, relayPort);
          const tunnel = transparentConfig(relayEnvironment, '127.0.0.1', uid, routes.filter(r => r.scope === 'link' && r.dst?.includes('/')).map(r => r.dst!), probe?.port);
          await this.command(this.basicArgs(e, ['bash', '-s']), { ...options, input: startTransparentScript(tunnel), timeoutMs: 60_000 });
          const approved = await this.guardMarker(e);
          await this.saveGuard(e, true, false, approved.expectedHash ?? '', approved.bootFileHash ?? '', createHash('sha256').update(JSON.stringify(tunnel)).digest('hex'), transport);
          if (probe) this.probePorts.set(e.id, probe.port);
          if (!(await this.networkProtection({ ...e, state: 'running' },false)).active) throw new AppError('透明代理未生效，环境不会开放', 500, 'TUNNEL_FAILED');
        } else {
          if(e.network.strict)await this.configureLease(e,options);
          else await this.command(this.basicArgs(e,['bash','-c','sudo systemctl disable --now mucodesandbox-lease.service 2>/dev/null || true; sudo nft delete table inet mu_lease 2>/dev/null || true']),{...options,timeoutMs:15_000});
          await this.configureGuard(e, endpoints, e.network.strict, options);
        }
      }
      if (!e.network.strict && !marker.prepared) await this.management(e, ['bash', '-s'], { ...options, input: identityScript(e), timeoutMs: 300_000 });
      await this.approveSharedMountBoot(e, options);
      if (e.network.strict) await this.command(this.basicArgs(e, ['bash', '-s']), { ...options, input: FINISH_BOOT_CAPTURE_SCRIPT, timeoutMs: 15_000 });
    } catch (error) {
      if (e.network.strict) {
        await this.revokeLease(e).catch(() => {});
        await this.configureGuard(e, [], true, {}).then(() => this.command(this.basicArgs(e,['bash','-s']), { input: STOP_TRANSPARENT_SCRIPT + '\n' + STOP_WIREGUARD_SCRIPT, timeoutMs: 30_000 })).catch(() => {});
      }
      await this.command(['stop', '--force', e.instanceName], { timeoutMs: 120_000 }).catch(() => {});
      throw error;
    }
  }
  async stop(e: Environment, options: RunOptions = {}) {
    await this.revokeLease(e).catch(()=>{});
    const instance = (await this.list()).find(i => i.name === e.instanceName);
    if (instance?.status === 'Running') {
      if ((await this.guardMarker(e)).prepared) {
        try {
          await this.configureGuard(e, [], true, options);
          await this.command(this.basicArgs(e, ['bash', '-s']), { ...options, input: STOP_TRANSPARENT_SCRIPT, timeoutMs: 30_000 });
          await this.command(this.basicArgs(e, ['bash', '-s']), { ...options, input: STOP_WIREGUARD_SCRIPT, timeoutMs: 30_000 });
        }
        catch (error) { await this.command(['stop', '--force', e.instanceName], { timeoutMs: 120_000 }).catch(() => {}); throw error; }
      }
      await this.command(['stop', e.instanceName], { ...options, timeoutMs: 120_000 });
    }
  }
  async remove(e: Environment, options: RunOptions = {}) {
    await this.proxyTransports.close(e.id);
    const instance = (await this.list()).find(i => i.name === e.instanceName);
    if (instance) await this.command(['delete', '--force', e.instanceName], { ...options, timeoutMs: 120_000 });
    await rm(path.join(this.dataDir, 'configs', `${e.instanceName}.yaml`), { force: true });
    await rm(this.guardFile(e), { force: true });
    await rm(this.sharedMountFile(e), { force: true });
    await rm(path.join(this.dataDir, 'security', `${e.instanceName}-shares-migration.json`), { force: true });
  }
  async updateConfig(e: Environment) {
    if (await this.diskMaintenancePending(e)) throw new AppError('磁盘维护尚未完成，请先重试扩容', 409, 'DISK_RECOVERY_PENDING');
    const instances = await this.list();
    if (instances.some(i => i.name === e.instanceName && i.status === 'Running')) throw new AppError('请先停止环境再修改配置', 409);
    const marker = await this.guardMarker(e);
    if (e.network.strict && instances.some(i => i.name === e.instanceName) && (!marker.prepared || !marker.bootArmed)) throw new AppError('旧环境须先启动并执行「准备防护并停止」，再启用仅代理联网', 409, 'GUARD_NOT_PREPARED');
    if (e.network.strict && instances.some(i => i.name === e.instanceName) && !marker.conservative) throw new AppError('请先按原配置启动并通过应用停止，让开机策略关闭旧代理端点，再修改严格模式配置', 409, 'GUARD_NOT_CONSERVATIVE');
    const ownConfig = path.join(this.dataDir, 'configs', `${e.instanceName}.yaml`);
    await mkdir(path.dirname(ownConfig), { recursive: true, mode: 0o700 });
    await writeFile(ownConfig, buildLimaConfig(e), { mode: 0o600 });
    if (instances.some(i => i.name === e.instanceName)) {
      const installed = path.join(this.limaHome, e.instanceName, 'lima.yaml');
      const temporary = `${installed}.${randomUUID()}.tmp`;
      await writeFile(temporary, buildLimaConfig(e), { mode: 0o600 });
      await rename(temporary, installed);
    }
  }
  private async migratePortForwards(e: Environment) {
    const file = path.join(this.limaHome, e.instanceName, 'lima.yaml');
    const config = parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const expected = limaPortForwards(e);
    if (JSON.stringify(config.portForwards) === JSON.stringify(expected)) return;
    const next = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(next, stringify({ ...config, portForwards: expected }), { mode: 0o600 });
      await rename(next, file);
    } finally { await rm(next, { force: true }); }
  }
  guestArgs(e: Environment, command: string[], workdir = '/workspace') {
    const vars = ['PATH=/home/dev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/home/dev', 'USER=dev', 'LOGNAME=dev', 'SHELL=/bin/bash', 'TERM=xterm-256color', 'BROWSER=/usr/local/bin/mu-open-link', `TZ=${e.identity.timezone}`, `LANG=${linuxLocales[e.identity.locale]}`, `LC_ALL=${linuxLocales[e.identity.locale]}`];
    const proxy = !e.network.strict ? proxyUrl(e.network, true) : '';
    if (proxy) for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) vars.push(`${name}=${proxy}`);
    vars.push(`NO_PROXY=${e.network.noProxy}`, `no_proxy=${e.network.noProxy}`);
    const args = this.basicArgs(e, ['sudo', '-H', '-u', 'dev', '--', 'env', '-i', ...vars, ...(e.network.strict ? ['/usr/local/bin/mu-proxy-run'] : []), ...command]);
    args[2] = workdir;
    return args;
  }
  async management(e: Environment, command: string[], options: RunOptions = {}) {
    return this.command(this.basicArgs(e, e.network.strict ? ['sudo', '/usr/local/bin/mu-proxy-run', ...command] : command, !e.network.strict), options);
  }
  async guest(e: Environment, command: string[], options: RunOptions = {}) {
    if (e.state !== 'running') throw new AppError('请先启动 Linux 环境', 409, 'ENVIRONMENT_STOPPED');
    if (options.signal?.aborted) throw new AppError('操作已取消',409,'CANCELLED');
    const token=randomUUID(), timeoutMs=options.timeoutMs??30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs<=0 || timeoutMs>86_400_000) throw new AppError('开发任务超时时间无效',400);
    let cancellation: Promise<string>|undefined;
    const cancel=()=>{
      cancellation??=this.command(this.guestArgs(e,['python3','-c',GUEST_TASK_CANCEL,token]),{timeoutMs:8_000});
      // Await in finally; also handle rejection immediately while the main SSH exits.
      void cancellation.catch(()=>{});
    };
    options.signal?.addEventListener('abort',cancel,{once:true});
    try {
      return await this.command(this.guestArgs(e,['python3','-c',GUEST_TASK_RUN,token,String(timeoutMs),...command]),options);
    } catch(error) {
      if(error instanceof AppError && error.code==='PROCESS_FAILED' && error.message.includes('MU_GUEST_TASK_TIMEOUT')) {
        throw new AppError('操作超时，虚拟机中的开发任务已终止',504,'TIMEOUT');
      }
      if(error instanceof AppError && ['TIMEOUT','CANCELLED'].includes(error.code)) cancel();
      throw error;
    } finally {
      options.signal?.removeEventListener('abort',cancel);
      if(cancellation) await cancellation;
    }
  }
  async metrics(e: Environment): Promise<Metrics> {
    const output = await this.guest(e, ['bash', '-s'], { input: METRICS_SCRIPT, timeoutMs: 15_000 });
    return z.object({ cpuPercent: z.number().min(0).max(100), memoryUsedMiB: z.number().min(0), memoryTotalMiB: z.number().positive(), diskUsedGiB: z.number().min(0), diskTotalGiB: z.number().positive(), uptimeSeconds: z.number().min(0) }).parse(JSON.parse(output.split('\n').find(line => line.startsWith('{')) ?? '{}'));
  }
  async agentStatus(e: Environment): Promise<AgentStatus> {
    const text = await this.guest(e, ['bash', '-c', 'if command -v claude >/dev/null; then printf "CLAUDE="; claude --version; fi; if command -v node >/dev/null; then printf "NODE="; node --version; fi'], { timeoutMs: 15_000 });
    const version = text.match(/^CLAUDE=(.*)$/m)?.[1] ?? null;
    return { installed: Boolean(version), version, nodeVersion: text.match(/^NODE=(.*)$/m)?.[1] ?? null };
  }
  async installAgent(e: Environment, options: RunOptions) { return this.management(e, ['bash', '-s'], { ...options, input: INSTALL_AGENT_SCRIPT, timeoutMs: 900_000 }); }
}
