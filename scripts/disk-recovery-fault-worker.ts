import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Manager as SourceManager } from '../server/manager.ts';
import type { LimaRuntime as SourceRuntime } from '../server/runtime.ts';

const [directory, id, bundle, point] = process.argv.slice(2);
if (!directory || !id || !bundle || !['before-filesystem', 'after-filesystem', 'after-database'].includes(point!) || !process.send)
  throw new Error('An owned fixture, package, checkpoint and IPC are required');
process.channel?.ref();
const compiled = path.join(bundle, 'Contents/Resources/app/dist-server/server');
const { Manager }: { Manager: typeof SourceManager } = await import(pathToFileURL(path.join(compiled, 'manager.js')).href);
const { LimaRuntime }: { LimaRuntime: typeof SourceRuntime } = await import(pathToFileURL(path.join(compiled, 'runtime.js')).href);
const runtime = new LimaRuntime(directory);
const manager = new Manager(directory, undefined, runtime);
const pause = async () => {
  process.send!({ checkpoint: point, compiled, pid: process.pid });
  await new Promise(() => {});
};
const management = runtime.management.bind(runtime);
runtime.management = async (environment, command, options) => {
  const growth = command[0] === 'sudo' && command[1] === 'python3';
  if (growth && point === 'before-filesystem') await pause();
  const output = await management(environment, command, options);
  if (growth && point === 'after-filesystem') await pause();
  return output;
};
if (point === 'after-database') {
  const save = manager.store.save.bind(manager.store);
  manager.store.save = value => {
    save(value);
    if (value.id === id && value.diskGiB === 12 && value.state === 'stopped') {
      process.send!({ checkpoint: point, compiled, pid: process.pid });
      // Keep the synchronous commit between SQLite save and journal removal.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  };
}
try {
  const job = await manager.growDisk(id, 12);
  await manager.tasks.get(job.id)!.promise;
  throw new Error('The requested fault checkpoint was not reached');
} catch (error) { process.send!({ error: String(error) }); process.exitCode = 1; }
finally { await manager.close(); }
