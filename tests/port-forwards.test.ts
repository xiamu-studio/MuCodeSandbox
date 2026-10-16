import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { LimaRuntime } from '../server/runtime.ts';
import { environmentSchema } from '../server/validation.ts';
import { limaPortForwards } from '../server/lima-config.ts';
import type { Environment } from '../shared/types.ts';

test('Stopped legacy VMs migrate only port forwarding before boot, preserving other Lima settings', async () => {
  const directory = await mkdtemp(path.join(homedir(), '.mu-port-migration-'));
  const e: Environment = { ...environmentSchema.parse({ name: 'Ports', ports: [{ id: randomUUID(), guestPort: 8080, hostPort: 18080 }] }), id: randomUUID(), instanceName: 'mu-port-test', state: 'stopped', lastError: null, browserRunning: false, createdAt: '', updatedAt: '' };
  const file = path.join(directory, 'lima', e.instanceName, 'lima.yaml');
  const original = { vmType: 'vz', env: { HTTP_PROXY: 'retained-setting' }, mounts: [{ location: '/fixture' }], provision: [{ script: 'retained-script' }], portForwards: [{ ignore: true, proto: 'any', guestPortRange: [1, 65535] }] };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringify(original));
  let started = false;
  const runtime = new LimaRuntime(directory, async (_file, args) => {
    if (args[1] === 'list') return JSON.stringify([{ name: e.instanceName, status: 'Stopped' }]);
    if (args[1] === 'start') {
      const config = parse(await readFile(file, 'utf8'));
      assert.deepEqual(config.portForwards, limaPortForwards(e));
      started = true;
    }
    return '';
  });
  runtime.executable = async () => '/fixture/limactl';
  try {
    await runtime.start(e, {});
    assert.ok(started);
    const config = parse(await readFile(file, 'utf8'));
    assert.deepEqual({ ...config, portForwards: original.portForwards }, original);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
