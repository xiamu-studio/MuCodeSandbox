import { createServer } from 'node:net';
import type { Environment } from '../shared/types.ts';
import { AppError } from './errors.ts';

export function checkResources(environment: Environment, environments: Environment[], capacity: { cpus: number; memoryGiB: number }) {
  const allocated = environments.filter(e => e.kind === 'vm' && e.id !== environment.id && ['running', 'starting', 'creating', 'stopping'].includes(e.state));
  if (allocated.reduce((sum, e) => sum + e.memoryGiB, environment.memoryGiB) > Math.floor(capacity.memoryGiB * 0.8)) throw new AppError('启动后的总内存分配会超过本机内存的 80%，请先停止其他环境', 409, 'MEMORY_BUDGET');
  if (allocated.reduce((sum, e) => sum + e.cpus, environment.cpus) > capacity.cpus) throw new AppError('启动后的 CPU 总分配超过本机核心数，请先停止其他环境', 409, 'CPU_BUDGET');
  const usedPorts = new Set(allocated.flatMap(e => e.ports.map(p => p.hostPort)));
  if (environment.ports.some(p => usedPorts.has(p.hostPort))) throw new AppError('端口已被另一个运行或启动中的环境使用', 409, 'PORT_CONFLICT');
}

export async function checkHostPorts(ports: number[]) {
  for (const port of ports) {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' || code === 'EACCES') throw new AppError(`本机端口 ${port} 已占用或无权绑定`, 409, 'PORT_UNAVAILABLE');
      throw error;
    } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
