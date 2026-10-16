import { LimaRuntime } from '../server/runtime.ts';
import { Store } from '../server/store.ts';
import { run } from '../server/process.ts';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [data, id, bundle] = process.argv.slice(2);
if (!data || !id || !process.send) throw new Error('Migration worker requires an isolated fixture and IPC');
process.channel?.ref();
const compiled = bundle ? path.join(bundle, 'Contents/Resources/app/dist-server/server') : undefined;
const StoreClass: typeof Store = compiled ? (await import(pathToFileURL(path.join(compiled, 'store.js')).href)).Store : Store;
const RuntimeClass: typeof LimaRuntime = compiled ? (await import(pathToFileURL(path.join(compiled, 'runtime.js')).href)).LimaRuntime : LimaRuntime;
const store = new StoreClass(data);
const e = store.get(id);
const runtime = new RuntimeClass(data, async (file, args, options) => {
  const output = await run(file, args, options);
  if (args[1] === 'start') {
    process.send!({ stage: 'maintenance-running', instanceName: e.instanceName, compiledRoot: compiled ?? null });
    // The parent kills this owned process after independently checking that
    // the actual maintenance VM has no shared exports or project mounts.
    await new Promise(() => {});
  }
  return output;
});
try { await runtime.migrateSharedMounts(e); }
catch (error) { process.send({ error: String(error) }); process.exitCode = 1; }
finally { store.close(); }
