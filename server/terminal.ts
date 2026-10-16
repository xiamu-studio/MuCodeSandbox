import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { IPty } from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import type { Manager } from './manager.ts';
import { AppError, errorMessage } from './errors.ts';

interface Ticket { environmentId: string; command: 'shell' | 'claude'; expires: number; cols: number; rows: number }
const bounded = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Math.floor(value)));

export class TerminalServer {
  manager: Manager;
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  tickets = new Map<string, Ticket>();
  children = new Map<string, Set<IPty>>();
  constructor(manager: Manager) { this.manager = manager; }
  issue(environmentId: string, command: 'shell' | 'claude', cols = 100, rows = 28) {
    const e = this.manager.store.get(environmentId);
    if (e.kind !== 'vm' || e.state !== 'running') throw new AppError('请先启动 Linux 环境', 409);
    if (this.wss.clients.size >= 16 || (this.children.get(environmentId)?.size ?? 0) >= 4) throw new AppError('终端连接数量已达到上限', 429);
    for (const [key, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(key);
    if (this.tickets.size >= 32) throw new AppError('终端连接过多', 429);
    const ticket = randomBytes(24).toString('hex');
    this.tickets.set(ticket, { environmentId, command, expires: Date.now() + 15_000, cols: bounded(cols, 20, 300), rows: bounded(rows, 5, 100) });
    return ticket;
  }
  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, allowedOrigin: (origin?: string) => boolean) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const key = url.searchParams.get('ticket') ?? '';
    const ticket = this.tickets.get(key);
    this.tickets.delete(key);
    if (url.pathname !== '/terminal' || !ticket || ticket.expires < Date.now() || !allowedOrigin(request.headers.origin)) { socket.destroy(); return; }
    const environment = this.manager.store.get(ticket.environmentId);
    const generation = this.manager.generations.get(environment.id) ?? 0;
    if (environment.state !== 'running' || this.manager.active.has(environment.id)) { socket.destroy(); return; }
    if (environment.network.strict && !(await this.manager.runtime.networkProtection(environment)).active) { socket.destroy(); return; }
    try { await this.manager.assertAccess(environment.id); } catch { socket.destroy(); return; }
    const executable = await this.manager.runtime.executable();
    if (!executable) { socket.destroy(); return; }
    // Keep Node and Electron bindings separate because their native ABIs differ.
    const pty = process.versions.electron ? await import('node-pty-electron') : await import('node-pty');
    if (this.manager.active.has(environment.id) || this.manager.quarantines.has(environment.id) || this.manager.store.get(environment.id).state !== 'running' || (this.manager.generations.get(environment.id) ?? 0) !== generation) { socket.destroy(); return; }
    this.wss.handleUpgrade(request, socket, head, ws => {
      const cwd = environment.mounts[0]?.guestPath ?? '/workspace';
      const args = this.manager.runtime.guestArgs(environment, ticket.command === 'claude' ? ['claude'] : ['bash', '-l'], cwd);
      let child: IPty;
      const send = (type: string, data: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data })); };
      try { child = pty.spawn(executable, args, { name: 'xterm-256color', cols: ticket.cols, rows: ticket.rows, env: this.manager.runtime.env() }); }
      catch (error) { send('error', errorMessage(error)); ws.close(); return; }
      const set = this.children.get(environment.id) ?? new Set<IPty>();
      set.add(child); this.children.set(environment.id, set);
      const dataSubscription = child.onData(data => {
        if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1008, 'Terminal consumer is too slow'); return; }
        send('data', data);
      });
      const exitSubscription = child.onExit(({ exitCode }) => {
        set.delete(child); if (!set.size) this.children.delete(environment.id);
        dataSubscription.dispose(); exitSubscription.dispose(); send('exit', exitCode); ws.close();
      });
      ws.on('message', data => {
        try {
          const message = JSON.parse(data.toString()) as { type: string; data?: string; cols?: number; rows?: number };
          if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 32768) child.write(message.data);
          if (message.type === 'resize' && typeof message.cols === 'number' && typeof message.rows === 'number' && Number.isFinite(message.cols) && Number.isFinite(message.rows)) child.resize(bounded(message.cols, 20, 300), bounded(message.rows, 5, 100));
        } catch { ws.close(1008, 'Invalid terminal message'); }
      });
      ws.once('close', () => { try { child.kill(); } catch { /* An exited terminal has nothing left to terminate. */ } });
      send('connected', environment.name);
      this.manager.store.log(environment.id, null, ticket.command === 'claude' ? '已连接 Claude Code 终端' : '已连接 Linux 终端');
    });
  }
  closeEnvironment(id: string) {
    for (const [key, ticket] of this.tickets) if (ticket.environmentId === id) this.tickets.delete(key);
    for (const child of this.children.get(id) ?? []) { try { child.kill(); } catch { /* Already exited. */ } }
  }
  close() { for (const id of this.children.keys()) this.closeEnvironment(id); for (const client of this.wss.clients) client.close(); this.wss.close(); }
}
