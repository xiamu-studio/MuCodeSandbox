import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetachedTargetError, GuestBrowserHost } from '../server/guest-browser.ts';
import { CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import { RECOVER_BROWSER_INSTALL_SCRIPT } from '../server/browser-install-transaction.ts';
import { RECOVER_BROWSER_UPGRADE_SCRIPT } from '../server/browser-profile-transaction.ts';
import { browserProfileCompatibilityScript } from '../server/browser-profile-version.ts';
import { RECOVER_BROWSER_RESET_SCRIPT } from '../server/browser-reset.ts';
import { AppError } from '../server/errors.ts';
import type { BrowserHost } from '../server/browser.ts';
import type { LimaRuntime } from '../server/runtime.ts';
import type { Environment } from '../shared/types.ts';

interface Attachment {
  sessionId: string;
  targetInfo: { targetId: string; type: string };
}
interface Command { method: string; sessionId?: string }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

function harness() {
  const calls: Command[] = [];
  const fallback: BrowserHost = {
    native: false, available: async () => false, running: () => false,
    open: async () => {}, close: async () => {}, clear: async () => {}, dispose: async () => {},
  };
  const host = new GuestBrowserHost({} as LimaRuntime, fallback);
  const tools = {
    activeSessions: new Set<string>(),
    attached: undefined as ((params: Attachment) => void) | undefined,
    detached: undefined as ((params: { sessionId: string; targetId: string }) => void) | undefined,
    command: async (_method: string, _sessionId?: string): Promise<unknown> => ({}),
    async send(method: string, _params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
      calls.push({ method, sessionId });
      if (sessionId && !this.activeSessions.has(sessionId)) throw new DetachedTargetError('Session with given id not found.');
      return this.command(method, sessionId);
    },
    attach(sessionId: string, targetId = 'initial-page', type = 'page') {
      this.activeSessions.add(sessionId);
      this.attached?.({ sessionId, targetInfo: { targetId, type } });
    },
    detach(sessionId: string) {
      this.activeSessions.delete(sessionId);
      this.detached?.({ sessionId, targetId: 'initial-page' });
    },
  };
  const entry = {
    environment: {
      id: 'synthetic-initialization', identity: { timezone: 'Asia/Tokyo', locale: 'ja-JP' },
      browserUrl: 'https://fixture.test/',
    },
    tools, sessions: new Map<string, string>(), configuration: new Set<Promise<void>>(),
    ready: false, failure: undefined as Error | undefined,
  };
  host.entries.set(entry.environment.id, entry as any);
  host.close = async id => { host.entries.delete(id); };
  const configure = () => (host as any).configure(entry) as Promise<void>;
  const navigations = () => calls.filter(call => call.method === 'Page.navigate');
  const clean = async () => { host.entries.clear(); await host.dispose(); };
  return { host, tools, entry, calls, configure, navigations, clean };
}

test('Initial navigation waits for a page attached during target discovery', { timeout: 2000 }, async () => {
  const probe = harness();
  const localeStarted = deferred<void>();
  const locale = deferred<void>();
  probe.tools.command = async (method, sessionId) => {
    if (method === 'Target.getTargets') {
      probe.tools.attach('discovered-session');
      return { targetInfos: [{ targetId: 'initial-page', type: 'page' }] };
    }
    if (method === 'Target.setAutoAttach' && sessionId === 'discovered-session') {
      localeStarted.resolve();
      await locale.promise;
    }
    return {};
  };
  const configuring = probe.configure();
  try {
    await localeStarted.promise;
    await nextTurn();
    assert.deepEqual(probe.navigations(), [], 'The page must not navigate while related-target setup is pending');
    locale.resolve();
    await configuring;
    assert.deepEqual(probe.navigations(), [{ method: 'Page.navigate', sessionId: 'discovered-session' }]);
  } finally {
    locale.resolve();
    await configuring.catch(() => {});
    await Promise.all([...probe.entry.configuration]);
    await probe.clean();
  }
});

test('Initial navigation re-reads the active page session after configuration', { timeout: 2000 }, async () => {
  const probe = harness();
  const localeStarted = deferred<void>();
  const locale = deferred<void>();
  probe.tools.command = async (method, sessionId) => {
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'initial-page', type: 'page' }] };
    if (method === 'Target.attachToTarget') {
      probe.tools.attach('old-session');
      return { sessionId: 'old-session' };
    }
    if (method === 'Target.setAutoAttach' && sessionId === 'old-session') {
      localeStarted.resolve();
      await locale.promise;
    }
    return {};
  };
  const configuring = probe.configure();
  // Observe a rejection immediately as the old implementation navigates a detached session.
  const completed = configuring.then(() => undefined, error => error as Error);
  try {
    await localeStarted.promise;
    await nextTurn();
    probe.tools.detach('old-session');
    probe.tools.attach('replacement-session');
    locale.resolve();
    assert.equal(await completed, undefined, 'Replacing the page connection must not fail initialization');
    assert.deepEqual(probe.navigations(), [{ method: 'Page.navigate', sessionId: 'replacement-session' }]);
    assert.equal(probe.entry.sessions.get('initial-page'), 'replacement-session');
  } finally {
    locale.resolve();
    await completed;
    await Promise.all([...probe.entry.configuration]);
    await probe.clean();
  }
});

test('Initial navigation rejects a page that detached without a replacement', { timeout: 2000 }, async () => {
  const probe = harness();
  const localeStarted = deferred<void>();
  const locale = deferred<void>();
  probe.tools.command = async (method, sessionId) => {
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'initial-page', type: 'page' }] };
    if (method === 'Target.attachToTarget') {
      probe.tools.attach('detached-session');
      return { sessionId: 'detached-session' };
    }
    if (method === 'Target.setAutoAttach' && sessionId === 'detached-session') {
      localeStarted.resolve();
      await locale.promise;
    }
    return {};
  };
  const configuring = probe.configure();
  const completed = configuring.then(() => undefined, error => error as Error);
  try {
    await localeStarted.promise;
    await nextTurn();
    probe.tools.detach('detached-session');
    locale.resolve();
    assert.ok((await completed) instanceof Error, 'Initialization must reject after losing the page connection');
    assert.deepEqual(probe.navigations(), [], 'No navigation command may use an inactive session');
  } finally {
    locale.resolve();
    await completed;
    await Promise.all([...probe.entry.configuration]);
    await probe.clean();
  }
});

test('A new window sharing its opener renderer does not collide with a per-page locale override', { timeout: 2000 }, async () => {
  const probe = harness();
  let localeOverrides = 0;
  probe.tools.command = async method => {
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'initial-page', type: 'page' }] };
    if (method === 'Target.attachToTarget') { probe.tools.attach('initial-session'); return { sessionId: 'initial-session' }; }
    if (method === 'Emulation.setLocaleOverride' && ++localeOverrides > 1) throw new Error('Another locale override is already in effect');
    return {};
  };
  try {
    await probe.configure();
    probe.tools.attach('popup-session', 'popup-page');
    await Promise.all([...probe.entry.configuration]);
    assert.equal(probe.entry.failure, undefined);
    assert.equal(probe.entry.sessions.get('popup-page'), 'popup-session');
    assert.ok(probe.calls.some(call => call.method === 'Runtime.runIfWaitingForDebugger' && call.sessionId === 'popup-session'));
    assert.ok(!probe.calls.some(call => call.method.startsWith('Emulation.')), 'Linux identity must come from the native launcher in all contexts');
  } finally { await probe.clean(); }
});

test('Native browser inspection accepts a language-only locale and rejects conflicting identity', async () => {
  const probe = harness();
  let actual = { timezone: 'Asia/Tokyo', locale: 'ja', language: 'ja-JP' };
  probe.entry.sessions.set('initial-page', 'initial-session');
  probe.tools.activeSessions.add('initial-session');
  probe.tools.command = async method => method === 'Target.getTargets'
    ? { targetInfos: [{ targetId: 'initial-page', type: 'page' }] }
    : { result: { value: JSON.stringify(actual) } };
  try {
    assert.equal((await probe.host.inspect(probe.entry.environment.id)).matchesConfiguration, true);
    for (const change of [{ locale: 'en-US' }, { locale: 'ja-CN' }, { language: 'ja' }, { timezone: 'America/New_York' }]) {
      actual = { timezone: 'Asia/Tokyo', locale: 'ja', language: 'ja-JP', ...change };
      assert.equal((await probe.host.inspect(probe.entry.environment.id)).matchesConfiguration, false, JSON.stringify(change));
    }
  } finally { await probe.clean(); }
});

test('A browser cannot start when preparing its components changes network protection', { timeout: 2000 }, async () => {
  let checks = 0;
  const calls: string[] = [];
  const runtime = {
    async networkProtection() { calls.push('protection'); return { active: ++checks === 1 }; },
    async management(_environment: Environment, args: string[], options?: { input?: string }) {
      if(options?.input===RECOVER_BROWSER_RESET_SCRIPT){calls.push('reset-recovery');return '';}
      if(options?.input===RECOVER_BROWSER_UPGRADE_SCRIPT){calls.push('upgrade-recovery');return '';}
      if (args[0] === 'bash' && args[1] === '-s' && options?.input === RECOVER_BROWSER_INSTALL_SCRIPT) {
        calls.push('component-marker');
        return CURRENT_BROWSER_RELEASE.recipe;
      }
      if (options?.input === browserProfileCompatibilityScript(CURRENT_BROWSER_RELEASE.version)) { calls.push('profile-compatibility'); return ''; }
      if (args[2]?.includes('command -v Xvfb')) {
        calls.push('component-files');
        return '/usr/bin/Xvfb\n/usr/bin/x11vnc\n/usr/bin/xauth';
      }
      throw new Error('The browser must not start after losing protection');
    },
  } as unknown as LimaRuntime;
  const fallback: BrowserHost = {
    native: false, available: async () => false, running: () => false,
    open: async () => {}, close: async () => {}, clear: async () => {}, dispose: async () => {},
  };
  const host = new GuestBrowserHost(runtime, fallback);
  const environment = {
    id: 'synthetic-protection-loss', kind: 'vm', state: 'running',
    network: { mode: 'http', strict: true, transparent: true },
  } as Environment;
  try {
    await assert.rejects(host.open(environment), error => error instanceof AppError && error.code === 'GUARD_FAILED');
    assert.deepEqual(calls, ['protection', 'reset-recovery', 'upgrade-recovery', 'component-marker', 'profile-compatibility', 'component-files', 'protection']);
    assert.equal(host.running(environment.id), false);
  } finally { await host.dispose(); }
});
