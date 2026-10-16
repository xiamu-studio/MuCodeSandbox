import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { GuestAudioHost, GUEST_AUDIO_LAUNCHER_START, GUEST_AUDIO_CAPTURE_PYTHON, GUEST_AUDIO_ENV, INSTALL_GUEST_AUDIO_SCRIPT, type GuestAudioSession } from '../server/guest-audio.ts';
import { audioFormatMatches, decodeAudioPacket, encodeAudioPacket, GUEST_AUDIO_FORMAT, GUEST_AUDIO_MAX_BUFFERED_BYTES, GUEST_AUDIO_PCM_BYTES } from '../shared/guest-audio.ts';
import { GuestAudioPlayer } from '../src/guest-audio-player.ts';
import type { Environment } from '../shared/types.ts';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected audio state did not arrive');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  let session: GuestAudioSession | undefined = { environment: { id: 'audio-test', instanceName: 'mu-audio-test' } as Environment, ready: true };
  let healthy = true, authorizationCalls = 0, stopped = 0, gate: (ReturnType<typeof deferred> & { fail: boolean }) | undefined;
  const captures: PassThrough[] = [];
  const host = new GuestAudioHost({
    getSession: () => session, healthIntervalMs: 20,
    async authorize() { authorizationCalls++; const held = gate; await held?.promise; if (!healthy || held?.fail) throw new Error('Guard failed'); },
    capture() { const stream = new PassThrough(); captures.push(stream); return { stream, stop() { stopped++; } }; },
  });
  let origin = '';
  const server = createServer((_request, response) => response.end());
  server.on('upgrade', (request, socket, head) => {
    void host.upgrade(request, socket, head, incoming => incoming.headers.origin === origin && incoming.headers.host === new URL(origin).host).catch(() => socket.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients = new Set<WebSocket>();
  function connect(ticket: string, options: { origin?: string | null; host?: string } = {}) {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/guest-audio?ticket=${ticket}`, { origin: options.origin === null ? undefined : options.origin ?? origin, headers: options.host ? { Host: options.host } : {}, handshakeTimeout: 2000 });
    clients.add(socket); socket.once('close', () => clients.delete(socket)); socket.on('error', () => {});
    const messages: { data: Buffer; binary: boolean }[] = [];
    socket.on('message', (data, binary) => messages.push({ data: Buffer.from(data as Buffer), binary }));
    const opened = new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('Audio rejected'))); });
    return { socket, messages, opened };
  }
  return {
    host, connect, captures, stopped: () => stopped, authorizationCalls: () => authorizationCalls,
    unhealthy() { healthy = false; },
    pause() { gate = { ...deferred(), fail: false }; return gate; },
    releasePause() { gate = undefined; },
    replace() { session = { ...session!, ready: true }; },
    async close() { gate?.resolve(); for (const socket of clients) socket.terminate(); await host.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('Guest sink produces fixed PCM packets and decodes both stereo channels without persistence', async () => {
  const f = await fixture();
  try {
    assert.equal(f.captures.length, 0);
    const ticket = await f.host.issue('audio-test');
    assert.equal(f.captures.length, 0, 'Issuing a ticket must not start audio capture');
    const client = f.connect(ticket.ticket); await client.opened;
    await until(() => client.messages.length === 1);
    assert.equal(client.messages[0].binary, false); assert.equal(audioFormatMatches(JSON.parse(client.messages[0].data.toString())), true);
    const pcm = Buffer.alloc(GUEST_AUDIO_PCM_BYTES * 2);
    pcm.writeInt16LE(-32768, 0); pcm.writeInt16LE(32767, 2); pcm.writeInt16LE(8192, GUEST_AUDIO_PCM_BYTES);
    f.captures[0].write(pcm.subarray(0, 317)); f.captures[0].write(pcm.subarray(317));
    await until(() => client.messages.length === 3);
    const first = client.messages[1].data;
    const decoded = decodeAudioPacket(Uint8Array.from(first).buffer);
    assert.equal(decoded.sequence, 0); assert.equal(decoded.channels[0][0], -1); assert.equal(decoded.channels[1][0], 32767 / 32768);
    const second = decodeAudioPacket(Uint8Array.from(client.messages[2].data).buffer);
    assert.equal(second.sequence, 1); assert.equal(second.channels[0][0], .25);
    assert.ok(client.messages.slice(1).every(message => message.binary));
  } finally { await f.close(); }
});

test('Audio authorization burns missing, expired, reused and wrong-Origin or Host tickets', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.connect('unknown').opened);
    const expired = (await f.host.issue('audio-test')).ticket; f.host.tickets.get(expired)!.expires = Date.now() - 1;
    await assert.rejects(f.connect(expired).opened);
    for (const options of [{ origin: 'https://bad.example' }, { origin: null }, { host: 'bad.example' }]) {
      const ticket = (await f.host.issue('audio-test')).ticket; await assert.rejects(f.connect(ticket, options).opened); await assert.rejects(f.connect(ticket).opened);
    }
    const ticket = (await f.host.issue('audio-test')).ticket; const client = f.connect(ticket); await client.opened;
    await assert.rejects(f.connect(ticket).opened); await assert.rejects(f.host.issue('audio-test'), /已在播放/);
    assert.equal(f.captures.length, 1);
  } finally { await f.close(); }
});

test('Audio refuses every client payload and tears down guest recording immediately', async () => {
  for (const payload of ['command', Buffer.from([0, 1])]) {
    const f = await fixture();
    try {
      const client = f.connect((await f.host.issue('audio-test')).ticket); await client.opened;
      const closed = new Promise<number>(resolve => client.socket.once('close', resolve)); client.socket.send(payload);
      assert.equal(await closed, 1008); await until(() => f.stopped() === 1);
      assert.equal(f.captures[0].destroyed, true); assert.equal(f.host.peers.size, 0);
    } finally { await f.close(); }
  }
});

test('Browser revocation defeats outstanding tickets and asynchronous upgrades across reopening', async () => {
  const f = await fixture();
  try {
    const ticket = (await f.host.issue('audio-test')).ticket, gate = f.pause();
    const before = f.authorizationCalls(); const pending = f.connect(ticket).opened; const rejected = assert.rejects(pending);
    await until(() => f.authorizationCalls() > before); f.host.revoke('audio-test'); gate.resolve(); await rejected;
    assert.equal(f.captures.length, 0); assert.equal(f.host.pending.size, 0);
    const stale = (await f.host.issue('audio-test')).ticket; f.replace(); await assert.rejects(f.connect(stale).opened);
    const client = f.connect((await f.host.issue('audio-test')).ticket); await client.opened;
    f.host.revoke('audio-test'); assert.equal(f.captures[0].destroyed, true);
    await until(() => f.stopped() === 1);
  } finally { await f.close(); }
});

test('Guard failure stops active PCM and rejects a concurrent playback authorization', async () => {
  const f = await fixture();
  try {
    const client = f.connect((await f.host.issue('audio-test')).ticket); await client.opened;
    f.unhealthy(); await until(() => f.stopped() === 1);
    assert.equal(f.captures[0].destroyed, true); await assert.rejects(f.host.issue('audio-test'), /Guard failed/);
  } finally { await f.close(); }
});

test('A stale asynchronous audio health failure cannot revoke a replacement playback session', async () => {
  const f = await fixture();
  try {
    const old = f.connect((await f.host.issue('audio-test')).ticket); await old.opened;
    const before = f.authorizationCalls(), gate = f.pause();
    await until(() => f.authorizationCalls() > before);
    f.host.revoke('audio-test'); f.replace(); f.releasePause();
    const current = f.connect((await f.host.issue('audio-test')).ticket); await current.opened;
    gate.fail = true; gate.resolve(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.host.peers.get('audio-test')?.size, 1); assert.equal(current.socket.readyState, WebSocket.OPEN);
    assert.equal(f.captures[1].destroyed, false);
  } finally { await f.close(); }
});

test('Slow audio receivers are closed at the 200 ms bridge queue limit', async () => {
  const f = await fixture();
  try {
    const client = f.connect((await f.host.issue('audio-test')).ticket); await client.opened;
    const peer = [...f.host.peers.get('audio-test')!][0];
    Object.defineProperty(peer, 'bufferedAmount', { get: () => GUEST_AUDIO_MAX_BUFFERED_BYTES });
    const closed = new Promise<number>(resolve => client.socket.once('close', resolve));
    f.captures[0].write(Buffer.alloc(GUEST_AUDIO_PCM_BYTES)); assert.equal(await closed, 1008); await until(() => f.stopped() === 1);
  } finally { await f.close(); }
});

function fakeAudioContext() {
  const sourceList: { started: number; stopped: boolean; disconnected: boolean; buffer: unknown; start(time: number): void; stop(): void; disconnect(): void; connect(): void; onended?: () => void }[] = [];
  const buffers: Float32Array[][] = [];
  const context = {
    state: 'running', currentTime: 1, destination: {}, closed: false,
    createBuffer(channels: number, frames: number, sampleRate: number) {
      const samples = Array.from({ length: channels }, () => new Float32Array(frames)); buffers.push(samples);
      return { duration: frames / sampleRate, copyToChannel(data: Float32Array, channel: number) { samples[channel].set(data); } };
    },
    createBufferSource() { const source = { started: 0, stopped: false, disconnected: false, buffer: undefined as unknown, start(time: number) { this.started = time; }, stop() { this.stopped = true; }, disconnect() { this.disconnected = true; }, connect() {} }; sourceList.push(source); return source; },
    async close() { this.closed = true; this.state = 'closed'; },
  };
  return { context, sourceList, buffers, player: new GuestAudioPlayer(context as unknown as AudioContext) };
}

test('Host player schedules decoded signal and cancels all queued audio when disabled', async () => {
  const f = fakeAudioContext(); const pcm = new Uint8Array(GUEST_AUDIO_PCM_BYTES); new DataView(pcm.buffer).setInt16(0, 16384, true);
  f.player.push(encodeAudioPacket(0, pcm).buffer as ArrayBuffer);
  assert.equal(f.buffers[0][0][0], .5); assert.equal(f.sourceList[0].started, 1.06);
  await f.player.close(); assert.equal(f.context.closed, true); assert.equal(f.sourceList[0].stopped, true); assert.equal(f.sourceList[0].disconnected, true);
  assert.throws(() => f.player.push(encodeAudioPacket(1, pcm).buffer as ArrayBuffer), /已停止/);
});

test('Host player refuses malformed, reordered and excessive queued packets', async () => {
  const pcm = new Uint8Array(GUEST_AUDIO_PCM_BYTES);
  assert.throws(() => fakeAudioContext().player.push(new ArrayBuffer(3)), /长度/);
  assert.throws(() => fakeAudioContext().player.push(encodeAudioPacket(1, pcm).buffer as ArrayBuffer), /顺序/);
  const f = fakeAudioContext();
  for (let sequence = 0; sequence < 10; sequence++) f.player.push(encodeAudioPacket(sequence, pcm).buffer as ArrayBuffer);
  assert.throws(() => f.player.push(encodeAudioPacket(10, pcm).buffer as ArrayBuffer), /延迟/);
  await f.player.close();
});

test('Guest audio setup binds only a cookie-authenticated Unix sink and volatile state', () => {
  assert.equal(GUEST_AUDIO_FORMAT.sampleRate, 48_000);
  assert.match(GUEST_AUDIO_ENV.PULSE_SERVER, /^unix:\/run\/mu-browser\/audio\/native$/);
  assert.match(GUEST_AUDIO_LAUNCHER_START, /auth-anonymous=no auth-group-enable=no auth-cookie-enabled=yes/);
  assert.match(GUEST_AUDIO_LAUNCHER_START, /PULSE_STATE_PATH=\/run\/mu-browser\/audio\/state/);
  assert.match(GUEST_AUDIO_LAUNCHER_START, /--enable-memfd=no/);
  assert.doesNotMatch(GUEST_AUDIO_LAUNCHER_START, /module-(?:alsa-source|udev-detect|native-protocol-tcp)/);
  assert.match(GUEST_AUDIO_CAPTURE_PYTHON, /mu_browser\.monitor/);
  assert.match(GUEST_AUDIO_CAPTURE_PYTHON, /os\.read\(sys\.stdin\.fileno\(\), 1024\)/);
  assert.match(INSTALL_GUEST_AUDIO_SCRIPT, /SYSTEMD_OFFLINE=1 NEEDRESTART_MODE=l/);
});
