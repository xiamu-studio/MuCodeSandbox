import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AppError } from './errors.ts';
import { shellQuote } from './network-guard.ts';
import { run, type Runner, type RunOptions } from './process.ts';

export interface ProxyTransportIdentity { port: number; targetIP: string; targetPort: number }
interface Transport extends ProxyTransportIdentity {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  directory: string;
}

// EOF from the owning host process closes the whole SSH session, including
// forwarded channels. A pidfd prevents signalling a recycled guest PID.
export const PROXY_SESSION = `import os,signal,sys
pid=os.getppid()
for _ in range(32):
 if pid<=1: raise RuntimeError('SSH session ancestor not found')
 if os.path.basename(os.readlink('/proc/%d/exe'%pid)) in ('sshd','sshd-session'):
  session=os.pidfd_open(pid);break
 with open('/proc/%d/status'%pid) as f:
  pid=int(next(line.split(':',1)[1] for line in f if line.startswith('PPid:')))
else: raise RuntimeError('SSH session ancestor not found')
print('MU_PROXY_SESSION_READY',flush=True)
try:
 while sys.stdin.buffer.read(4096): pass
finally:
 try: signal.pidfd_send_signal(session,signal.SIGTERM)
 except ProcessLookupError: pass
 os.close(session)
`;

export class ProxyTransports {
  entries = new Map<string, Transport>();
  private limaHome: string;
  private launch: typeof spawn;
  private runner: Runner;
  constructor(limaHome: string, launch: typeof spawn = spawn, runner: Runner = run) {
    this.limaHome = limaHome; this.launch = launch; this.runner = runner;
  }

  matches(id: string, expected: ProxyTransportIdentity) {
    const entry = this.entries.get(id);
    return !!entry && entry.port === expected.port && entry.targetIP === expected.targetIP && entry.targetPort === expected.targetPort
      && !entry.child.killed && entry.child.exitCode === null && entry.child.signalCode === null;
  }

  async open(id: string, instanceName: string, targetIP: string, targetPort: number, options: RunOptions = {}, guestPort = 0): Promise<ProxyTransportIdentity> {
    if (!/^mu-[a-zA-Z0-9-]+$/.test(instanceName) || !isIPv4(targetIP) || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535 || !Number.isInteger(guestPort) || guestPort < 0 || guestPort > 65535)
      throw new AppError('代理通道参数无效', 409, 'PROXY_TRANSPORT_CONFIGURATION');
    if (options.signal?.aborted) throw new AppError('操作已取消', 409, 'CANCELLED');
    await this.close(id);
    const directory = await mkdtemp(path.join(tmpdir(), 'mu-proxy-'));
    const control = path.join(directory, 'ssh');
    const config = path.join(this.limaHome, instanceName, 'ssh.config');
    const child = this.launch('/usr/bin/ssh', ['-F', config, '-M', '-S', control, '-T',
      '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
      '-o', 'LogLevel=ERROR', `lima-${instanceName}`,
      `exec sudo -n /usr/bin/python3 -c ${shellQuote(PROXY_SESSION)}`], { stdio: ['pipe', 'pipe', 'pipe'], shell: false }) as ChildProcessWithoutNullStreams;
    child.stdin.on('error', () => {});
    const entry: Transport = { child, directory, port: 0, targetIP, targetPort, closed: new Promise(resolve => child.once('close', () => resolve())) };
    this.entries.set(id, entry);
    let output = '';
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const pending = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const inspect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8192);
      if (output.includes('MU_PROXY_SESSION_READY')) resolveReady();
    };
    child.stdout.on('data', inspect); child.stderr.on('data', inspect);
    child.once('error', () => rejectReady(new AppError('宿主代理通道无法启动', 500, 'PROXY_TRANSPORT_FAILED')));
    child.once('close', () => {
      if (this.entries.get(id) === entry) this.entries.delete(id);
      void rm(directory, { recursive: true, force: true }).catch(() => {});
      rejectReady(new AppError('宿主代理通道已关闭', 409, 'PROXY_TRANSPORT_CLOSED'));
    });
    const abort = () => rejectReady(new AppError('操作已取消', 409, 'CANCELLED'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => rejectReady(new AppError('宿主代理通道启动超时', 504, 'PROXY_TRANSPORT_TIMEOUT')), 15_000);
    try {
      await pending;
      const allocated = (await this.runner('/usr/bin/ssh', ['-F', config, '-S', control, '-O', 'forward',
        '-o', 'BatchMode=yes', '-R', `127.0.0.1:${guestPort}:${targetIP}:${targetPort}`, `lima-${instanceName}`],
      { signal: options.signal, timeoutMs: 10_000, maxBytes: 4096 })).trim();
      if (!guestPort && !/^\d+$/.test(allocated)) throw new AppError('宿主代理通道未分配有效端口', 500, 'PROXY_TRANSPORT_FAILED');
      entry.port = guestPort || Number(allocated);
      if (entry.port < 1 || entry.port > 65535) throw new AppError('宿主代理通道端口无效', 500, 'PROXY_TRANSPORT_FAILED');
      const identity = { port: entry.port, targetIP, targetPort };
      if (!this.matches(id, identity) || options.signal?.aborted) throw new AppError('宿主代理通道未就绪', 409, 'PROXY_TRANSPORT_CLOSED');
      return identity;
    } catch (error) {
      await this.close(id); throw error;
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    }
  }

  async close(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.child.stdin.end();
    const terminate = setTimeout(() => entry.child.kill('SIGTERM'), 2000);
    const force = setTimeout(() => entry.child.kill('SIGKILL'), 4000);
    try { await entry.closed; } finally { clearTimeout(terminate); clearTimeout(force); await rm(entry.directory, { recursive: true, force: true }); }
  }
}
