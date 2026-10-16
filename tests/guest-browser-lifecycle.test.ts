import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestBrowserHost } from '../server/guest-browser.ts';
import type { BrowserHost } from '../server/browser.ts';
import type { LimaRuntime } from '../server/runtime.ts';

interface Attachment { sessionId: string; targetInfo: { targetId: string; type: string } }
type Command = { method: string; sessionId?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const calls: Command[] = [];
  const closed: string[] = [];
  const fallback: BrowserHost = {
    native: false, available: async () => false, running: () => false,
    open: async () => {}, close: async () => {}, clear: async () => {}, dispose: async () => {},
  };
  const host = new GuestBrowserHost({} as LimaRuntime, fallback);
  const tools = {
    activeSessions: new Set(['initial-session']),
    attached: undefined as ((params: Attachment) => void) | undefined,
    detached: undefined as ((params: { sessionId: string; targetId?: string }) => void) | undefined,
    command: async (_method: string, _sessionId?: string): Promise<unknown> => ({}),
    async send(method: string, _params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
      calls.push({ method, sessionId });
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'initial-target', type: 'page' }] };
      return this.command(method, sessionId);
    },
    attach(params: Attachment) { this.activeSessions.add(params.sessionId); this.attached?.(params); },
    detach(sessionId: string, targetId?: string) { this.activeSessions.delete(sessionId); this.detached?.({ sessionId, targetId }); },
  };
  const entry = {
    environment: { id: 'synthetic-environment', identity: { timezone: 'Asia/Tokyo', locale: 'ja-JP' }, browserUrl: 'https://fixture.test/' },
    tools, sessions: new Map([['initial-target', 'initial-session']]),
    configuration: new Set<Promise<void>>(), ready: true, failure: undefined as Error | undefined,
  };
  host.entries.set(entry.environment.id, entry as any);
  host.close = async id => { closed.push(id); host.entries.delete(id); };
  const configure = () => (host as any).configure(entry) as Promise<void>;
  const clean = async () => { host.entries.clear(); await host.dispose(); };
  return { host, tools, entry, calls, closed, configure, clean };
}

test('A detached worker with an outstanding configuration command does not close the browser', async () => {
  const probe = harness();
  try {
    await probe.configure();
    const started = deferred<void>();
    const pending = deferred<unknown>();
    probe.tools.command = async (method, sessionId) => {
      if (sessionId === 'worker-session' && method === 'Target.setAutoAttach') {
        started.resolve();
        return pending.promise;
      }
      return {};
    };
    probe.tools.attach({ sessionId: 'worker-session', targetInfo: { targetId: 'worker-target', type: 'worker' } });
    await started.promise;
    const configuration = [...probe.entry.configuration];
    assert.equal(configuration.length, 1);
    probe.tools.detach('worker-session', 'worker-target');
    pending.reject(new Error('Session with given id not found'));
    await Promise.all(configuration);
    assert.deepEqual(probe.closed, []);
    assert.equal(probe.entry.failure, undefined);
    assert.equal(probe.host.entries.get(probe.entry.environment.id), probe.entry);
    assert.ok(!probe.tools.activeSessions.has('worker-session'));
    assert.ok(!probe.calls.some(call => call.sessionId === 'worker-session' && call.method === 'Runtime.runIfWaitingForDebugger'));
  } finally { await probe.clean(); }
});

test('An unexpected target configuration failure on an active page still closes the browser', async () => {
  const probe = harness();
  try {
    await probe.configure();
    const failure = new Error('Related-target setup rejected');
    probe.tools.command = async (method, sessionId) => {
      if (sessionId === 'new-page-session' && method === 'Target.setAutoAttach') throw failure;
      return {};
    };
    probe.tools.attach({ sessionId: 'new-page-session', targetInfo: { targetId: 'new-page-target', type: 'page' } });
    const configuration = [...probe.entry.configuration];
    assert.equal(configuration.length, 1);
    await Promise.all(configuration);
    assert.ok(probe.tools.activeSessions.has('new-page-session'));
    assert.equal(probe.entry.failure, failure);
    assert.deepEqual(probe.closed, [probe.entry.environment.id]);
    assert.ok(!probe.host.entries.has(probe.entry.environment.id));
    assert.ok(!probe.calls.some(call => call.sessionId === 'new-page-session' && call.method === 'Runtime.runIfWaitingForDebugger'));
  } finally { await probe.clean(); }
});
