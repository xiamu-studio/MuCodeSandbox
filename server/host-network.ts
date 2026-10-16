import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { HostNetworkEvent } from './manager.ts';

const record = z.object({ kind: z.enum(['ready', 'change', 'heartbeat']), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), sequence: z.number().int().positive().safe() }).strict();

export class HostNetworkMonitor {
  child: ChildProcess | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buffer = '';
  private sequence = 0;
  private fingerprint = '';
  private receivedAt = 0;
  private failed = false;
  private closed = false;
  private childClosed = false;
  private forceTimer: ReturnType<typeof setTimeout> | null = null;
  private settleReady: (() => void) | null = null;
  private executable: string;
  private notify: (event: HostNetworkEvent) => void | Promise<void>;
  private options: { args?: string[]; timeoutMs?: number };
  constructor(executable: string, notify: (event: HostNetworkEvent) => void | Promise<void>, options: { args?: string[]; timeoutMs?: number } = {}) {
    this.executable = executable; this.notify = notify; this.options = options;
  }
  private dispatch(event: HostNetworkEvent) {
    try { void Promise.resolve(this.notify(event)).catch(() => this.fail()); }
    catch { this.fail(); }
  }
  private fail() {
    if (this.failed || this.closed) return;
    this.failed = true;
    if (this.timer) clearInterval(this.timer);
    this.dispatch('failed');
    this.settleReady?.(); this.settleReady = null;
    this.child?.kill('SIGTERM');
    this.forceTimer = setTimeout(() => { if (!this.childClosed) this.child?.kill('SIGKILL'); }, 2000);
    this.forceTimer.unref();
  }
  private receive(chunk: Buffer) {
    if (this.failed || this.closed) return;
    if (chunk.length > 4096 || this.buffer.length + chunk.length > 8192) { this.fail(); return; }
    this.buffer += chunk.toString('utf8');
    let end: number;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      const parsed = record.safeParse((() => { try { return JSON.parse(line); } catch { return null; } })());
      const value = parsed.success ? parsed.data : null;
      if (!value || value.sequence !== this.sequence + 1 || (this.sequence === 0 ? value.kind !== 'ready' : value.kind === 'ready')) { this.fail(); return; }
      const now = Date.now();
      if (now - this.receivedAt > (this.options.timeoutMs ?? 15_000)) { this.fail(); return; }
      const changed = this.sequence > 0 && (value.kind === 'change' || value.fingerprint !== this.fingerprint);
      this.receivedAt = now; this.sequence = value.sequence; this.fingerprint = value.fingerprint;
      if (this.sequence === 1) { this.dispatch('ready'); this.settleReady?.(); this.settleReady = null; }
      else if (changed) this.dispatch('changed');
      if (this.failed || this.closed) return;
    }
  }
  async start() {
    if (this.child || this.closed) throw new Error('Network monitor has already started or closed');
    this.receivedAt = Date.now();
    const ready = new Promise<void>(resolve => { this.settleReady = resolve; });
    this.child = spawn(this.executable, this.options.args ?? [], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child.stdout!.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
    this.child.on('close', () => { this.childClosed = true; if (this.forceTimer) clearTimeout(this.forceTimer); });
    this.timer = setInterval(() => { if (Date.now() - this.receivedAt > (this.options.timeoutMs ?? 15_000)) this.fail(); }, Math.min(1000, this.options.timeoutMs ?? 15_000));
    this.timer.unref();
    await ready;
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.settleReady?.(); this.settleReady = null;
    const child = this.child;
    if (child && !this.childClosed) {
      await new Promise<void>(resolve => {
        const force = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('close', () => { clearTimeout(force); resolve(); });
        child.kill('SIGTERM');
      });
    }
  }
}
