import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer as createHTTPServer } from 'node:http';
import { createServer as createSocketServer, type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { GuestBrowserHost } from '../server/guest-browser.ts';
import { CURRENT_BROWSER_RELEASE } from '../server/browser-releases.ts';
import { LimaRuntime } from '../server/runtime.ts';
import type { BrowserHost } from '../server/browser.ts';
import type { Environment, NetworkProtection } from '../shared/types.ts';
import { environmentSchema } from '../server/validation.ts';

class TestTransport extends EventEmitter {
  exitCode: number | null = null;
  kill(signal: string) { this.exitCode = 0; this.emit('exit', 0, signal); return true; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean, message: string) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < end, message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture() {
  const directory = await mkdtemp('/tmp/mu-rfb-');
  const runtime = new LimaRuntime(directory);
  let protectedNetwork = true;
  let healthCalls = 0;
  let healthGate: ReturnType<typeof deferred<void>> | undefined;
  const management: string[][] = [];
  runtime.networkProtection = async () => {
    healthCalls++;
    await healthGate?.promise;
    return { active: protectedNetwork } as NetworkProtection;
  };
  runtime.management = async (_environment, command) => { management.push(command); return ''; };
  let fallbackCloses = 0;
  const fallback: BrowserHost = {
    native: false,
    available: async () => true,
    running: () => false,
    open: async () => { throw new Error('The VM browser must not use the host browser'); },
    close: async () => { fallbackCloses++; },
    clear: async () => {},
    dispose: async () => {},
  };
  const host = new GuestBrowserHost(runtime, fallback);
  const id = randomUUID();
  const environment: Environment = {
    ...environmentSchema.parse({ name: 'Guest viewer test', network: { mode: 'http', host: 'proxy.example', strict: true, transparent: true } }),
    id, instanceName: `mu-${id.replaceAll('-', '').slice(0, 16)}`, state: 'running', lastError: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), browserRunning: true,
  };
  const vnc = path.join(directory, 'vnc.sock');
  const sockets = new Set<Socket>();
  const received: Buffer[] = [];
  const rfb = createSocketServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', data => { received.push(Buffer.from(data)); socket.write(data); });
    socket.write(Buffer.from('RFB 003.008\n'));
  });
  await new Promise<void>(resolve => rfb.listen(vnc, resolve));
  const transport = new TestTransport();
  const entry = {
    environment, release:CURRENT_BROWSER_RELEASE, password: 'fixture8', transport: transport as unknown as ChildProcess,
    directory, vnc, cdp: path.join(directory, 'cdp.sock'), ready: true,
    sessions: new Map<string, string>(), configuration: new Set<Promise<void>>(),
  };
  host.entries.set(id, entry);
  let origin = '';
  const server = createHTTPServer((_request, response) => response.end());
  server.on('upgrade', (request, socket, head) => {
    void host.upgrade(request, socket, head, incoming => incoming.headers.origin === origin && incoming.headers.host === new URL(origin).host)
      .catch(() => socket.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients = new Set<WebSocket>();
  const connect = (ticket: string, options: { origin?: string | null; host?: string } = {}) => {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/guest-browser?ticket=${ticket}`, {
      origin: options.origin === null ? undefined : options.origin ?? origin,
      headers: options.host ? { Host: options.host } : {},
      handshakeTimeout: 2000,
    });
    clients.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => clients.delete(socket));
    const messages: { data: Buffer; binary: boolean }[] = [];
    socket.on('message', (data, binary) => { messages.push({ data: Buffer.from(data as Buffer), binary }); });
    const opened = new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('close', () => { if (socket.readyState !== WebSocket.OPEN) reject(new Error('Viewer connection rejected')); });
    });
    return { socket, messages, opened };
  };
  return {
    host, environment, entry, origin, connect, received, management,
    healthCalls: () => healthCalls,
    fallbackCloses: () => fallbackCloses,
    setHealth: (healthy: boolean) => { protectedNetwork = healthy; },
    pauseHealth: () => { healthGate = deferred<void>(); return healthGate; },
    async reopen() { await mkdir(directory, { recursive: true }); entry.ready = true; host.entries.set(id, entry); },
    async close() {
      healthGate?.resolve();
      for (const client of clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await host.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await new Promise<void>(resolve => rfb.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Guest viewer forwards binary RFB both ways and closes invalid text input', async () => {
  const f = await fixture();
  try {
    const credentials = f.host.issue(f.environment.id);
    assert.equal(credentials.password, 'fixture8');
    assert.match(credentials.ticket, /^[a-f0-9]{48}$/);
    const viewer = f.connect(credentials.ticket);
    await viewer.opened;
    await eventually(() => viewer.messages.length > 0, 'The viewer must receive the RFB greeting');
    assert.equal(viewer.messages[0].binary, true);
    assert.equal(viewer.messages[0].data.toString(), 'RFB 003.008\n');
    const input = Buffer.from([0, 255, 17, 128, 0]);
    viewer.socket.send(input);
    await eventually(() => f.received.length > 0 && Buffer.concat(viewer.messages.slice(1).map(message => message.data)).length >= input.length, 'The RFB stream must forward binary input and output');
    assert.deepEqual(Buffer.concat(f.received), input);
    assert.deepEqual(Buffer.concat(viewer.messages.slice(1).map(message => message.data)), input);
    assert.ok(viewer.messages.every(message => message.binary));
    const closed = new Promise<number>(resolve => viewer.socket.once('close', code => resolve(code)));
    viewer.socket.send('not RFB');
    assert.equal(await closed, 1008);
    await eventually(() => !f.host.peers.has(f.environment.id), 'The rejected viewer must release its connection');
    assert.deepEqual(Buffer.concat(f.received), input);
  } finally { await f.close(); }
});

test('Guest viewer rejects reused, expired, missing and untrusted-origin or host tickets', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.connect('unknown').opened);
    const active = f.host.issue(f.environment.id).ticket;
    const viewer = f.connect(active);
    await viewer.opened;
    await assert.rejects(f.connect(active).opened);
    const expired = f.host.issue(f.environment.id).ticket;
    f.host.tickets.get(expired)!.expires = Date.now() - 1;
    await assert.rejects(f.connect(expired).opened);
    assert.equal(f.host.tickets.has(expired), false);
    for (const options of [{ origin: 'https://untrusted.example' }, { host: 'untrusted.example' }, { origin: null }]) {
      const ticket = f.host.issue(f.environment.id).ticket;
      await assert.rejects(f.connect(ticket, options).opened);
      assert.equal(f.host.tickets.has(ticket), false);
      await assert.rejects(f.connect(ticket).opened);
    }
    assert.equal(f.host.peers.get(f.environment.id)?.size, 1);
  } finally { await f.close(); }
});

test('Guest viewer rejects unhealthy protection and a session closed during asynchronous protection validation', async () => {
  const f = await fixture();
  try {
    f.setHealth(false);
    await assert.rejects(f.connect(f.host.issue(f.environment.id).ticket).opened);
    assert.equal(f.host.wss.clients.size, 0);
    f.setHealth(true);
    const gate = f.pauseHealth();
    const before = f.healthCalls();
    const pending = f.connect(f.host.issue(f.environment.id).ticket).opened;
    const rejected = assert.rejects(pending);
    await eventually(() => f.healthCalls() > before, 'The upgrade must validate the network before accepting');
    await f.host.close(f.environment.id);
    gate.resolve();
    await rejected;
    assert.equal(f.host.running(f.environment.id), false);
    assert.equal(f.host.wss.clients.size, 0);
    assert.equal(f.management.length, 2);
    assert.equal(f.fallbackCloses(), 0);
    assert.throws(() => f.host.issue(f.environment.id), /尚未就绪/);
  } finally { await f.close(); }
});

test('Closing a guest browser revokes viewers and outstanding tickets across reopening', async () => {
  const f = await fixture();
  try {
    const viewer = f.connect(f.host.issue(f.environment.id).ticket);
    await viewer.opened;
    const stale = f.host.issue(f.environment.id).ticket;
    const closed = new Promise<void>(resolve => viewer.socket.once('close', () => resolve()));
    await f.host.close(f.environment.id);
    await closed;
    assert.equal(f.host.tickets.size, 0);
    assert.equal(f.host.peers.size, 0);
    assert.equal(f.entry.ready, false);
    await assert.rejects(f.connect(stale).opened);
    await f.reopen();
    await assert.rejects(f.connect(stale).opened);
    assert.notEqual(f.host.issue(f.environment.id).ticket, stale);
  } finally { await f.close(); }
});

test('Concurrent guest viewer upgrades cannot exceed the four-viewer limit', async () => {
  const f = await fixture();
  try {
    const tickets = Array.from({ length: 5 }, () => f.host.issue(f.environment.id).ticket);
    const gate = f.pauseHealth();
    const before = f.healthCalls();
    const attempts = tickets.map(ticket => f.connect(ticket));
    const settled = Promise.allSettled(attempts.map(attempt => attempt.opened));
    await eventually(() => f.healthCalls() >= before + 4, 'The permitted concurrent upgrades must reach the protection check');
    gate.resolve();
    const results = await settled;
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 4);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(f.host.peers.get(f.environment.id)?.size, 4);
    assert.throws(() => f.host.issue(f.environment.id), /达到上限/);
  } finally { await f.close(); }
});

test('Normal browser close requests profile flush before stopping processes; quarantine skips the wait', async () => {
  for(const graceful of [true,false]){
    const f=await fixture();
    try{
      const events:string[]=[];
      f.host.revokeAudio=()=>{assert.equal(f.entry.ready,true);events.push('audio-revoke');};
      const socket=Object.assign(new EventEmitter(),{readyState:WebSocket.OPEN as number});
      Object.assign(f.entry,{tools:{socket,
        async send(method:string){events.push(method);socket.readyState=WebSocket.CLOSED;socket.emit('close');},
        close(){events.push('debugger-close');},
      }});
      const kill=f.entry.transport.kill.bind(f.entry.transport);
      f.entry.transport.kill=signal=>{events.push('transport-stop');return kill(signal);};
      const management=f.host.runtime.management.bind(f.host.runtime);
      f.host.runtime.management=async(...args)=>{events.push('guest-stop');return management(...args);};
      await f.host.close(f.environment.id,graceful);
      assert.deepEqual(events,graceful?['audio-revoke','Browser.close','debugger-close','transport-stop','guest-stop','guest-stop']:['audio-revoke','debugger-close','transport-stop']);
      assert.equal(f.host.running(f.environment.id),false);
    }finally{await f.close();}
  }
});
