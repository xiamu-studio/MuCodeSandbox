import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Environment, EnvironmentSnapshot } from '../shared/types.ts';
import type { Store } from './store.ts';
import type { LimaRuntime } from './runtime.ts';
import type { RunOptions } from './process.ts';
import { run } from './process.ts';
import { AppError } from './errors.ts';
import { environmentSchema, validateMounts } from './validation.ts';

const keys = ['disk', 'efi', 'identity', 'installedConfig', 'ownConfig', 'guard'] as const;
type Key = typeof keys[number];
const manifestSchema = z.object({ version: z.literal(1), id: z.uuid(), environmentId: z.uuid(), name: z.string().max(60), createdAt: z.iso.datetime(), config: z.string(), files: z.array(z.object({ key: z.enum(keys), bytes: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(keys.length) }).strict();
type Manifest = z.infer<typeof manifestSchema>;
const rollbackSchema = z.discriminatedUnion('existed', [
  z.object({ key: z.enum(keys), existed: z.literal(true), bytes: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ key: z.enum(keys), existed: z.literal(false) }).strict(),
]);
const currentJournalSchema = z.object({ version: z.literal(2), committed: z.boolean(), config: z.string(), files: z.array(rollbackSchema).length(keys.length).refine(files => new Set(files.map(file => file.key)).size === keys.length) }).strict();
const journalSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), committed: z.boolean(), config: z.string(), files: z.array(z.object({ key: z.enum(keys), existed: z.boolean() }).strict()).max(keys.length) }).strict(),
  currentJournalSchema,
]);

async function hashFile(file: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  const stream = createReadStream(file, { signal });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function syncPath(file: string) {
  const handle = await open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeDurable(file: string, text: string) {
  const handle = await open(file, 'w', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await syncPath(path.dirname(file));
}

async function syncParent(file: string) {
  let directory = path.dirname(file);
  while (true) {
    try { await syncPath(directory); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || directory === path.dirname(directory)) throw error;
      directory = path.dirname(directory);
    }
  }
}

export class Snapshots {
  private store: Store;
  private runtime: LimaRuntime;
  constructor(store: Store, runtime: LimaRuntime) { this.store = store; this.runtime = runtime; }
  private root(e: Environment) { return path.join(this.store.dataDir, 'snapshots', e.id); }
  private transaction(e: Environment) { return path.join(this.store.dataDir, 'restore', e.id); }
  private async invalidateSharedMountTrust(e: Environment) {
    // Host approvals describe a particular guest disk; never carry them across
    // disk replacement or reuse a migration journal from the replaced disk.
    for (const suffix of ['shares', 'shares-migration']) {
      const file = path.join(this.store.dataDir, 'security', `${e.instanceName}-${suffix}.json`);
      await rm(file, { force: true });
      await syncParent(file);
    }
  }
  private targets(e: Environment): Record<Key, string> {
    const instance = path.join(this.runtime.limaHome, e.instanceName);
    return { disk: path.join(instance, 'disk'), efi: path.join(instance, 'vz-efi'), identity: path.join(instance, 'vz-identifier'), installedConfig: path.join(instance, 'lima.yaml'), ownConfig: path.join(this.store.dataDir, 'configs', `${e.instanceName}.yaml`), guard: path.join(this.store.dataDir, 'security', `${e.instanceName}.json`) };
  }
  private seal(value: unknown) {
    const body = JSON.stringify(value);
    const key = createHmac('sha256', this.store.key).update('MuCodeSandbox snapshot metadata v1').digest();
    return JSON.stringify({ body, mac: createHmac('sha256', key).update(body).digest('hex') });
  }
  private unseal(text: string) {
    const { body, mac } = z.object({ body: z.string(), mac: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse(text));
    const key = createHmac('sha256', this.store.key).update('MuCodeSandbox snapshot metadata v1').digest();
    const expected = createHmac('sha256', key).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(mac, 'hex'))) throw new AppError('快照元数据校验失败', 409, 'SNAPSHOT_INTEGRITY');
    return JSON.parse(body);
  }
  private async publishJournal(directory: string, value: z.infer<typeof journalSchema>) {
    const next = path.join(directory, 'journal.next');
    await writeDurable(next, this.seal(value));
    await rename(next, path.join(directory, 'journal.json'));
    await syncPath(directory);
  }
  private async copy(source: string, target: string, options: RunOptions = {}) {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // APFS clones preserve sparse VM disks and avoid allocating the full size.
    await run('/bin/cp', ['-c', source, target], { ...options, timeoutMs: 120_000 });
    await chmod(target, 0o600);
    await syncPath(target);
    await syncPath(path.dirname(target));
  }
  private async stopped(e: Environment) {
    if (await this.runtime.diskMaintenancePending(e)) throw new AppError('磁盘维护尚未完成，请先重试扩容', 409, 'DISK_RECOVERY_PENDING');
    if (e.kind !== 'vm') throw new AppError('此版本快照只支持 Linux 环境', 409);
    if (e.browserRunning || e.state === 'running') throw new AppError('请先停止环境和浏览器', 409);
    const actual = (await this.runtime.list()).find(i => i.name === e.instanceName);
    if (!actual || actual.status !== 'Stopped') throw new AppError('虚拟机必须实际处于停止状态', 409);
  }
  private config(text: string, e: Environment) {
    const decoded = JSON.parse(this.store.decrypt(text)) as Environment;
    if (decoded.id !== e.id || decoded.instanceName !== e.instanceName || decoded.kind !== 'vm') throw new AppError('快照不属于此环境', 409);
    const { name, description, kind, color, cpus, memoryGiB, diskGiB, mounts, ports, network, browserUrl, identity } = decoded;
    const config = environmentSchema.parse({ name, description, kind, color, cpus, memoryGiB, diskGiB, mounts, ports, network, browserUrl, identity });
    return { ...decoded, ...config, state: 'stopped' as const, browserRunning: false, lastError: null };
  }
  async recover(e: Environment, options: Pick<RunOptions, 'onOutput'> = {}) {
    const directory = this.transaction(e);
    let text: string;
    try { text = await readFile(path.join(directory, 'journal.json'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await rm(directory, { recursive: true, force: true });
      await syncParent(directory);
      return;
    }
    const journal = journalSchema.parse(this.unseal(text));
    await this.stopped(e);
    await this.invalidateSharedMountTrust(e);
    if (!journal.committed) {
      const restored = this.config(journal.config, e);
      const targets = this.targets(e);
      if (journal.version === 2) {
        // Check every rollback copy before changing any installed file.
        for (const entry of journal.files) if (entry.existed) {
          const file = path.join(directory, 'rollback', entry.key);
          const metadata = await lstat(file);
          if (!metadata.isFile() || metadata.size !== entry.bytes || await hashFile(file) !== entry.hash)
            throw new AppError('恢复回滚副本校验失败，已保留恢复记录并阻止启动', 409, 'SNAPSHOT_INTEGRITY');
        }
      } else this.store.log(e.id, null, '恢复旧版事务记录；旧记录不包含回滚副本校验值');
      for (const entry of journal.files) {
        const target = targets[entry.key];
        if (entry.existed) {
          const next = `${target}.restore-recovery`;
          await rm(next, { force: true });
          await this.copy(path.join(directory, 'rollback', entry.key), next);
          await rename(next, target);
        } else await rm(target, { force: true });
        await syncParent(target);
        options.onOutput?.(`Recovered: ${entry.key}\n`);
      }
      this.store.save(restored);
      this.store.log(e.id, null, '已回滚中断的快照恢复');
      journal.committed = true;
      await this.publishJournal(directory, journal);
      options.onOutput?.('Recovery transaction committed\n');
    }
    await rm(directory, { recursive: true, force: true });
    await syncPath(path.dirname(directory));
  }
  async list(e: Environment): Promise<EnvironmentSnapshot[]> {
    let directories: string[];
    try { directories = await readdir(this.root(e)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const results: EnvironmentSnapshot[] = [];
    for (const id of directories.filter(id => z.uuid().safeParse(id).success)) {
      const m = manifestSchema.parse(this.unseal(await readFile(path.join(this.root(e), id, 'manifest.json'), 'utf8')));
      if (m.environmentId !== e.id || m.id !== id) throw new AppError('快照身份校验失败', 409);
      results.push({ id, environmentId: e.id, name: m.name, createdAt: m.createdAt, bytes: m.files.reduce((sum, f) => sum + f.bytes, 0) });
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async backupSource(e: Environment, id: string) {
    z.uuid().parse(id);
    const directory = path.join(this.root(e), id);
    const manifest = manifestSchema.parse(this.unseal(await readFile(path.join(directory, 'manifest.json'), 'utf8')));
    if (manifest.id !== id || manifest.environmentId !== e.id || new Set(manifest.files.map(file => file.key)).size !== manifest.files.length || !manifest.files.some(file => file.key === 'disk')) throw new AppError('快照身份或文件列表无效', 409);
    const config = this.config(manifest.config, e);
    const files = [];
    for (const entry of manifest.files.filter(file => ['disk', 'guard'].includes(file.key))) {
      const file = path.join(directory, entry.key);
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.size !== entry.bytes) throw new AppError('快照源文件无效', 409, 'SNAPSHOT_INTEGRITY');
      files.push({ ...entry, path: file, allocatedBytes: Math.min(metadata.size, metadata.blocks * 512) });
    }
    return { config, files };
  }
  async create(e: Environment, name: string, options: RunOptions = {}) {
    await this.stopped(e); await this.recover(e);
    e = this.store.get(e.id);
    const id = randomUUID(); const temporary = path.join(this.root(e), `${id}.tmp`);
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    const manifest: Manifest = { version: 1, id, environmentId: e.id, name, createdAt: new Date().toISOString(), config: this.store.encrypt(JSON.stringify(e)), files: [] };
    try {
      for (const [key, source] of Object.entries(this.targets(e)) as [Key, string][]) {
        try { const file = await stat(source); if (!file.isFile()) throw new AppError('快照源文件无效'); }
        catch (error) { if (key !== 'disk' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const file = path.join(temporary, key);
        options.onOutput?.(`Snapshot: ${key}\n`);
        await this.copy(source, file, options);
        manifest.files.push({ key, bytes: (await stat(file)).size, hash: await hashFile(file, options.signal) });
      }
      await writeDurable(path.join(temporary, 'manifest.json'), this.seal(manifest));
      await rename(temporary, path.join(this.root(e), id));
      await syncPath(this.root(e));
      await syncPath(path.dirname(this.root(e)));
      await syncPath(this.store.dataDir);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async restore(e: Environment, id: string, options: RunOptions = {}) {
    z.uuid().parse(id); await this.stopped(e); await this.recover(e);
    e = this.store.get(e.id);
    const snapshot = path.join(this.root(e), id);
    const manifest = manifestSchema.parse(this.unseal(await readFile(path.join(snapshot, 'manifest.json'), 'utf8')));
    if (manifest.id !== id || manifest.environmentId !== e.id || new Set(manifest.files.map(f => f.key)).size !== manifest.files.length || !manifest.files.some(f => f.key === 'disk')) throw new AppError('快照身份或文件列表无效', 409);
    const restored = this.config(manifest.config, e);
    restored.mounts = await validateMounts(restored.mounts, this.store.dataDir);
    const directory = this.transaction(e); const targets = this.targets(e);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const journal: z.infer<typeof currentJournalSchema> = { version: 2, committed: false, config: this.store.encrypt(JSON.stringify(e)), files: [] };
    try {
      for (const key of keys) {
        const entry = manifest.files.find(f => f.key === key);
        if (entry) {
          const next = path.join(directory, 'next', key);
          await this.copy(path.join(snapshot, key), next, options);
          if ((await stat(next)).size !== entry.bytes || await hashFile(next, options.signal) !== entry.hash) throw new AppError('快照文件校验失败，未执行恢复', 409, 'SNAPSHOT_INTEGRITY');
        }
        let existed = false;
        try { await stat(targets[key]); existed = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (existed) {
          const rollback = path.join(directory, 'rollback', key);
          await this.copy(targets[key], rollback, options);
          journal.files.push({ key, existed: true, bytes: (await stat(rollback)).size, hash: await hashFile(rollback, options.signal) });
        } else journal.files.push({ key, existed: false });
      }
      await this.publishJournal(directory, journal);
      await syncPath(path.dirname(directory));
      await syncPath(this.store.dataDir);
      await this.invalidateSharedMountTrust(e);
      for (const key of keys) {
        options.signal?.throwIfAborted();
        if (manifest.files.some(entry => entry.key === key)) {
          await mkdir(path.dirname(targets[key]), { recursive: true, mode: 0o700 });
          await rename(path.join(directory, 'next', key), targets[key]);
        } else await rm(targets[key], { force: true });
        await syncParent(targets[key]);
        options.onOutput?.(`Restored: ${key}\n`);
      }
      this.store.save(restored);
      options.onOutput?.('Restore configuration saved\n');
      journal.committed = true;
      await this.publishJournal(directory, journal);
      options.onOutput?.('Restore transaction committed\n');
      await rm(directory, { recursive: true, force: true });
      await syncPath(path.dirname(directory));
    } catch (error) { await this.recover(e); throw error; }
  }
  async remove(e: Environment, id: string) { z.uuid().parse(id); await rm(path.join(this.root(e), id), { recursive: true, force: true }); }
}
