import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Environment } from '../shared/types.ts';
import { ensureGuestBrowser, GUEST_CHROMIUM_VERSION, startGuestBrowser } from '../server/guest-browser-runtime.ts';
import { CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import { RECOVER_BROWSER_INSTALL_SCRIPT, browserInstallTransactionScript } from '../server/browser-install-transaction.ts';
import { browserProfileCompatibilityScript } from '../server/browser-profile-version.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { environmentSchema } from '../server/validation.ts';

const environment = (): Environment => ({
  ...environmentSchema.parse({ name: 'Guest browser test' }), id: randomUUID(),
  instanceName: 'mu-browser-test', state: 'running', lastError: null,
  browserRunning: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

test('Linux browser refuses a corrupt official download before copying or installing anything in the guest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mu-browser-download-'));
  const calls: string[][] = [];
  const managementInputs: (string | undefined)[] = [];
  const runtime = new LimaRuntime(root, async (file, args) => {
    calls.push([file, ...args]);
    await writeFile(args[args.indexOf('--output') + 1], 'corrupt download');
    return '';
  });
  runtime.management = async (_e, args, options) => { calls.push(['management', ...args]); managementInputs.push(options?.input); return ''; };
  runtime.command = async args => { calls.push(['command', ...args]); return ''; };
  try {
    const archive = path.join(root, 'tools', 'guest-browser', `chrome-${GUEST_CHROMIUM_VERSION}-linux-arm64.${CURRENT_BROWSER_RELEASE.format}`);
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(archive, 'corrupt cached file');
    await assert.rejects(ensureGuestBrowser(runtime, environment()), { code: 'CHECKSUM_MISMATCH' });
    assert.equal(calls.filter(call => call[0] === 'management').length, 2);
    assert.deepEqual(managementInputs, [RECOVER_BROWSER_INSTALL_SCRIPT, browserProfileCompatibilityScript(CURRENT_BROWSER_RELEASE.version)]);
    assert.equal(calls.filter(call => call[0] === 'command').length, 0);
    assert.equal(await readFile(archive, 'utf8'), 'corrupt cached file');
    const download = calls.find(call => call[0] === '/usr/bin/curl');
    assert.ok(download);
    assert.equal(download[download.indexOf('--proto-redir') + 1], '=https');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux browser rejects unsupported proxy mode and invalid VNC credentials before guest access', async () => {
  let called = false;
  const runtime = new LimaRuntime('/unused', async () => { called = true; return ''; });
  const e = environment();
  e.network = { ...e.network, mode: 'http', host: '127.0.0.1', strict: false, transparent: false };
  await assert.rejects(ensureGuestBrowser(runtime, e), { code: 'BROWSER_REQUIRES_TRANSPARENT' });
  e.network = { ...e.network, mode: 'direct' };
  await assert.rejects(startGuestBrowser(runtime, e, 'too-long-password'), /密码格式无效/);
  assert.equal(called, false);
});

test('Interrupted browser installation recovery precedes trusting an existing recipe', async () => {
  const calls: string[] = [];
  const runtime = new LimaRuntime('/unused');
  runtime.management = async (_e, args, options) => {
    if (options?.input === RECOVER_BROWSER_INSTALL_SCRIPT) { calls.push('recover'); return `${CURRENT_BROWSER_RELEASE.recipe}\n`; }
    if (options?.input === browserProfileCompatibilityScript(CURRENT_BROWSER_RELEASE.version)) { calls.push('profile'); return ''; }
    if (args[2]?.includes('command -v Xvfb')) { calls.push('components'); return '/usr/bin/Xvfb'; }
    throw new Error('Existing valid installation must not be reinstalled');
  };
  await ensureGuestBrowser(runtime, environment()); assert.deepEqual(calls, ['recover', 'profile', 'components']);
  runtime.management = async () => { throw new Error('Recovery journal is invalid'); };
  await assert.rejects(ensureGuestBrowser(runtime, environment()), /Recovery journal is invalid/);
});

test('Browser transaction generation rejects version mismatches and unapproved guest archive paths', () => {
  const recipe = CURRENT_BROWSER_RELEASE.recipe;
  assert.throws(() => browserInstallTransactionScript('1.2.3.4', recipe, '/var/lib/mucodesandbox/browser-install/archive.zip'));
  assert.throws(() => browserInstallTransactionScript(GUEST_CHROMIUM_VERSION, recipe, '/tmp/arbitrary.zip'));
});

test('Linux browser starts software GL without helper threads and stops when the graphics sandbox check fails', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const runtime = new LimaRuntime('/unused');
  runtime.management = async (_environment, args, options) => {
    calls.push({ args, input: options?.input });
    if (args[0] === 'sudo') return JSON.stringify({ unitActive: true, developmentUid: 502, processes: [] });
    return '';
  };
  await assert.rejects(startGuestBrowser(runtime, environment(), 'abcdefgh'), { code: 'BROWSER_SANDBOX_FAILED' });
  const launch = calls.find(call=>call.input?.includes('mu-guest-browser'))!.input!;
  assert.ok(launch.includes('--use-gl=angle') && launch.includes('--use-angle=gl') && launch.includes('--ignore-gpu-blocklist'));
  assert.ok(launch.includes('export LP_NUM_THREADS=0 GALLIUM_DRIVER=llvmpipe LIBGL_ALWAYS_SOFTWARE=1 MESA_SHADER_CACHE_DISABLE=true'));
  assert.ok(launch.includes('PULSE_SERVER='));
  assert.ok(!launch.includes('Xtigervnc :99')&&!launch.includes('module-null-sink'));
  assert.match(launch,/BindsTo=mucodesandbox-display.service/);
  assert.ok(launch.includes('exec '));
  assert.ok(!launch.includes('--gpu-sandbox-start-early') && !launch.includes('--use-gl=disabled'));
  assert.ok(!launch.includes('--no-sandbox') && !launch.includes('--disable-gpu-sandbox') && !launch.includes('--enable-unsafe-swiftshader'));
  assert.ok(launch.includes("urlopen('http://127.0.0.1:9222"));
  assert.ok(calls.some(call => call.args[0] === 'sudo' && call.args[1] === 'python3'));
  assert.ok(calls.at(-1)!.input?.includes('sudo systemctl stop mucodesandbox-browser.service'));
  assert.ok(!calls.at(-1)!.input?.includes('rm -rf /run/mucodesandbox-browser-secret'));
});
