import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex, Readable } from 'node:stream';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { Environment } from '../shared/types.ts';
import { encodeAudioPacket, GUEST_AUDIO_FORMAT, GUEST_AUDIO_MAX_BUFFERED_BYTES, GUEST_AUDIO_PCM_BYTES } from '../shared/guest-audio.ts';
import { AppError } from './errors.ts';
import type { LimaRuntime } from './runtime.ts';
import type { RunOptions } from './process.ts';

export const GUEST_AUDIO_PACKAGES = ['pulseaudio', 'pulseaudio-utils'] as const;
export const GUEST_AUDIO_DIRECTORY = '/run/mu-browser/audio';
export const GUEST_AUDIO_ENV = {
  PULSE_SERVER: `unix:${GUEST_AUDIO_DIRECTORY}/native`,
  PULSE_COOKIE: `${GUEST_AUDIO_DIRECTORY}/cookie`, PULSE_SINK: 'mu_browser',
} as const;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Optional preparation; callers must run this only in the chosen environment. */
export const INSTALL_GUEST_AUDIO_SCRIPT = `set -euo pipefail
if ! command -v pulseaudio >/dev/null || ! command -v parec >/dev/null || ! command -v pactl >/dev/null; then
  sudo -E env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo -E env DEBIAN_FRONTEND=noninteractive SYSTEMD_OFFLINE=1 NEEDRESTART_MODE=l apt-get install -y --no-install-recommends ${GUEST_AUDIO_PACKAGES.join(' ')}
fi
command -v pulseaudio >/dev/null
command -v parec >/dev/null
command -v pactl >/dev/null
`;

export async function ensureGuestAudio(runtime: LimaRuntime, environment: Environment, options: RunOptions = {}) {
  await runtime.management(environment, ['bash', '-s'], { ...options, input: INSTALL_GUEST_AUDIO_SCRIPT, timeoutMs: 300_000 });
}

/** Structural readiness only; a nonzero browser-tone receipt is still required. */
export const INSPECT_GUEST_AUDIO_SCRIPT = `set -euo pipefail
sudo systemctl is-active mucodesandbox-display.service
sudo test -S ${GUEST_AUDIO_DIRECTORY}/native
sudo test "$(stat -c %a ${GUEST_AUDIO_DIRECTORY})" = 700
sudo test "$(stat -c %a ${GUEST_AUDIO_ENV.PULSE_COOKIE})" = 600
sudo -H -u dev -- env -i HOME=/home/dev PATH=/usr/bin:/bin PULSE_SERVER=${quote(GUEST_AUDIO_ENV.PULSE_SERVER)} PULSE_COOKIE=${quote(GUEST_AUDIO_ENV.PULSE_COOKIE)} pactl list short sinks
sudo -H -u dev -- env -i HOME=/home/dev PATH=/usr/bin:/bin PULSE_SERVER=${quote(GUEST_AUDIO_ENV.PULSE_SERVER)} PULSE_COOKIE=${quote(GUEST_AUDIO_ENV.PULSE_COOKIE)} pactl list short sources
`;

export const GUEST_AUDIO_TEST_TONE_EXPRESSION = `(() => {
  const context = new AudioContext({sampleRate:48000});
  const tone = context.createOscillator(), gain = context.createGain();
  tone.frequency.value = 440; gain.gain.value = 0.05;
  tone.connect(gain).connect(context.destination);
  return context.resume().then(() => {
    tone.start(); tone.stop(context.currentTime + 2);
    tone.onended = () => context.close();
    return {state:context.state,sampleRate:context.sampleRate,frequency:440,durationSeconds:2};
  });
})()`;

/** Runs as dev inside the display service. Include pulse_pid in that service's cleanup/wait list. */
export const GUEST_AUDIO_LAUNCHER_START = `
mkdir -p ${GUEST_AUDIO_DIRECTORY}/runtime ${GUEST_AUDIO_DIRECTORY}/state
chmod 0700 ${GUEST_AUDIO_DIRECTORY} ${GUEST_AUDIO_DIRECTORY}/runtime ${GUEST_AUDIO_DIRECTORY}/state
python3 - <<'MU_AUDIO_COOKIE'
import os
with open('${GUEST_AUDIO_ENV.PULSE_COOKIE}', 'wb') as output:
    output.write(os.urandom(256))
os.chmod('${GUEST_AUDIO_ENV.PULSE_COOKIE}', 0o600)
MU_AUDIO_COOKIE
cat > ${GUEST_AUDIO_DIRECTORY}/default.pa <<'MU_AUDIO_CONFIG'
.fail
load-module module-null-sink sink_name=mu_browser format=s16le rate=48000 channels=2 channel_map=front-left,front-right sink_properties=device.description=MuCodeSandbox_Browser_Output
set-default-sink mu_browser
load-module module-native-protocol-unix socket=${GUEST_AUDIO_DIRECTORY}/native auth-anonymous=no auth-group-enable=no auth-cookie-enabled=yes auth-cookie=${GUEST_AUDIO_ENV.PULSE_COOKIE}
MU_AUDIO_CONFIG
export PULSE_SERVER=${quote(GUEST_AUDIO_ENV.PULSE_SERVER)} PULSE_COOKIE=${quote(GUEST_AUDIO_ENV.PULSE_COOKIE)} PULSE_SINK=mu_browser
PULSE_RUNTIME_PATH=${GUEST_AUDIO_DIRECTORY}/runtime PULSE_STATE_PATH=${GUEST_AUDIO_DIRECTORY}/state XDG_RUNTIME_DIR=${GUEST_AUDIO_DIRECTORY}/runtime pulseaudio --daemonize=no --use-pid-file=no --exit-idle-time=-1 --disallow-exit=yes --disable-shm=yes --enable-memfd=no --high-priority=no --realtime=no --log-target=stderr --log-level=error -n --file=${GUEST_AUDIO_DIRECTORY}/default.pa &
pulse_pid=$!
audio_ready=no
for audio_attempt in $(seq 1 100); do
  if pactl info >/dev/null 2>&1; then audio_ready=yes; break; fi
  kill -0 "$pulse_pid"
  sleep 0.05
done
if [ "$audio_ready" != yes ]; then echo 'Guest audio service did not become ready' >&2; exit 1; fi
`;

/** stdin EOF terminates parec when the authenticated SSH channel is revoked. */
export const GUEST_AUDIO_CAPTURE_PYTHON = `import os, select, signal, subprocess, sys
command = ['parec', '--raw', '--device=mu_browser.monitor', '--format=s16le', '--rate=48000', '--channels=2', '--channel-map=front-left,front-right', '--latency-msec=40', '--process-time-msec=20']
child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=sys.stdout.buffer, stderr=subprocess.DEVNULL)
def stop(*_):
    if child.poll() is None:
        child.terminate()
    try:
        child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)
signal.signal(signal.SIGINT, stop)
try:
    while child.poll() is None:
        ready, _, _ = select.select([sys.stdin.buffer], [], [], 0.2)
        if ready and not os.read(sys.stdin.fileno(), 1024):
            break
finally:
    stop()
`;

export interface GuestAudioSession { environment: Environment; ready: boolean }
export interface GuestAudioCapture { stream: Readable; stop(): void | Promise<void> }
export interface GuestAudioHostOptions {
  getSession(id: string): GuestAudioSession | undefined;
  authorize(session: GuestAudioSession): Promise<unknown>;
  capture(session: GuestAudioSession): GuestAudioCapture;
  healthIntervalMs?: number;
}
interface Ticket { id: string; expires: number; session: GuestAudioSession; generation: number }

export function createGuestAudioCapture(runtime: LimaRuntime, session: GuestAudioSession): GuestAudioCapture {
  const command = ['sudo', '-H', '-u', 'dev', '--', 'env', '-i', 'HOME=/home/dev', 'PATH=/usr/bin:/bin',
    ...Object.entries(GUEST_AUDIO_ENV).map(([key, value]) => `${key}=${value}`), 'python3', '-c', GUEST_AUDIO_CAPTURE_PYTHON];
  const process: ChildProcessWithoutNullStreams = spawn('/usr/bin/ssh', [
    '-F', path.join(runtime.limaHome, session.environment.instanceName, 'ssh.config'), '-S', 'none', '-T',
    '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
    `lima-${session.environment.instanceName}`, command.map(quote).join(' '),
  ], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  // Never log audio or any server authentication details.
  process.stderr.resume();
  process.stdin.on('error', () => {});
  process.on('error', () => process.stdout.destroy(new Error('来宾音频连接失败')));
  process.on('exit', code => {
    if (code && !process.stdout.destroyed) process.stdout.destroy(new Error('来宾音频连接已结束'));
  });
  let stopped: Promise<void> | undefined;
  return {
    stream: process.stdout,
    stop() {
      stopped ??= new Promise<void>(resolve => {
        process.stdin.end();
        if (process.exitCode !== null || process.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => { process.kill('SIGKILL'); resolve(); }, 2500);
        timer.unref();
        process.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      return stopped;
    },
  };
}

const loopback = (address?: string) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

export class GuestAudioHost {
  readonly options: GuestAudioHostOptions;
  readonly tickets = new Map<string, Ticket>();
  readonly peers = new Map<string, Set<WebSocket>>();
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 128 });
  readonly pending = new Set<GuestAudioSession>();
  readonly stopping = new Set<Promise<void>>();
  readonly generations = new Map<string, number>();
  readonly cleanup = new Map<WebSocket, () => void>();
  disposed = false;

  constructor(options: GuestAudioHostOptions) { this.options = options; }

  async issue(id: string) {
    const session = this.options.getSession(id);
    const generation = this.generations.get(id) ?? 0;
    if (this.disposed || !session?.ready) throw new AppError('请先连接沙箱浏览器', 409);
    await this.options.authorize(session);
    if (this.disposed || this.options.getSession(id) !== session || !session.ready || (this.generations.get(id) ?? 0) !== generation) throw new AppError('浏览器音频访问已撤销', 409);
    for (const [key, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(key);
    if (this.tickets.size >= 32 || this.peers.get(id)?.size || this.pending.has(session)) throw new AppError('浏览器音频已在播放，请先关闭原播放连接', 409);
    const ticket = randomBytes(24).toString('hex');
    this.tickets.set(ticket, { id, session, generation, expires: Date.now() + 15_000 });
    return { ticket, format: GUEST_AUDIO_FORMAT };
  }

  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, allowed: (request: IncomingMessage) => boolean) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const key = url.searchParams.get('ticket') ?? '';
    const ticket = this.tickets.get(key);
    this.tickets.delete(key); // Burn failed-origin and stale tickets too.
    const session = ticket?.session;
    if (this.disposed || url.pathname !== '/guest-audio' || !ticket || !session?.ready || ticket.expires < Date.now()
      || this.options.getSession(ticket.id) !== session || (this.generations.get(ticket.id) ?? 0) !== ticket.generation || !loopback(request.socket.remoteAddress) || !allowed(request)
      || this.peers.get(ticket.id)?.size || this.pending.has(session)) { socket.destroy(); return; }
    this.pending.add(session);
    try {
      await this.options.authorize(session);
      if (this.disposed || this.options.getSession(ticket.id) !== session || !session.ready || (this.generations.get(ticket.id) ?? 0) !== ticket.generation || this.peers.get(ticket.id)?.size) { socket.destroy(); return; }
      this.wss.handleUpgrade(request, socket, head, ws => this.attach(ticket.id, session, ws));
    } catch { socket.destroy(); }
    finally { this.pending.delete(session); }
  }

  private attach(id: string, session: GuestAudioSession, socket: WebSocket) {
    const peers = new Set([socket]); this.peers.set(id, peers);
    let capture: GuestAudioCapture;
    try { capture = this.options.capture(session); }
    catch { this.peers.delete(id); socket.close(1011, 'Guest audio unavailable'); return; }
    let carry = Buffer.alloc(0), sequence = 0, checking = false, ended = false;
    const current = () => !this.disposed && this.options.getSession(id) === session && session.ready;
    const stillAttached = () => !ended && this.peers.get(id) === peers;
    const finish = () => {
      if (ended) return; ended = true; clearInterval(health); carry = Buffer.alloc(0);
      capture.stream.destroy();
      const stopping = Promise.resolve().then(() => capture.stop()).then(() => {}, () => {}).finally(() => this.stopping.delete(stopping));
      this.stopping.add(stopping);
      peers.delete(socket); if (this.peers.get(id) === peers) this.peers.delete(id);
      this.cleanup.delete(socket);
    };
    const health = setInterval(() => {
      if (!current()) { if (stillAttached()) this.revoke(id); return; }
      if (checking) return; checking = true;
      void this.options.authorize(session).then(() => { if (stillAttached() && !current()) this.revoke(id); }, () => { if (stillAttached()) this.revoke(id); }).finally(() => { checking = false; });
    }, this.options.healthIntervalMs ?? 5000);
    health.unref();
    this.cleanup.set(socket, finish);
    socket.once('close', finish);
    socket.on('error', finish);
    // This bridge has no microphone, command, acknowledgement or inbound audio channel.
    socket.on('message', () => { finish(); socket.close(1008, 'Output only'); });
    capture.stream.on('error', () => { finish(); socket.close(1011, 'Guest audio unavailable'); });
    capture.stream.on('end', () => { finish(); socket.close(1000, 'Guest audio ended'); });
    socket.send(JSON.stringify(GUEST_AUDIO_FORMAT));
    capture.stream.on('data', (data: Buffer) => {
      if (ended || socket.readyState !== WebSocket.OPEN) return;
      if (!current()) { this.revoke(id); return; }
      // Readable chunks and residual storage are bounded independently of network speed.
      if (data.byteLength > 256 * 1024) { finish(); socket.close(1008, 'Invalid audio chunk'); return; }
      const pcm = carry.length ? Buffer.concat([carry, data]) : data;
      let offset = 0;
      while (pcm.length - offset >= GUEST_AUDIO_PCM_BYTES) {
        const packet = encodeAudioPacket(sequence++, pcm.subarray(offset, offset + GUEST_AUDIO_PCM_BYTES));
        if (socket.bufferedAmount + packet.byteLength > GUEST_AUDIO_MAX_BUFFERED_BYTES) { finish(); socket.close(1008, 'Slow audio receiver'); return; }
        socket.send(packet, { binary: true }, error => { if (error) { finish(); socket.terminate(); } });
        offset += GUEST_AUDIO_PCM_BYTES;
      }
      carry = Buffer.from(pcm.subarray(offset));
    });
  }

  /** Call before browser stop, environment quarantine or replacement. Revocation is immediate. */
  revoke(id: string) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    for (const [key, ticket] of this.tickets) if (ticket.id === id) this.tickets.delete(key);
    for (const peer of this.peers.get(id) ?? []) { this.cleanup.get(peer)?.(); peer.terminate(); }
    this.peers.delete(id);
  }

  async dispose() {
    this.disposed = true; this.tickets.clear();
    for (const id of [...this.peers.keys()]) this.revoke(id);
    for (const peer of this.wss.clients) peer.terminate();
    await Promise.allSettled([...this.stopping]);
    this.wss.close();
  }
}
