import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { createService } from '../server/service.ts';
import { CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import type { BrowserHost } from '../server/browser.ts';
import type { NetworkProtection } from '../shared/types.ts';

class Transport extends EventEmitter {
  exitCode: number | null = null;
  kill(signal: string) { this.exitCode = 0; this.emit('exit', 0, signal); return true; }
}
async function fixture() {
  const root = await mkdtemp(path.join(homedir(), '.mu-audio-api-test-'));
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const browser: BrowserHost = { native: false, available: async () => false, running: () => false, open: async () => {}, close: async () => {}, clear: async () => {}, dispose: async () => {} };
  const service = await createService({ dataDir: root, port: 0, rootDir: project, browser });
  const environment = await service.manager.create({ name: 'Audio API fixture', network: { mode: 'http', host: 'proxy.example', strict: true, transparent: true } });
  service.manager.store.state(environment.id, 'running');
  let accessChecks = 0, networkChecks = 0, captures = 0, stopped = 0;
  let protection = { active: true, integrity: 'verified' } as NetworkProtection;
  service.manager.assertAccess = async () => { accessChecks++; return undefined; };
  service.manager.runtime.networkProtection = async () => { networkChecks++; return protection; };
  service.manager.runtime.management = async () => '';
  service.guestAudio.options.capture = () => { captures++; return { stream: new PassThrough(), stop() { stopped++; } }; };
  const directory = path.join(root, 'viewer'); await mkdir(directory);
  const entry = { environment: service.manager.store.get(environment.id), ready: true, release: CURRENT_BROWSER_RELEASE, password: 'fixture8', transport: new Transport() as unknown as ChildProcess, directory, vnc: path.join(directory, 'vnc'), cdp: path.join(directory, 'cdp'), sessions: new Map<string, string>(), configuration: new Set<Promise<void>>() };
  service.guestBrowser.entries.set(environment.id, entry);
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  const ticket = (requestHeaders: Record<string, string> = headers) => fetch(`${service.url}/api/environments/${environment.id}/guest-audio-ticket`, { method: 'POST', headers: requestHeaders, body: '{}' });
  const clients = new Set<WebSocket>();
  function connect(key: string, origin: string | null = service.url) {
    const socket = new WebSocket(`${service.url.replace('http:', 'ws:')}/guest-audio?ticket=${key}`, { origin: origin ?? undefined, handshakeTimeout: 2000 });
    clients.add(socket); socket.once('close', () => clients.delete(socket)); socket.on('error', () => {});
    const opened = new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('Audio rejected'))); });
    return { socket, opened };
  }
  return { service, environment, entry, headers, ticket, connect, captures: () => captures, stopped: () => stopped, accessChecks: () => accessChecks, networkChecks: () => networkChecks,
    protection(value: NetworkProtection) { protection = value; },
    async close() { for (const socket of clients) socket.terminate(); await service.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test('Service audio tickets require API token, source and actual runtime integrity', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.ticket({ 'Content-Type': 'application/json' })).status, 401);
    assert.equal((await f.ticket({ ...f.headers, Origin: 'https://bad.example' })).status, 403);
    assert.equal(f.accessChecks(), 0); assert.equal(f.captures(), 0);
    for (const protection of [{ active: true, integrity: 'changed' }, { active: true, integrity: 'unverified' }, { active: false, integrity: 'verified' }]) {
      f.protection(protection as NetworkProtection);
      const response = await f.ticket(); assert.equal(response.status, 409); assert.equal((await response.json()).code, 'GUARD_FAILED');
      assert.equal(f.service.guestAudio.tickets.size, 0);
    }
    assert.equal(f.accessChecks(), 3); assert.equal(f.networkChecks(), 3); assert.equal(f.captures(), 0);
    f.protection({ active: true, integrity: 'verified' } as NetworkProtection);
    const response = await f.ticket(); assert.equal(response.status, 200); const { ticket } = await response.json();
    await assert.rejects(f.connect(ticket, null).opened); assert.equal(f.service.guestAudio.tickets.size, 0);
    const approved = await (await f.ticket()).json(); const client = f.connect(approved.ticket); await client.opened;
    assert.equal(f.captures(), 1); assert.ok(f.accessChecks() >= 5); assert.ok(f.networkChecks() >= 5);
  } finally { await f.close(); }
});

test('Service closes audio immediately before browser flush and on environment quarantine', async () => {
  for (const quarantine of [false, true]) {
    const f = await fixture();
    try {
      const { ticket } = await (await f.ticket()).json(); const client = f.connect(ticket); await client.opened;
      const socket = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN as number });
      Object.assign(f.entry, { tools: { socket, async send() { assert.equal(f.service.guestAudio.peers.size, 0); socket.readyState = WebSocket.CLOSED; socket.emit('close'); }, close() {} } });
      const closing = quarantine ? f.service.manager.onQuarantine!(f.environment.id) : f.service.guestBrowser.close(f.environment.id);
      assert.equal(f.service.guestAudio.peers.size, 0); assert.equal(f.service.guestAudio.tickets.size, 0);
      await closing; await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.stopped(), 1);
      assert.equal(f.service.guestBrowser.entries.has(f.environment.id), false);
    } finally { await f.close(); }
  }
});
