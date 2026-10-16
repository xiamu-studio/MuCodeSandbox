import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { Environment } from '../shared/types.ts';
import type { Store } from './store.ts';
import type { LimaRuntime } from './runtime.ts';
import type { RunOptions } from './process.ts';
import { AppError } from './errors.ts';
import { growGuestRootScript } from './guest-disk.ts';
import { CONFIGURE_GUEST_STORAGE_SCRIPT } from './guest-storage.ts';
import { limaPortForwards } from './lima-config.ts';
import { GUARD_VERSION } from './network-guard.ts';

export const diskCapacitySchema = z.number().int().min(10).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const journalSchema = z.object({ version: z.literal(1), environmentId: z.uuid(), instanceName: z.string(),
  originalDiskGiB: diskCapacitySchema, targetGiB: diskCapacitySchema,
  installed: z.string().max(1_048_576), own: z.string().max(1_048_576).nullable(),
  stage: z.enum(['pending', 'grown']) }).strict();
type Journal = z.infer<typeof journalSchema>;

async function sync(file: string) {
  const handle = await open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function replace(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file); await sync(path.dirname(file));
  } finally { await rm(temporary, { force: true }); }
}

export class DiskRecovery {
  private store: Store;
  private runtime: LimaRuntime;
  constructor(store: Store, runtime: LimaRuntime) { this.store = store; this.runtime = runtime; }
  private journalFile(e: Environment) { return path.join(this.store.dataDir, 'disk-recovery', e.id, 'journal.json'); }
  private installed(e: Environment) { return path.join(this.runtime.limaHome, e.instanceName, 'lima.yaml'); }
  private own(e: Environment) { return path.join(this.store.dataDir, 'configs', `${e.instanceName}.yaml`); }
  private mac(body: string) { return createHmac('sha256', this.store.key).update('MuCodeSandbox disk recovery v1\n').update(body).digest(); }
  private async save(e: Environment, journal: Journal) {
    const body = JSON.stringify(journalSchema.parse(journal));
    await replace(this.journalFile(e), JSON.stringify({ body, mac: this.mac(body).toString('hex') }));
  }
  async read(e: Environment): Promise<Journal | null> {
    let text: string;
    try { text = await readFile(this.journalFile(e), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const sealed = z.object({ body: z.string().max(2_200_000), mac: digest }).strict().parse(JSON.parse(text));
    if (!timingSafeEqual(this.mac(sealed.body), Buffer.from(sealed.mac, 'hex'))) throw new AppError('磁盘维护记录校验失败，环境保持关闭', 409, 'DISK_RECOVERY_INTEGRITY');
    const journal = journalSchema.parse(JSON.parse(sealed.body));
    if (journal.environmentId !== e.id || journal.instanceName !== e.instanceName || journal.targetGiB <= journal.originalDiskGiB ||
        ![journal.originalDiskGiB, journal.targetGiB].includes(e.diskGiB)) throw new AppError('磁盘维护记录与环境不一致', 409, 'DISK_RECOVERY_INTEGRITY');
    return journal;
  }
  async status(e: Environment) {
    const journal = await this.read(e);
    return { pending: Boolean(journal), targetGiB: journal?.targetGiB ?? null };
  }
  private async stopped(e: Environment) {
    if ((await this.runtime.list()).find(row => row.name === e.instanceName)?.status !== 'Stopped')
      throw new AppError('磁盘扩容需要虚拟机实际停止', 409, 'DISK_RECOVERY_STATE');
  }
  async grow(e: Environment, targetGiB: number, options: RunOptions = {}) {
    diskCapacitySchema.parse(targetGiB); options.signal?.throwIfAborted();
    if (e.kind !== 'vm' || !e.network.strict) throw new AppError('此恢复入口仅支持已启用网络防护的 Linux 环境', 409, 'DISK_RECOVERY_SCOPE');
    await this.stopped(e);
    let journal = await this.read(e);
    if (journal ? journal.targetGiB !== targetGiB : targetGiB <= e.diskGiB)
      throw new AppError(journal ? '请先完成上次请求的磁盘扩容' : '只能增加磁盘容量，不能缩小', 409, 'DISK_RECOVERY_SIZE');
    const disk = await lstat(path.join(this.runtime.limaHome, e.instanceName, 'disk'));
    if (!disk.isFile() || disk.size < (journal?.originalDiskGiB ?? e.diskGiB) * 2 ** 30 || disk.size > targetGiB * 2 ** 30)
      throw new AppError('虚拟磁盘格式或容量不符合扩容要求', 409, 'DISK_RECOVERY_DISK');
    const space = await statfs(this.store.dataDir);
    if (space.bavail * space.bsize < (targetGiB - (journal?.originalDiskGiB ?? e.diskGiB)) * 2 ** 30 + 256 * 2 ** 20)
      throw new AppError('本机可用磁盘空间不足，请先释放空间', 409, 'DISK_RECOVERY_SPACE');
    z.object({ version: z.literal(GUARD_VERSION), prepared: z.literal(true), bootArmed: z.literal(true),
      expectedHash: digest, expectedLeaseHash: digest, leaseBootHash: digest }).passthrough().parse(JSON.parse(await readFile(path.join(this.store.dataDir, 'security', `${e.instanceName}.json`), 'utf8')));
    if (!journal) {
      const installed = await readFile(this.installed(e), 'utf8');
      const original = parse(installed);
      if (original.vmType !== 'vz' || original.disk !== `${e.diskGiB}GiB`) throw new AppError('当前虚拟机配置与已保存容量不一致', 409, 'DISK_RECOVERY_CONFIGURATION');
      const own = await readFile(this.own(e), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      journal = { version: 1, environmentId: e.id, instanceName: e.instanceName, originalDiskGiB: e.diskGiB, targetGiB, installed, own, stage: 'pending' };
      await this.save(e, journal);
    }
    const original = parse(journal.installed);
    const maintenance = { ...original, disk: `${targetGiB}GiB`, mounts: [], provision: [], probes: [],
      portForwards: limaPortForwards({ ...e, ports: [] }) };
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    let boot: Promise<void> | undefined;
    let result: unknown;
    try {
      options.signal?.throwIfAborted();
      await replace(this.installed(e), stringify(maintenance));
      options.onOutput?.('Starting restricted disk maintenance without host shares or application ports\n');
      boot = this.runtime.command(['start', '--timeout', '2m', e.instanceName], { ...options, signal: controller.signal, timeoutMs: 130_000 })
        .then(() => {}, error => { options.onOutput?.(`Maintenance readiness: ${String(error)}\n`); });
      const deadline = Date.now() + 90_000;
      while (true) {
        options.signal?.throwIfAborted();
        try { await this.runtime.management(e, ['true'], { ...options, timeoutMs: 5_000 }); break; }
        catch (error) { options.signal?.throwIfAborted(); if (Date.now() >= deadline) throw error; await delay(500, undefined, { signal: options.signal }); }
      }
      const inspection = await this.runtime.networkProtection({ ...e, mounts: [], state: 'running' }, false);
      if (!inspection.firewallActive || !inspection.bootArmed || inspection.integrity !== 'verified' || inspection.leaseActive !== false)
        throw new AppError('维护环境的防护或关闭联网状态未通过核验', 409, 'DISK_RECOVERY_PROTECTION');
      const text = await this.runtime.management(e, ['sudo', 'python3', '-c', growGuestRootScript(targetGiB)], { ...options, timeoutMs: 60_000 });
      result = z.object({ diskBytes: z.literal(targetGiB * 2 ** 30), device: z.literal('/dev/vda1'),
        beforeFilesystemBytes: z.number().positive(), afterFilesystemBytes: z.number().positive(), availableBytes: z.number().nonnegative(),
        scratchInMemory: z.literal(true) }).passthrough().parse(JSON.parse(text.trim()));
      const measured = result as { beforeFilesystemBytes: number; afterFilesystemBytes: number };
      if (measured.afterFilesystemBytes < measured.beforeFilesystemBytes || measured.afterFilesystemBytes < (targetGiB - 2) * 2 ** 30)
        throw new AppError('文件系统扩容结果未通过核验', 409, 'DISK_RECOVERY_FILESYSTEM');
      await this.runtime.management(e, ['bash', '-s'], { ...options, input: CONFIGURE_GUEST_STORAGE_SCRIPT, timeoutMs: 30_000 });
      await this.runtime.management(e, ['sudo', 'sync'], { ...options, timeoutMs: 30_000 });
      options.signal?.throwIfAborted();
    } finally {
      options.signal?.removeEventListener('abort', abort); controller.abort(); await boot;
      const actual = (await this.runtime.list()).find(row => row.name === e.instanceName);
      if (actual?.status === 'Running') await this.runtime.command(['stop', '--force', e.instanceName], { timeoutMs: 120_000 });
      await this.stopped(e);
      await replace(this.installed(e), stringify({ ...original, disk: `${targetGiB}GiB` }));
      if (journal.own !== null) await replace(this.own(e), stringify({ ...parse(journal.own), disk: `${targetGiB}GiB` }));
    }
    options.signal?.throwIfAborted();
    await this.save(e, { ...journal, stage: 'grown' });
    options.onOutput?.(`Guest filesystem grown to requested ${targetGiB} GiB; environment stopped\n`);
    return result;
  }
  async commit(e: Environment, targetGiB: number) {
    const journal = await this.read(e);
    if (!journal || journal.stage !== 'grown' || journal.targetGiB !== targetGiB) throw new AppError('磁盘维护尚未完成', 409, 'DISK_RECOVERY_PENDING');
    await this.stopped(e);
    this.store.save({ ...this.store.get(e.id), diskGiB: targetGiB, state: 'stopped', lastError: null });
    await rm(this.journalFile(e)); await sync(path.dirname(this.journalFile(e)));
  }
}
