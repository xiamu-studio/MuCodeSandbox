import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FIXED_DISPLAY, FIXED_DISPLAY_PRESETS, displayPixels, displayPreference, displayRequestSchema, fitDisplay, guestPresentation, type GuestDisplay } from '../shared/guest-display.ts';
import { configureGuestDisplay, type DisplaySessionOperations } from '../server/guest-display-session.ts';
import { GuestBrowserHost, type DevTools } from '../server/guest-browser.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import type { BrowserHost } from '../server/browser.ts';
import type { Environment } from '../shared/types.ts';
import type { ChildProcess } from 'node:child_process';
import { environmentSchema } from '../server/validation.ts';

function fixture() {
  const calls: string[] = [];
  let active = true;
  const operations: DisplaySessionOperations = {
    assertCurrent: () => { if (!active) throw Error('Browser session closed'); },
    applyDpi: async request => { calls.push(`dpi:${request.scaleFactor}`); },
    resizePixels: async (width, height) => { calls.push(`pixels:${width}x${height}`); return { width, height }; },
    readNativeScreen: async () => { calls.push('screen'); return { width: 1600, height: 1000 }; },
    resizeBrowserWindow: async (width, height) => { calls.push(`window:${width}x${height}`); },
    waitForDensity: async () => { calls.push('wait'); },
  };
  return { calls, operations, revoke: () => { active = false; } };
}

test('Fixed desktop presets keep 2x native density and reject oversized or untrusted settings', () => {
  for (const preset of FIXED_DISPLAY_PRESETS) {
    const actual = displayPixels({ ...preset, scaleFactor: 2, mode: 'fixed' });
    assert.ok(actual.width <= 8192 && actual.height <= 8192 && actual.width * actual.height <= 16_000_000);
  }
  assert.equal(displayPixels({ cssWidth: 2560, cssHeight: 1440, scaleFactor: 2, mode: 'fixed' }).width * 2880, 14_745_600);
  for (const value of [
    { cssWidth: 2560, cssHeight: 1600, scaleFactor: 2, mode: 'fixed' },
    { ...DEFAULT_FIXED_DISPLAY, scaleFactor: 1 },
    { ...DEFAULT_FIXED_DISPLAY, mode: 'pretend' },
    { ...DEFAULT_FIXED_DISPLAY, screenWidth: 1920 },
  ]) assert.equal(displayRequestSchema.safeParse(value).success, false);
  assert.equal(displayRequestSchema.safeParse({ cssWidth: 1280, cssHeight: 800, scaleFactor: 1 }).success, true);
});

test('Adaptive dimensions retain valid minimums for extreme aspect ratios and bounded native density', () => {
  for (const [width, height, ratio] of [[20000, 240, 4], [320, 20000, 4], [7680, 4320, 2], [8192, 8192, 1.333], [Infinity, NaN, NaN]]) {
    const actual = displayPixels(fitDisplay(width, height, ratio));
    assert.ok(actual.cssWidth >= 320 && actual.cssHeight >= 240);
    assert.ok(actual.width <= 8192 && actual.height <= 8192 && actual.width * actual.height <= 16_000_000);
  }
});

test('Native viewing crops/scrolls without changing desktop and maps one source pixel to one host physical pixel', () => {
  const source = displayPixels(DEFAULT_FIXED_DISPLAY);
  for (const hostDensity of [1, 1.5, 2, 3]) {
    const normal = guestPresentation(source, 988, 618, hostDensity, 'native');
    const fullscreen = guestPresentation(source, 1470, 875, hostDensity, 'native');
    assert.equal(normal.width * hostDensity, source.width);
    assert.equal(normal.height * hostDensity, source.height);
    assert.equal(normal.width, fullscreen.width); assert.equal(normal.height, fullscreen.height);
    assert.equal(normal.downscaled, false);
    assert.equal(normal.scrolls, true);
  }
  assert.deepEqual(source, { ...DEFAULT_FIXED_DISPLAY, width: 3200, height: 2000 });
});

test('Fit viewing only downsamples; a large fullscreen viewport never upscales source pixels', () => {
  const source = displayPixels(DEFAULT_FIXED_DISPLAY);
  const small = guestPresentation(source, 988, 618, 2, 'fit');
  assert.ok(small.width <= 988 && small.height <= 618);
  assert.equal(small.downscaled, true); assert.equal(small.scrolls, false);
  const large = guestPresentation(source, 3840, 2160, 2, 'fit');
  assert.equal(large.width, 1600); assert.equal(large.height, 1000);
  assert.equal(large.downscaled, false);
});

test('Display preference recovers the current browser session and preserves older adaptive sessions', () => {
  const saved: GuestDisplay = { ...displayPixels(DEFAULT_FIXED_DISPLAY), browserScaleFactor: 2, matched: true };
  assert.deepEqual(displayPreference(saved), DEFAULT_FIXED_DISPLAY);
  assert.deepEqual(displayPreference(), DEFAULT_FIXED_DISPLAY);
  const legacy = { ...saved, mode: undefined };
  assert.equal(displayPreference(legacy).mode, 'adaptive');
});

test('Fixed setup changes real DPI/framebuffer/window and confirms both native screen dimensions', async () => {
  const f = fixture();
  const actual = await configureGuestDisplay(undefined, DEFAULT_FIXED_DISPLAY, f.operations);
  assert.deepEqual(f.calls, ['dpi:2', 'pixels:3200x2000', 'screen', 'window:1600x1000']);
  assert.equal(actual.mode, 'fixed'); assert.equal(actual.matched, true);
  assert.equal(actual.browserScaleFactor, 2);
  assert.equal(actual.screenWidth, 1600); assert.equal(actual.screenHeight, 1000);
});

test('Confirmed equal dimensions and mode-only changes leave the framebuffer and browser window alone', async () => {
  const f = fixture();
  const previous = await configureGuestDisplay(undefined, DEFAULT_FIXED_DISPLAY, f.operations);
  f.calls.length = 0;
  const same = await configureGuestDisplay(previous, DEFAULT_FIXED_DISPLAY, f.operations);
  assert.deepEqual(same, previous); assert.deepEqual(f.calls, []);
  const adaptive = await configureGuestDisplay(same, { ...DEFAULT_FIXED_DISPLAY, mode: 'adaptive' }, f.operations);
  assert.equal(adaptive.mode, 'adaptive'); assert.deepEqual(f.calls, []);
});

test('Wrong native screen height is not accepted as matched and a later retry is not skipped', async () => {
  const f = fixture();
  f.operations.readNativeScreen = async () => ({ width: 1600, height: 900 });
  const mismatched = await configureGuestDisplay(undefined, DEFAULT_FIXED_DISPLAY, f.operations);
  assert.equal(mismatched.matched, false); assert.equal(mismatched.browserScaleFactor, 2);
  assert.equal(f.calls.filter(value => value === 'wait').length, 11);
  f.calls.length = 0;
  f.operations.readNativeScreen = async () => ({ width: 1600, height: 1000 });
  const corrected = await configureGuestDisplay(mismatched, DEFAULT_FIXED_DISPLAY, f.operations);
  assert.equal(corrected.matched, true); assert.equal(f.calls[0], 'dpi:2');
});

test('Closing after a DPI operation rejects a late resize before framebuffer/window mutations', async () => {
  const f = fixture();
  f.operations.applyDpi = async () => { f.calls.push('dpi'); f.revoke(); };
  await assert.rejects(configureGuestDisplay(undefined, DEFAULT_FIXED_DISPLAY, f.operations), /session closed/);
  assert.deepEqual(f.calls, ['dpi']);
});

test('Rejected framebuffer resizing stops before reading screen values or resizing browser window', async () => {
  const f = fixture();
  f.operations.resizePixels = async () => { throw Error('Display resize rejected'); };
  await assert.rejects(configureGuestDisplay(undefined, DEFAULT_FIXED_DISPLAY, f.operations), /Display resize rejected/);
  assert.deepEqual(f.calls, ['dpi:2']);
});

function hostFixture() {
  const runtime = new LimaRuntime('/tmp/mu-display-session-fixture');
  const fallback: BrowserHost = { native: false, available: async () => true, running: () => false, open: async () => {}, close: async () => {}, clear: async () => {}, dispose: async () => {} };
  const host = new GuestBrowserHost(runtime, fallback);
  const environment: Environment = { ...environmentSchema.parse({ name: 'Fixed desktop session' }), id: 'display-fixture', instanceName: 'mu-display-fixture', state: 'running', lastError: null, browserRunning: true, createdAt: '', updatedAt: '' };
  const entry: Parameters<typeof host.entries.set>[1] = {
    environment, release: CURRENT_BROWSER_RELEASE, password: 'fixture8', directory: '/tmp/mu-display-fixture', vnc: '/tmp/mu-display-fixture/vnc.sock', cdp: '/tmp/mu-display-fixture/cdp.sock',
    transport: {} as ChildProcess, tools: { activeSessions: new Set() } as DevTools, ready: true, sessions: new Map(), configuration: new Set(),
    display: { ...displayPixels(DEFAULT_FIXED_DISPLAY), browserScaleFactor: 2, screenWidth: 1600, screenHeight: 1000, matched: true },
  };
  runtime.management = async () => { throw Error('Cached display must not mutate the VM'); };
  host.entries.set(environment.id, entry);
  return { host, entry, id: environment.id };
}

test('Host display operations authorize and serialize mode updates, and expose the saved session choice', async () => {
  const f = hostFixture();
  let release!: () => void, authorizations = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.host.authorize = async () => { if (++authorizations === 1) await gate; };
  try {
    const fixed = f.host.resize(f.id, DEFAULT_FIXED_DISPLAY);
    const adaptive = f.host.resize(f.id, { ...DEFAULT_FIXED_DISPLAY, mode: 'adaptive' });
    await Promise.resolve();
    assert.equal(authorizations, 1, 'the second mode operation must wait for the first authorization');
    release();
    assert.equal((await fixed).mode, 'fixed'); assert.equal((await adaptive).mode, 'adaptive');
    assert.equal(authorizations, 2);
    assert.equal(f.host.info(f.id).display?.mode, 'adaptive');
    assert.equal(f.entry.displayOperation, undefined);
  } finally { release(); f.host.entries.clear(); f.host.wss.close(); }
});

test('Host display operation rechecks session after authorization and refuses a late saved-mode update', async () => {
  const f = hostFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.host.authorize = async () => { await gate; };
  try {
    const pending = f.host.resize(f.id, { ...DEFAULT_FIXED_DISPLAY, mode: 'adaptive' });
    f.host.entries.delete(f.id); release();
    await assert.rejects(pending, /浏览器连接已关闭/);
    assert.equal(f.entry.display?.mode, 'fixed');
  } finally { release(); f.host.entries.clear(); f.host.wss.close(); }
});
