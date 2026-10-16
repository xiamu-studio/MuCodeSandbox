import { access } from 'node:fs/promises';
import type { RunOptions } from './process.ts';
import { run } from './process.ts';
import { AppError } from './errors.ts';

export interface MacEndpoint { address: string; port: number }
export function macNetworkPolicy(endpoints: MacEndpoint[]) {
  if (endpoints.some(e => e.address !== '127.0.0.1' || !Number.isSafeInteger(e.port) || e.port < 1 || e.port > 65535)) throw new AppError('此实验性 Mac 策略只支持本机代理端口', 409);
  // macOS SBPL accepts localhost or a wildcard, not an arbitrary numeric host.
  const allowed = [...new Set(endpoints.map(e => `localhost:${e.port}`))];
  return `(version 1)\n(allow default)\n(deny network*)\n${allowed.length ? `(allow network-outbound (remote tcp ${allowed.map(e => `"${e}"`).join(' ')}))` : ''}\n`;
}
export async function runManagedMac(endpoints: MacEndpoint[], file: string, args: string[], options: RunOptions = {}) {
  if (process.platform !== 'darwin') throw new AppError('此受限启动器只适用于 macOS', 409);
  try { await access('/usr/bin/sandbox-exec'); }
  catch { throw new AppError('本机不支持此实验性进程沙箱，拒绝无防护启动', 409, 'MAC_GUARD_UNAVAILABLE'); }
  return run('/usr/bin/sandbox-exec', ['-p', macNetworkPolicy(endpoints), file, ...args], options);
}
