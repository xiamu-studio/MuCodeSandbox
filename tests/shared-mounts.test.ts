import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { randomUUID } from 'node:crypto';
import { parseSharedMountInspection } from '../server/guest-mounts.ts';
import { environmentSchema } from '../server/validation.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { buildLimaConfig } from '../server/lima-config.ts';
import type { Environment } from '../shared/types.ts';
import { Manager } from '../server/manager.ts';

const environment = (): Environment => ({ ...environmentSchema.parse({ name: 'Shared mount test',
  mounts: [{ id: randomUUID(), hostPath: '/tmp/project', guestPath: '/workspace/project', writable: true }] }),
  id: randomUUID(), instanceName: 'mu-share-test', state: 'stopped', lastError: null, browserRunning: false,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

test('Shared-mount inspection tolerates diagnostic stderr but rejects missing, duplicate or malformed evidence', () => {
  assert.deepEqual(parseSharedMountInspection('bash: locale warning\n{"issues":[]}\n'), { issues: [] });
  assert.deepEqual(parseSharedMountInspection('{"issues":["unsafe"]}\n').issues, ['unsafe']);
  for (const output of ['', 'warning only', '{"issues":[]}\n{"issues":[]}', '{"issues":false}', '{"issues":[],"extra":true}']) {
    assert.throws(() => parseSharedMountInspection(output));
  }
});

test('Legacy shared VM starts only a no-share maintenance configuration before valid migration evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mu-share-unit-'));
  const commands: string[][] = [];
  const runtime = new LimaRuntime(root, async (_file, args) => {
    commands.push(args);
    if (args.includes('start')) {
      const config = parse(await readFile(path.join(root, 'lima', e.instanceName, 'lima.yaml'), 'utf8'));
      assert.deepEqual(config.mounts, []); assert.ok(!config.provision.some((p: any) => p.mode === 'boot'));
    }
    return '';
  });
  runtime.executable = async () => process.execPath;
  const e = environment(); runtime.list = async () => [{ name: e.instanceName, status: 'Stopped' }];
  try {
    const directory = path.join(root, 'lima', e.instanceName); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'lima.yaml'), stringify({ mounts: e.mounts, provision: [] }));
    await assert.rejects(runtime.start(e, {}), { code: 'SHARED_MOUNT_MIGRATION_EXPORTS' });
    assert.equal(commands.filter(args => args.includes('start')).length, 1);
    assert.ok(!commands.some(args => args.includes('shell')));
    // Replacing YAML alone cannot establish safe historical boot ordering.
    await writeFile(path.join(directory, 'lima.yaml'), buildLimaConfig(e));
    await assert.rejects(runtime.start(e, {}), { code: 'SHARED_MOUNT_MIGRATION_EXPORTS' });
    assert.equal(commands.filter(args => args.includes('start')).length, 2);
    assert.ok(!commands.some(args => args.includes('shell')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Already-running guest with an unsafe share is rejected even in direct network mode', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mu-share-unit-'));
  const runtime = new LimaRuntime(root, async () => '{"issues":["unsafe mount options"]}\n');
  runtime.executable = async () => process.execPath;
  const e = environment(); runtime.list = async () => [{ name: e.instanceName, status: 'Running' }];
  try { await assert.rejects(runtime.start(e, {}), { code: 'SHARED_MOUNT_UNSAFE' }); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('An unverified maintenance stop keeps exports removed and retains its pending journal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mu-share-unit-'));
  const runtime = new LimaRuntime(root, async (_file, args) => {
    if (args.includes('stop')) throw new Error('Stop rejected');
    return '';
  });
  runtime.executable = async () => process.execPath;
  const e = environment(); runtime.list = async () => [{ name: e.instanceName, status: 'Stopped' }];
  const file = path.join(root, 'lima', e.instanceName, 'lima.yaml');
  try {
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, buildLimaConfig(e));
    await assert.rejects(runtime.migrateSharedMounts(e), { code: 'SHARED_MOUNT_MIGRATION_EXPORTS' });
    assert.deepEqual(parse(await readFile(file, 'utf8')).mounts, []);
    assert.equal(await runtime.sharedMountMaintenancePending(e), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Reconciliation never advertises an interrupted maintenance VM as a running user environment', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mu-share-unit-'));
  const commands: string[][] = [];
  const runtime = new LimaRuntime(root, async (_file, args) => { commands.push(args); return ''; });
  runtime.executable = async () => process.execPath;
  runtime.info = async () => ({ available: true, path: '/test', version: 'test', error: null });
  const manager = new Manager(root, undefined, runtime);
  let revoked = 0; manager.onQuarantine = async () => { revoked++; };
  try {
    const e = await manager.create({ name: 'Interrupted shared mount maintenance' });
    runtime.list = async () => [{ name: e.instanceName, status: 'Running' }];
    await mkdir(path.join(root, 'security'));
    await writeFile(path.join(root, 'security', `${e.instanceName}-shares-migration.json`), JSON.stringify({ version: 1, instanceName: e.instanceName, original: '{}', stage: 'pending' }));
    await manager.reconcile(true);
    assert.equal(manager.store.get(e.id).state, 'error'); assert.equal(revoked, 1);
    assert.ok(commands.some(args => args.includes('stop') && args.includes('--force') && args.includes(e.instanceName)));
    await assert.rejects(manager.assertAccess(e.id), { code: 'ENVIRONMENT_STOPPED' });
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test('Resuming a pending migration retains hardware options and the latest requested resources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mu-share-unit-'));
  const e = environment(); e.cpus = 4; e.memoryGiB = 8;
  let status = 'Stopped';
  const file = path.join(root, 'lima', e.instanceName, 'lima.yaml');
  const hardware = { vz: { rosetta: { enabled: true, binfmt: true } } };
  const runtime = new LimaRuntime(root, async (_file, args, options) => {
    if (args[1] === 'start') {
      const config = parse(await readFile(file, 'utf8'));
      assert.deepEqual(config.mounts, []); assert.deepEqual(config.vmOpts, hardware);
      assert.equal(config.cpus, 4); assert.equal(config.memory, '8GiB'); status = 'Running';
    } else if (args[1] === 'stop') status = 'Stopped';
    else if (args[1] === 'list') return JSON.stringify({ name: e.instanceName, status, config: parse(await readFile(file, 'utf8')) });
    else if (args[1] === 'shell') return options?.input?.includes('MU_SHARED_MIGRATION') ? '{"maintenanceSources":[],"policiesInstalled":1}' : '{"issues":[]}';
    return '';
  });
  runtime.executable = async () => process.execPath;
  runtime.list = async () => [{ name: e.instanceName, status }];
  try {
    const original = stringify({ ...parse(buildLimaConfig({ ...e, cpus: 1, memoryGiB: 2 })), vmOpts: hardware });
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, buildLimaConfig({ ...e, mounts: [] }));
    await mkdir(path.join(root, 'security'));
    await writeFile(path.join(root, 'security', `${e.instanceName}-shares-migration.json`), JSON.stringify({ version: 1, instanceName: e.instanceName, original, stage: 'pending' }));
    await runtime.migrateSharedMounts(e);
    const restored = parse(await readFile(file, 'utf8'));
    assert.equal(restored.cpus, 4); assert.equal(restored.memory, '8GiB'); assert.deepEqual(restored.vmOpts, hardware);
    assert.equal(restored.mounts.length, 1); assert.equal(await runtime.sharedMountMaintenancePending(e), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
