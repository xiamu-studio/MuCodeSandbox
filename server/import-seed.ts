import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Environment } from '../shared/types.ts';
import { AppError } from './errors.ts';
import { baseDiskHash } from './protected-base.ts';
import { GUARD_VERSION } from './network-guard.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const backupGuardSchema = z.object({
  version: z.number().int(), prepared: z.boolean(), bootArmed: z.boolean(), conservative: z.boolean(),
  expectedHash: z.string().max(64), bootFileHash: z.string().max(64), tunnelConfigHash: z.string().max(64).optional(),
  expectedLeaseHash: z.string().max(64).optional(), leaseBootHash: z.string().max(64).optional(),
}).strict();
export const seedSchema = z.object({
  version: z.literal(1), environmentId: z.uuid(), instanceName: z.string().regex(/^mu-[a-f0-9]{16}$/),
  bytes: z.number().int().positive().max(256 * 2 ** 30), hash, guard: backupGuardSchema.optional(), managementReady: z.boolean().optional(),
}).strict();
export type ImportSeed = z.infer<typeof seedSchema>;

export function sealSeed(seed: ImportSeed, key: Buffer) {
  const body = JSON.stringify(seedSchema.parse(seed));
  return JSON.stringify({ body, mac: createHmac('sha256', key).update('MuCodeSandbox import seed v1\n').update(body).digest('hex') });
}

export function unsealSeed(text: string, key: Buffer) {
  const value = z.object({ body: z.string().max(16_384), mac: hash }).strict().parse(JSON.parse(text));
  const expected = createHmac('sha256', key).update('MuCodeSandbox import seed v1\n').update(value.body).digest();
  if (!timingSafeEqual(expected, Buffer.from(value.mac, 'hex'))) throw new AppError('导入镜像记录校验失败', 409, 'BACKUP_INTEGRITY');
  return seedSchema.parse(JSON.parse(value.body));
}

export function validateSeedGuard(strict: boolean, guard?: z.infer<typeof backupGuardSchema>) {
  if (strict && (!guard?.prepared || !guard.bootArmed || !guard.conservative || guard.version !== GUARD_VERSION))
    throw new AppError('严格环境备份缺少当前版本的保守开机防护，请更新并正常停止后重新创建快照', 409, 'BACKUP_GUARD');
}

export async function readImportSeed(dataDir: string, e: Environment) {
  const directory = path.join(dataDir, 'imports', e.id);
  let text: string;
  try { text = await readFile(path.join(directory, 'seed.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const seed = unsealSeed(text, await readFile(path.join(dataDir, 'credentials.key')));
  if (seed.environmentId !== e.id || seed.instanceName !== e.instanceName) throw new AppError('导入镜像身份不匹配', 409, 'BACKUP_INTEGRITY');
  return { ...seed, file: path.join(directory, 'disk') };
}

export async function markImportReady(dataDir: string, e: Environment) {
  const seed = await readImportSeed(dataDir, e);
  if (!seed) throw new AppError('导入镜像记录丢失', 409, 'BACKUP_INTEGRITY');
  const { file, ...record } = seed;
  const target = path.join(path.dirname(file), 'seed.json'), temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, sealSeed({ ...record, managementReady: true }, await readFile(path.join(dataDir, 'credentials.key'))), { mode: 0o600, flag: 'wx' });
    const handle = await open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
    const directory = await open(path.dirname(target), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export async function loadImportSeed(dataDir: string, e: Environment, signal?: AbortSignal) {
  const seed = await readImportSeed(dataDir, e);
  if (!seed) return null;
  validateSeedGuard(e.network.strict, seed.guard);
  const file = seed.file;
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.size !== seed.bytes || await baseDiskHash(file, signal) !== seed.hash)
    throw new AppError('导入镜像内容校验失败，拒绝启动', 409, 'BACKUP_INTEGRITY');
  return { ...seed, file };
}
