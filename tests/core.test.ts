import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { environmentSchema, validateMounts, proxyUrl, redact } from '../server/validation.ts';
import { Store } from '../server/store.ts';
import { buildLimaConfig } from '../server/lima-config.ts';
import { parseLimaList } from '../server/runtime.ts';
import { run } from '../server/process.ts';
import type { Environment } from '../shared/types.ts';
import { spawn as spawnPty } from 'node-pty';

function environment(): Environment { return { ...environmentSchema.parse({ name: 'Test' }), id: randomUUID(), instanceName: 'mu-test123', state: 'not_created', lastError: null, browserRunning: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }

test('Lima config shares only specified paths, disables SSH credential forwarding and automatic ports', () => {
  const e = environment();
  e.mounts = [{ id: randomUUID(), hostPath: '/Users/test/project with spaces', guestPath: '/workspace/project', writable: false }];
  e.ports = [{ id: randomUUID(), guestPort: 3000, hostPort: 4000 }];
  const config = parse(buildLimaConfig(e));
  assert.equal(config.vmType, 'vz');
  assert.equal(config.mountType, 'virtiofs');
  assert.equal(config.base, undefined);
  assert.deepEqual(config.mounts, [{ location: e.mounts[0].hostPath, mountPoint: '/workspace/project', writable: false }]);
  assert.equal(config.ssh.forwardAgent, false);
  assert.equal(config.ssh.loadDotSSHPubKeys, false);
  assert.equal(config.propagateProxyEnv, false);
  assert.equal(config.portForwards[0].hostIP, '127.0.0.1');
  assert.equal(config.portForwards[1].ignore, true);
  assert.equal(config.portForwards[1].proto, 'any');
  assert.equal(config.portForwards[1].guestIP, '0.0.0.0');
  assert.equal(config.portForwards[1].guestIPMustBeZero, false);
  assert.equal(config.portForwards[0].proto, 'tcp');
  assert.match(config.images[0].digest, /^sha256:[a-f0-9]{64}$/);
});

test('Proxy construction encodes credentials and uses the guest gateway only for loopback', () => {
  const config = { mode: 'socks5' as const, host: '127.0.0.1', port: 1080, username: 'a@b', password: 'p:/@ #', noProxy: '', strict: false };
  const url = new URL(proxyUrl(config, true));
  assert.equal(url.hostname, 'host.lima.internal');
  assert.equal(decodeURIComponent(url.username), 'a@b');
  assert.equal(decodeURIComponent(url.password), 'p:/@ #');
  assert.equal(new URL(proxyUrl({ ...config, host: 'proxy.example.com' }, true)).hostname, 'proxy.example.com');
  assert.equal(proxyUrl({ ...config, mode: 'direct' }), '');
});

test('Rejects malformed proxy addresses, forbidden URL schemes and unknown configuration fields', () => {
  assert.throws(() => environmentSchema.parse({ name: 'X', network: { mode: 'http', host: 'example.com/;sh' } }));
  assert.throws(() => environmentSchema.parse({ name: 'X', browserUrl: 'file:///etc/passwd' }));
  assert.throws(() => environmentSchema.parse({ name: 'X', state: 'running' }));
  assert.throws(() => environmentSchema.parse({ name: 'X', mounts: [{ id: randomUUID(), hostPath: '/tmp', guestPath: '/etc', writable: true }] }));
});

test('Directory validation resolves symlinks and rejects sensitive, missing or overlapping shares', async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-test-'));
  try {
    const data = path.join(root, 'private'); const project = path.join(root, 'project');
    await mkdir(data); await mkdir(project);
    const m = { id: randomUUID(), hostPath: project, guestPath: '/workspace/project', writable: false };
    assert.equal((await validateMounts([m], data))[0].hostPath, project);
    await assert.rejects(validateMounts([{ ...m, hostPath: homedir() }], data));
    await assert.rejects(validateMounts([{ ...m, hostPath: data }], data));
    await assert.rejects(validateMounts([{ ...m, hostPath: root }], data));
    await assert.rejects(validateMounts([{ ...m, hostPath: path.join(project, 'missing') }], data));
    await assert.rejects(validateMounts([m, { ...m, id: randomUUID(), guestPath: '/workspace/project/nested' }], data));
    await assert.rejects(validateMounts([{ ...m, guestPath: '/workspace/project/../other' }], data));
    const link = path.join(root, 'alias'); await symlink(data, link);
    await assert.rejects(validateMounts([{ ...m, hostPath: link }], data));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SQLite stores encrypted proxy credentials and redacted logs while preserving plaintext for runtime access', async () => {
  const root = await mkdtemp(path.join(homedir(), '.mu-test-'));
  let store = new Store(root);
  try {
    const e = environment(); e.network = { mode: 'http', host: 'proxy.example.com', port: 8080, username: 'test', password: 'unique-secret-123', noProxy: '', strict: false };
    store.save(e);
    assert.equal(store.get(e.id).network.password, 'unique-secret-123');
    const raw = store.db.prepare('SELECT config FROM environments').get() as { config: string };
    assert.ok(!raw.config.includes('unique-secret-123'));
    assert.ok(raw.config.includes('enc:'));
    assert.equal(store.public(store.get(e.id)).network.password, undefined);
    assert.equal(store.public(store.get(e.id)).network.passwordConfigured, true);
    store.log(e.id, null, 'https://user:unique-secret-123@proxy.test token=hidden');
    assert.ok(!store.logs(e.id)[0].message.includes('unique-secret-123'));
    assert.ok(!store.logs(e.id)[0].message.includes('hidden'));
    const job = store.newJob(e.id, 'start');
    store.close(); store = new Store(root);
    assert.equal(store.get(e.id).network.password, 'unique-secret-123');
    assert.equal(store.jobs().find(j => j.id === job.id)?.status, 'failed');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Lima list parser handles both line-delimited records and array output', () => {
  assert.deepEqual(parseLimaList('{"name":"mu-a","status":"Running"}\n{"name":"mu-b","status":"Stopped"}\n'), [{ name: 'mu-a', status: 'Running' }, { name: 'mu-b', status: 'Stopped' }]);
  assert.deepEqual(parseLimaList('[{"name":"mu-a","status":"Running"}]'), [{ name: 'mu-a', status: 'Running' }]);
  assert.deepEqual(parseLimaList(''), []);
});

test('Process runner never interprets shell arguments and honors cancellation and timeouts', async () => {
  const literal = '$(touch /tmp/this-must-never-exist); echo secret';
  const output = await run(process.execPath, ['-e', 'console.log(process.argv[1])', literal]);
  assert.equal(output.trim(), literal);
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 }), /超时/);
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /取消/);
});

test('Timeout is bounded when a detached descendant retains inherited output pipes', async () => {
  let descendant = 0;
  const code = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});console.log('DESCENDANT='+c.pid);c.unref();`;
  const started = Date.now();
  try {
    await assert.rejects(run(process.execPath, ['-e', code], {
      timeoutMs: 1000,
      onOutput: text => { descendant = Number(text.match(/DESCENDANT=(\d+)/)?.[1] ?? descendant); },
    }), /超时/);
    assert.ok(descendant > 0);
    assert.ok(Date.now() - started < 5000);
  } finally { if (descendant) try { process.kill(-descendant, 'SIGKILL'); } catch { /* Already stopped. */ } }
});

test('Redaction masks authenticated HTTP and SOCKS URLs', () => {
  const value = redact('http://user:password@host socks5h://name:secret@proxy API_KEY=abcd');
  assert.ok(!value.includes('password')); assert.ok(!value.includes('secret')); assert.ok(!value.includes('abcd'));
});

test('Native terminal provides an actual PTY and accepts interactive input', async () => {
  const child = spawnPty('/bin/bash', ['--noprofile', '--norc'], { name: 'xterm-256color', cols: 90, rows: 32, env: process.env });
  let output = '';
  let exited = false;
  const exit = new Promise<void>(resolve => child.onExit(() => { exited = true; resolve(); }));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`PTY timeout: ${output}`)), 5000);
      child.onData(data => { output += data; if (output.includes('MU_PTY_OK') && output.includes('32 90')) { clearTimeout(timeout); resolve(); } });
      child.onExit(() => { clearTimeout(timeout); reject(new Error(`PTY exited: ${output}`)); });
      child.write('printf "MU_%s_OK\\n" PTY; stty size\r');
    });
  } finally {
    let escalation: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!exited) {
        child.write('exit\r');
        escalation = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } }, 1000);
      }
      await exit;
    } finally { clearTimeout(escalation); }
  }
});
