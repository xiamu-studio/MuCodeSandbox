import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LimaRuntime } from '../server/runtime.ts';
import { run } from '../server/process.ts';
import { baseDiskHash } from '../server/protected-base.ts';

// Only stopped, signed local base disks may seed a disposable test directory.
export async function seedProtectedTestBase(runtime: LimaRuntime, sourceDirectory: string) {
  assert.notEqual(path.resolve(runtime.dataDir), path.resolve(sourceDirectory));
  const name = 'mu-protected-base-v1', sourceLima = path.join(sourceDirectory, 'lima');
  const executable = await runtime.executable(); assert.ok(executable);
  const list = await run(executable, ['--tty=false', 'list', '--json'], { env: { ...runtime.env(), LIMA_HOME: sourceLima } });
  const instances = list.trim().startsWith('[') ? JSON.parse(list) : list.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(instances.find((row: any) => row.name === name)?.status, 'Stopped');
  const signed = JSON.parse(await readFile(path.join(sourceDirectory, 'tools/protected-base/manifest.json'), 'utf8'));
  const sourceKey = await readFile(path.join(sourceDirectory, 'credentials.key'));
  const sign = (key: Buffer) => createHmac('sha256', key).update('MuCodeSandbox protected base v1\n').update(signed.body).digest('hex');
  assert.equal(signed.mac, sign(sourceKey));
  const manifest = JSON.parse(signed.body); assert.equal(manifest.version, 1);
  const sourceDisk = path.join(sourceLima, name, 'disk'); assert.equal(await baseDiskHash(sourceDisk), manifest.hash);
  const config = await readFile(path.join(sourceDirectory, 'tools/protected-base/base.yaml'));
  const destination = path.join(runtime.dataDir, 'tools/protected-base'); await mkdir(destination, { recursive: true });
  const configFile = path.join(destination, 'base.yaml'); await writeFile(configFile, config, { mode: 0o600 });
  await runtime.command(['create', '--name', name, configFile], { timeoutMs: 120_000 });
  const targetDisk = path.join(runtime.limaHome, name, 'disk'); await rm(targetDisk);
  await run('/bin/cp', ['-c', sourceDisk, targetDisk], { timeoutMs: 120_000 });
  assert.equal(await baseDiskHash(targetDisk), manifest.hash);
  assert.equal(await baseDiskHash(sourceDisk), manifest.hash);
  const ownedKey = await readFile(path.join(runtime.dataDir, 'credentials.key'));
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ body: signed.body, mac: sign(ownedKey) }), { mode: 0o600 });
  const markerBytes = await readFile(path.join(sourceDirectory, 'security', `${name}.json`));
  const marker = JSON.parse(markerBytes.toString());
  assert.ok(marker.prepared && marker.bootArmed && marker.conservative);
  await mkdir(path.join(runtime.dataDir, 'security'), { recursive: true });
  await writeFile(path.join(runtime.dataDir, 'security', `${name}.json`), markerBytes, { mode: 0o600 });
  return { sourceDirectory, sourceStopped: true, image: manifest.image, recipe: manifest.recipe,
    diskSha256: manifest.hash, sourceUnchanged: true, copiedWithFilesystemClone: true };
}
