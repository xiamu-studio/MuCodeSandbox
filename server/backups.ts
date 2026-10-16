import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, statfs, writeFile, rename } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { pack, extract } from 'tar-stream';
import { z } from 'zod';
import type { Environment } from '../shared/types.ts';
import type { Store } from './store.ts';
import type { Snapshots } from './snapshots.ts';
import type { RunOptions } from './process.ts';
import { AppError } from './errors.ts';
import { environmentSchema } from './validation.ts';
import { backupGuardSchema, sealSeed, validateSeedGuard } from './import-seed.ts';

const magic = Buffer.from('MUCBKP01');
const headerBytes = 36, tagBytes = 16, reserve = 128 * 2 ** 20;
export const backupPasswordSchema = z.string().min(12, '备份密码至少 12 个字符').max(256);
export const backupPathSchema = z.string().min(1).max(4096).refine(path.isAbsolute, '请选择绝对路径').refine(value => value.endsWith('.mu-backup'), '备份文件扩展名必须是 .mu-backup');
const manifestSchema = z.object({
  version: z.literal(1), arch: z.literal('aarch64'), vmType: z.literal('vz'),
  config: environmentSchema.refine(config => config.kind === 'vm'),
  disk: z.object({ bytes: z.number().int().positive().max(256 * 2 ** 30), allocatedBytes: z.number().int().nonnegative().max(256 * 2 ** 30), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  guard: backupGuardSchema.optional(),
}).strict();
type Manifest = z.infer<typeof manifestSchema>;

async function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 2 ** 20 }, (error, key) => error ? reject(error) : resolve(key)));
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function capacity(directory: string, needed = reserve) {
  const space = await statfs(directory);
  if (space.bavail * space.bsize < needed) throw new AppError('可用磁盘空间不足，操作未完成，原环境保持不变', 409, 'BACKUP_SPACE');
}

export class Backups {
  private store: Store;
  private snapshots: Snapshots;
  constructor(store: Store, snapshots: Snapshots) { this.store = store; this.snapshots = snapshots; }
  async cleanupInterrupted() {
    const root = path.join(this.store.dataDir, 'imports');
    let entries: string[];
    try { entries = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const environments = new Set(this.store.list().map(e => e.id));
    for (const name of entries) if (/^\.tmp-[A-Za-z0-9]+$/.test(name) || (z.uuid().safeParse(name).success && !environments.has(name)))
      await rm(path.join(root, name), { recursive: true, force: true });
  }
  private async exportPath(file: string) {
    backupPathSchema.parse(file);
    const directory = await realpath(path.dirname(file));
    const privateRoot = await realpath(this.store.dataDir);
    if (directory === privateRoot || directory.startsWith(`${privateRoot}${path.sep}`)) throw new AppError('请将备份保存到应用数据目录之外', 409);
    const target = path.join(directory, path.basename(file));
    try { await lstat(target); throw new AppError('备份文件已存在，请选择新文件名', 409, 'BACKUP_EXISTS'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return target;
  }
  async export(e: Environment, snapshotId: string, file: string, password: string, options: RunOptions = {}) {
    backupPasswordSchema.parse(password);
    const target = await this.exportPath(file);
    const source = await this.snapshots.backupSource(e, snapshotId);
    const disk = source.files.find(entry => entry.key === 'disk')!;
    const guardFile = source.files.find(entry => entry.key === 'guard');
    let guard: Manifest['guard'];
    if (guardFile) {
      if (guardFile.bytes > 16_384) throw new AppError('快照防护记录过大', 409);
      const bytes = await readFile(guardFile.path);
      if (createHash('sha256').update(bytes).digest('hex') !== guardFile.hash) throw new AppError('快照防护记录校验失败', 409, 'SNAPSHOT_INTEGRITY');
      guard = backupGuardSchema.parse(JSON.parse(bytes.toString()));
    }
    validateSeedGuard(source.config.network.strict, guard);
    const { name, description, kind, color, cpus, memoryGiB, diskGiB, network, identity, browserUrl } = source.config;
    const manifest = manifestSchema.parse({ version: 1, arch: 'aarch64', vmType: 'vz', config: { name, description, kind, color, cpus, memoryGiB, diskGiB, network, identity, browserUrl, mounts: [], ports: [] }, disk: { bytes: disk.bytes, allocatedBytes: disk.allocatedBytes, hash: disk.hash }, guard });
    await capacity(path.dirname(target), Math.ceil(disk.allocatedBytes * 1.05 + disk.bytes / 500) + reserve);
    options.signal?.throwIfAborted();
    const header = Buffer.concat([magic, randomBytes(16), randomBytes(12)]);
    const key = await derive(password, header.subarray(8, 24));
    const temporary = `${target}.partial-${randomUUID()}`;
    const archive = pack();
    let output: Promise<void> | undefined;
    let published = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(header);
        const cipher = createCipheriv('aes-256-gcm', key, header.subarray(24));
        cipher.setAAD(header);
        const destination = new Writable({ write(chunk, _encoding, next) { void handle.writeFile(chunk).then(() => next(), next); } });
        output = pipeline(Readable.from(archive), createGzip({ level: 1 }), cipher, destination, { signal: options.signal });
        void output.catch(() => {});
        await new Promise<void>((resolve, reject) => archive.entry({ name: 'manifest.json', mode: 0o600, type: 'file' }, JSON.stringify(manifest), error => error ? reject(error) : resolve()));
        options.onOutput?.('Encrypting snapshot disk\n');
        const hash = createHash('sha256');
        const verify = new Transform({ transform(chunk, _encoding, next) { hash.update(chunk); next(null, chunk); } });
        await pipeline(createReadStream(disk.path, { highWaterMark: 2 ** 20 }), verify, archive.entry({ name: 'disk', size: disk.bytes, mode: 0o600, type: 'file' }) as unknown as Writable, { signal: options.signal });
        if (hash.digest('hex') !== disk.hash) throw new AppError('快照磁盘校验失败，未发布备份', 409, 'SNAPSHOT_INTEGRITY');
        archive.finalize();
        await output;
        await handle.write(cipher.getAuthTag(), 0, tagBytes, (await handle.stat()).size);
        await handle.sync();
      } catch (error) {
        archive.destroy(error as Error);
        await output?.catch(() => {});
        throw error;
      } finally { await handle.close(); }
      options.signal?.throwIfAborted();
      await link(temporary, target);
      published = true;
      await syncDirectory(path.dirname(target));
      options.onOutput?.('Encrypted backup saved\n');
    } catch (error) {
      archive.destroy(error as Error);
      await output?.catch(() => {});
      if (!published && (error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('备份文件已存在，未覆盖', 409, 'BACKUP_EXISTS');
      throw error;
    } finally { key.fill(0); await rm(temporary, { force: true }); }
  }
  async import(file: string, password: string, name: string, options: RunOptions = {}) {
    backupPathSchema.parse(file); backupPasswordSchema.parse(password);
    const root = path.join(this.store.dataDir, 'imports');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(path.join(root, '.tmp-'));
    let target: string | undefined, committed = false;
    try {
      const compressed = path.join(temporary, 'payload.gz');
      const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let key: Buffer | undefined;
      try {
        const metadata = await input.stat();
        if (!metadata.isFile() || metadata.size <= headerBytes + tagBytes) throw new AppError('备份文件无效或不完整', 409, 'BACKUP_INTEGRITY');
        await capacity(root, metadata.size * 2 + reserve);
        const header = Buffer.alloc(headerBytes), tag = Buffer.alloc(tagBytes);
        if ((await input.read(header, 0, header.length, 0)).bytesRead !== headerBytes || !header.subarray(0, 8).equals(magic)) throw new AppError('备份格式或版本不受支持', 409, 'BACKUP_INTEGRITY');
        await input.read(tag, 0, tag.length, metadata.size - tagBytes);
        key = await derive(password, header.subarray(8, 24));
        options.signal?.throwIfAborted();
        const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(24));
        decipher.setAAD(header); decipher.setAuthTag(tag);
        options.onOutput?.('Authenticating encrypted backup\n');
        await pipeline(input.createReadStream({ start: headerBytes, end: metadata.size - tagBytes - 1, autoClose: false }), decipher, (await open(compressed, 'wx', 0o600)).createWriteStream(), { signal: options.signal });
      } catch (error) {
        if ((error as Error).message.includes('authenticate data') || (error as NodeJS.ErrnoException).code?.startsWith('ERR_OSSL')) throw new AppError('密码错误或备份已损坏，未导入环境', 409, 'BACKUP_INTEGRITY');
        throw error;
      } finally { key?.fill(0); await input.close(); }
      const manifest = await this.extract(compressed, temporary, options);
      const config = environmentSchema.parse({ ...manifest.config, name, mounts: [], ports: [] });
      if (config.cpus > cpus().length || config.memoryGiB > Math.floor(totalmem() / 2 ** 30 * 0.8)) throw new AppError('备份的 CPU 或内存设置超过本机可用资源', 409);
      validateSeedGuard(config.network.strict, manifest.guard);
      options.signal?.throwIfAborted();
      const id = randomUUID(), now = new Date().toISOString();
      const e: Environment = { ...config, id, instanceName: `mu-${id.replaceAll('-', '').slice(0, 16)}`, state: 'not_created', browserRunning: false, lastError: null, createdAt: now, updatedAt: now };
      await rm(compressed);
      await writeFile(path.join(temporary, 'seed.json'), sealSeed({ version: 1, environmentId: e.id, instanceName: e.instanceName, bytes: manifest.disk.bytes, hash: manifest.disk.hash, guard: manifest.guard }, this.store.key), { flag: 'wx', mode: 0o600 });
      const seed = await open(path.join(temporary, 'seed.json'), 'r');
      try { await seed.sync(); } finally { await seed.close(); }
      await syncDirectory(temporary);
      target = path.join(root, id);
      await rename(temporary, target); await syncDirectory(root);
      this.store.save(e); committed = true;
      this.store.log(e.id, null, '已导入加密备份；本机目录共享、端口及宿主桥接授权已清除');
      options.onOutput?.('Imported environment is ready for its first normal startup\n');
      return e;
    } finally {
      await rm(temporary, { recursive: true, force: true });
      if (target && !committed) await rm(target, { recursive: true, force: true });
    }
  }
  private async extract(compressed: string, directory: string, options: RunOptions): Promise<Manifest> {
    const archive = extract();
    let manifest: Manifest | undefined, diskSeen = false, total = 0;
    const limit = new Transform({ transform(chunk, _encoding, next) {
      total += chunk.length;
      const maximum = manifest ? manifest.disk.bytes + 2 ** 20 : 256 * 2 ** 10;
      next(total > maximum ? new AppError('备份解压内容超出声明范围', 409, 'BACKUP_INTEGRITY') : null, chunk);
    } });
    const pending = pipeline(createReadStream(compressed), createGunzip({ chunkSize: 64 * 2 ** 10 }), limit, archive as unknown as Writable, { signal: options.signal });
    void pending.catch(() => {});
    try {
      for await (const entry of archive) {
        const header = entry.header;
        if (header.type !== 'file' || header.linkname || header.pax) throw new AppError('备份包含不支持的文件类型', 409, 'BACKUP_INTEGRITY');
        if (!manifest && header.name === 'manifest.json' && header.size <= 256 * 2 ** 10) {
          const chunks = [];
          for await (const chunk of entry) chunks.push(Buffer.from(chunk as Uint8Array));
          manifest = manifestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
          if (manifest.disk.allocatedBytes > manifest.disk.bytes || manifest.disk.bytes > manifest.config.diskGiB * 2 ** 30) throw new AppError('备份磁盘大小与配置不一致', 409, 'BACKUP_INTEGRITY');
          await capacity(directory, Math.min(manifest.disk.bytes, manifest.disk.allocatedBytes) + reserve);
        } else if (manifest && !diskSeen && header.name === 'disk' && header.size === manifest.disk.bytes) {
          diskSeen = true;
          options.onOutput?.('Materializing and verifying sparse disk\n');
          const handle = await open(path.join(directory, 'disk'), 'wx', 0o600);
          const hash = createHash('sha256');
          let position = 0, allocated = 0, nextCheck = 0;
          try {
            for await (const value of entry) {
              options.signal?.throwIfAborted();
              const chunk = Buffer.from(value as Uint8Array);
              hash.update(chunk);
              if (!chunk.equals(Buffer.alloc(chunk.length))) {
                if (allocated >= nextCheck) { await capacity(directory); nextCheck = allocated + 32 * 2 ** 20; }
                let offset = 0;
                while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset, position + offset)).bytesWritten;
                allocated += chunk.length;
              }
              position += chunk.length;
            }
            if (position !== manifest.disk.bytes || hash.digest('hex') !== manifest.disk.hash) throw new AppError('备份磁盘校验失败', 409, 'BACKUP_INTEGRITY');
            await handle.truncate(position); await handle.sync();
          } finally { await handle.close(); }
        } else throw new AppError('备份包含重复、额外或无效路径的文件', 409, 'BACKUP_INTEGRITY');
      }
      await pending;
      if (!manifest || !diskSeen) throw new AppError('备份缺少必要内容', 409, 'BACKUP_INTEGRITY');
      return manifest;
    } catch (error) { archive.destroy(error as Error); await pending.catch(() => {}); throw error; }
  }
}
