import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pack } from 'tar-stream';
import { Manager } from '../server/manager.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { environmentSchema } from '../server/validation.ts';
import { loadImportSeed, markImportReady } from '../server/import-seed.ts';
import { run } from '../server/process.ts';
import { createService } from '../server/service.ts';

const password = 'synthetic-backup-password-123';
async function fixture() {
  const directory = await mkdtemp(path.join(homedir(), '.mu-backup-test-'));
  const runtime = new LimaRuntime(path.join(directory, 'source'));
  const manager = new Manager(runtime.dataDir, undefined, runtime);
  const destination = new Manager(path.join(directory, 'destination'));
  runtime.list = async () => manager.store.list().map(e => ({ name: e.instanceName, status: 'Stopped' }));
  const project = path.join(directory, 'project'); await mkdir(project);
  const created = await manager.create({ name: 'Portable', diskGiB: 10, memoryGiB: 2, mounts: [{ id: crypto.randomUUID(), hostPath: project, guestPath: '/workspace/project', writable: false }], ports: [{ id: crypto.randomUUID(), guestPort: 3000, hostPort: 4000 }], identity: { locale: 'ja-JP', timezone: 'Asia/Tokyo' }, network: { mode: 'http', host: 'proxy.test', password: 'secret-network-password' } });
  manager.store.state(created.id, 'stopped');
  const e = manager.store.get(created.id), instance = path.join(runtime.limaHome, e.instanceName);
  await mkdir(instance, { recursive: true });
  const disk = await open(path.join(instance, 'disk'), 'wx', 0o600);
  try { await disk.write(Buffer.from('synthetic-guest-data'), 0, 20, 0); await disk.truncate(8 * 2 ** 20); } finally { await disk.close(); }
  await manager.snapshots.create(e, 'Portable');
  const [snapshot] = await manager.snapshots.list(e);
  const file = path.join(directory, 'environment.mu-backup');
  return { directory, manager, destination, e, snapshot, file, async close() { await manager.close(); await destination.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('Encrypted backup imports into an independent store with a fresh identity, sparse disk and no host grants', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await f.manager.backups.export(f.e, f.snapshot.id, f.file, password);
    const encrypted = await readFile(f.file);
    assert.ok(!encrypted.includes(Buffer.from('secret-network-password')));
    assert.ok(!encrypted.includes(Buffer.from('synthetic-guest-data')));
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    const e = await f.destination.backups.import(f.file, password, 'Recovered');
    assert.notEqual(e.id, f.e.id); assert.notEqual(e.instanceName, f.e.instanceName);
    assert.notDeepEqual(f.destination.store.key, f.manager.store.key);
    assert.deepEqual(e.mounts, []); assert.deepEqual(e.ports, []);
    assert.deepEqual(e.identity, f.e.identity); assert.equal(e.network.password, 'secret-network-password');
    assert.equal(e.state, 'not_created');
    const seed = await loadImportSeed(f.destination.store.dataDir, e);
    assert.ok(seed); assert.equal(seed.bytes, 8 * 2 ** 20);
    const metadata = await stat(seed.file);
    assert.ok(metadata.blocks * 512 < metadata.size / 2);
    assert.equal(metadata.mode & 0o777, 0o600);
    const head = await open(seed.file, 'r'); const content = Buffer.alloc(20);
    try { await head.read(content, 0, 20, 0); } finally { await head.close(); }
    assert.equal(content.toString(), 'synthetic-guest-data');
    const rawConfig = f.destination.store.db.prepare('SELECT config FROM environments WHERE id=?').get(e.id) as { config: string };
    assert.ok(!rawConfig.config.includes('secret-network-password'));
    await f.destination.backups.cleanupInterrupted();
    assert.ok(await loadImportSeed(f.destination.store.dataDir, e));
    const seedFile = path.join(f.destination.store.dataDir, 'imports', e.id, 'seed.json');
    const originalSeed = await readFile(seedFile, 'utf8');
    const signed = JSON.parse(originalSeed); signed.body = signed.body.replace(e.instanceName, 'mu-0000000000000000');
    await writeFile(seedFile, JSON.stringify(signed));
    await assert.rejects(loadImportSeed(f.destination.store.dataDir, e), /校验失败/);
    await writeFile(seedFile, originalSeed);
    await assert.rejects(f.manager.backups.export(f.e, f.snapshot.id, f.file, password), /已存在/);
    assert.deepEqual(await readFile(f.file), encrypted);
    await writeFile(seed.file, 'changed');
    await assert.rejects(loadImportSeed(f.destination.store.dataDir, e), /校验失败/);
    const commands: string[][] = [];
    f.destination.runtime.list = async () => [];
    f.destination.runtime.command = async args => { commands.push(args); return ''; };
    await assert.rejects(f.destination.runtime.start(e, {}), /校验失败/);
    assert.ok(commands.every(args => args[0] !== 'start'), 'Corrupt seed must fail before any VM boot');
  } finally { await f.close(); }
});

test('Wrong passwords, ciphertext tampering, truncation and cancellation publish no environment or backup', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await f.manager.backups.export(f.e, f.snapshot.id, f.file, password);
    const encrypted = await readFile(f.file);
    await assert.rejects(f.destination.backups.import(f.file, 'wrong-password-at-least-12', 'Wrong'), /密码错误|损坏/);
    const corrupt = path.join(f.directory, 'corrupt.mu-backup');
    const changed = Buffer.from(encrypted); changed[40] ^= 1; await writeFile(corrupt, changed);
    await assert.rejects(f.destination.backups.import(corrupt, password, 'Changed'), /密码错误|损坏/);
    await writeFile(corrupt, encrypted.subarray(0, encrypted.length - 8));
    await assert.rejects(f.destination.backups.import(corrupt, password, 'Truncated'), /密码错误|损坏/);
    const controller = new AbortController();
    await assert.rejects(f.destination.backups.import(f.file, password, 'Cancelled', { signal: controller.signal, onOutput: text => { if (text.startsWith('Materializing')) controller.abort(); } }));
    assert.deepEqual(f.destination.store.list(), []);
    assert.deepEqual(await readdir(path.join(f.destination.store.dataDir, 'imports')), []);
    const cancelExport = new AbortController(), cancelled = path.join(f.directory, 'cancelled.mu-backup');
    await assert.rejects(f.manager.backups.export(f.e, f.snapshot.id, cancelled, password, { signal: cancelExport.signal, onOutput: () => cancelExport.abort() }));
    await assert.rejects(stat(cancelled), { code: 'ENOENT' });
    assert.ok(!(await readdir(f.directory)).some(name => name.includes('.partial-')));
    const alias = path.join(f.directory, 'alias.mu-backup'); await symlink(f.file, alias);
    await assert.rejects(f.destination.backups.import(alias, password, 'Alias'), { code: 'ELOOP' });
    const fifo = path.join(f.directory, 'pipe.mu-backup'); await run('/usr/bin/mkfifo', [fifo]);
    await assert.rejects(f.destination.backups.import(fifo, password, 'Pipe'), /无效|不完整/);
    assert.equal(f.manager.store.get(f.e.id).name, f.e.name);
    const raced = path.join(f.directory, 'race.mu-backup');
    await assert.rejects(f.manager.backups.export(f.e, f.snapshot.id, raced, password, { onOutput: text => { if (text.startsWith('Encrypting')) writeFileSync(raced, 'existing-file'); } }), /已存在/);
    assert.equal(await readFile(raced, 'utf8'), 'existing-file');
    assert.ok(!(await readdir(f.directory)).some(name => name.includes('.partial-')));
    const snapshotDisk = path.join(f.manager.store.dataDir, 'snapshots', f.e.id, f.snapshot.id, 'disk');
    const altered = await open(snapshotDisk, 'r+');
    try { await altered.write(Buffer.from('BAD'), 0, 3, 0); } finally { await altered.close(); }
    const rejected = path.join(f.directory, 'bad-source.mu-backup');
    await assert.rejects(f.manager.backups.export(f.e, f.snapshot.id, rejected, password), /校验失败/);
    await assert.rejects(stat(rejected), { code: 'ENOENT' });
    assert.ok(!(await readdir(f.directory)).some(name => name.includes('.partial-')));
  } finally { await f.close(); }
});

test('An interrupted imported VM cannot become available before management initialization and its disk size stays fixed', { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await f.manager.backups.export(f.e, f.snapshot.id, f.file, password);
    const e = await f.destination.backups.import(f.file, password, 'Interrupted');
    f.destination.runtime.info = async () => ({ available: true, path: '/synthetic/lima', version: 'fixture', error: null });
    f.destination.runtime.list = async () => [{ name: e.instanceName, status: 'Running' }];
    let stopped = 0;
    f.destination.runtime.stop = async () => { stopped++; };
    await f.destination.reconcile(true);
    assert.equal(f.destination.store.get(e.id).state, 'error'); assert.equal(stopped, 1);
    f.destination.store.state(e.id, 'not_created');
    const { id, instanceName, state, lastError, browserRunning, createdAt, updatedAt, ...config } = f.destination.store.get(e.id);
    await assert.rejects(f.destination.update(e.id, { ...config, diskGiB: 20 }), /磁盘大小/);
    await markImportReady(f.destination.store.dataDir, e);
    await f.destination.reconcile(true);
    assert.equal(f.destination.store.get(e.id).state, 'running'); assert.equal(stopped, 1);
  } finally { await f.close(); }
});

async function hostileArchive(file: string, members: { name: string; body?: Buffer; type?: 'file' | 'symlink'; linkname?: string }[]) {
  const archive = pack(), chunks: Buffer[] = [];
  const collect = (async () => { for await (const chunk of archive) chunks.push(Buffer.from(chunk as Uint8Array)); })();
  for (const member of members) await new Promise<void>((resolve, reject) => archive.entry({ name: member.name, type: member.type ?? 'file', linkname: member.linkname }, member.body ?? Buffer.alloc(0), error => error ? reject(error) : resolve()));
  archive.finalize(); await collect;
  const header = Buffer.concat([Buffer.from('MUCBKP01'), randomBytes(16), randomBytes(12)]);
  const key = scryptSync(password, header.subarray(8, 24), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 2 ** 20 });
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(24)); cipher.setAAD(header);
  await writeFile(file, Buffer.concat([header, cipher.update(gzipSync(Buffer.concat(chunks))), cipher.final(), cipher.getAuthTag()]));
  key.fill(0);
}

test('Authenticated hostile archives reject traversal, links, duplicates, corrupt disks and unarmed strict seeds', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(homedir(), '.mu-backup-hostile-'));
  const manager = new Manager(path.join(directory, 'data'));
  try {
    const disk = Buffer.from('guest-data');
    const manifest = { version: 1, arch: 'aarch64', vmType: 'vz', config: environmentSchema.parse({ name: 'Fixture', memoryGiB: 2 }), disk: { bytes: disk.length, allocatedBytes: disk.length, hash: createHash('sha256').update(disk).digest('hex') } };
    const m = { name: 'manifest.json', body: Buffer.from(JSON.stringify(manifest)) };
    const cases = [
      [m, { name: '../escaped', body: disk }],
      [m, { name: 'disk', type: 'symlink' as const, linkname: '/etc/passwd' }],
      [m, { name: 'disk', body: disk }, { name: 'disk', body: disk }],
      [m, { name: 'disk', body: Buffer.from('wrong-data') }],
      [{ name: 'manifest.json', body: Buffer.from(JSON.stringify({ ...manifest, config: environmentSchema.parse({ name: 'Strict', memoryGiB: 2, network: { mode: 'http', host: 'proxy.test', strict: true, transparent: true } }) })) }, { name: 'disk', body: disk }],
    ];
    for (let i = 0; i < cases.length; i++) {
      const file = path.join(directory, `case-${i}.mu-backup`); await hostileArchive(file, cases[i]);
      await assert.rejects(manager.backups.import(file, password, `Hostile ${i}`));
      assert.deepEqual(manager.store.list(), []);
      assert.deepEqual(await readdir(path.join(manager.store.dataDir, 'imports')), []);
    }
    await assert.rejects(stat(path.join(manager.store.dataDir, 'escaped')), { code: 'ENOENT' });
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Startup cleanup removes only unpublished imports and preserves unrelated local files', async () => {
  const directory = await mkdtemp(path.join(homedir(), '.mu-backup-clean-'));
  const manager = new Manager(directory);
  try {
    const root = path.join(directory, 'imports'); await mkdir(root);
    const orphan = crypto.randomUUID();
    await mkdir(path.join(root, orphan)); await mkdir(path.join(root, '.tmp-abcd12'));
    await writeFile(path.join(root, 'keep.txt'), 'keep');
    await manager.backups.cleanupInterrupted();
    assert.deepEqual(await readdir(root), ['keep.txt']);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test('A real killed import leaves private authenticated staging; normal service startup cleans it and retry succeeds', { timeout: 20_000 }, async () => {
  const f = await fixture();
  const dataDir = path.join(f.directory, 'crash-destination');
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  try {
    await f.manager.backups.export(f.e, f.snapshot.id, f.file, password);
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../scripts/backup-import-worker.ts'), dataDir, f.file], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-8192); });
    child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-8192); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10_000);
    child.stdin.end(JSON.stringify({ password }));
    try {
      const outcome = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(timedOut, false, output);
      assert.deepEqual(outcome, { code: null, signal: 'SIGKILL' }, output);
    } finally { clearTimeout(timer); }
    const imports = path.join(dataDir, 'imports'), [stage, ...other] = await readdir(imports);
    assert.match(stage, /^\.tmp-[A-Za-z0-9]+$/); assert.deepEqual(other, []);
    const decrypted = await stat(path.join(imports, stage, 'payload.gz'));
    assert.ok(decrypted.size > 0); assert.equal(decrypted.mode & 0o777, 0o600);
    service = await createService({ rootDir: path.resolve(import.meta.dirname, '..'), dataDir, port: 0 });
    assert.deepEqual(service.manager.store.list(), []);
    assert.deepEqual(await readdir(imports), []);
    const recovered = await service.manager.backups.import(f.file, password, 'Retried after crash');
    assert.equal(recovered.state, 'not_created'); assert.equal(recovered.network.password, f.e.network.password);
    assert.ok(await loadImportSeed(dataDir, recovered));
  } finally { await service?.close(); await f.close(); }
});
