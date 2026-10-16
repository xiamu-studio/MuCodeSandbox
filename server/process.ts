import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { AppError } from './errors.ts';

export type Runner = (file: string, args: string[], options?: RunOptions) => Promise<string>;
export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
  input?: string;
  maxBytes?: number;
}
export const run: Runner = (file, args, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) return reject(new AppError('操作已取消', 409, 'CANCELLED'));
  const child = spawn(file, args, { env: options.env, cwd: options.cwd, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] } satisfies SpawnOptions);
  let output = '';
  let reason: Error | null = null;
  let forceTimer: NodeJS.Timeout | undefined;
  let settled = false;
  const finish = (error?: Error, code?: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    options.signal?.removeEventListener('abort', abort);
    if (error) reject(error);
    else if (code !== 0) reject(new AppError(output.trim().slice(-4000) || `${file} 执行失败（${code}）`, 500, 'PROCESS_FAILED'));
    else resolve(output);
  };
  const stop = (error: Error) => {
    if (reason) return;
    reason = error;
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    forceTimer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      // Detached descendants can keep inherited pipes open after the child exits.
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      finish(reason!);
    }, 2500);
    forceTimer.unref();
  };
  const abort = () => stop(new AppError('操作已取消', 409, 'CANCELLED'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new AppError('操作超时，请检查日志和网络连接', 504, 'TIMEOUT')), options.timeoutMs ?? 30_000);
  const append = (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    if (Buffer.byteLength(output) > (options.maxBytes ?? 4_000_000)) output = output.slice(-1_000_000);
    options.onOutput?.(text);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  // SSH or the guest guard may exit before a large stdin payload is consumed.
  // Handle the pipe error as a failed operation, not an uncaught service crash.
  child.stdin.on('error', () => stop(new AppError('传入数据时连接已关闭，请检查运行状态后重试', 502, 'PROCESS_INPUT_CLOSED')));
  child.on('error', error => { reason = error; });
  child.on('close', code => {
    finish(reason ?? undefined, code);
  });
  child.stdin.end(options.input);
});
