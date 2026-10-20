import type { RunOptions } from '../process.ts';

// Platform-neutral lifecycle contract for the Windows preview. The shipping Mac
// Manager continues to use its existing LimaRuntime until cross-platform UI work.
export interface VmBackend<T> {
  info(): Promise<{ available: boolean; issues: string[] }>;
  create(vm: T, options?: RunOptions): Promise<void>;
  start(vm: T, options?: RunOptions): Promise<void>;
  stop(vm: T, options?: RunOptions): Promise<void>;
  management(vm: T, command: string[], options?: RunOptions): Promise<string>;
}
