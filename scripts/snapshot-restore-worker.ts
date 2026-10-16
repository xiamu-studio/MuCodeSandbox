import { Store } from '../server/store.ts';
import { LimaRuntime } from '../server/runtime.ts';
import { Snapshots } from '../server/snapshots.ts';

const [dataDir, environmentId, snapshotId, checkpoint, mode] = process.argv.slice(2);
if (!dataDir || !environmentId || !snapshotId || !['Restored: disk', 'Recovered: disk', 'Recovery transaction committed', 'Restore configuration saved', 'Restore transaction committed'].includes(checkpoint))
  throw new Error('Supply an owned test directory, environment, snapshot and interruption checkpoint');
const store = new Store(dataDir), runtime = new LimaRuntime(dataDir);
if (mode === 'fixture') runtime.list = async () => store.list().map(e => ({ name: e.instanceName, status: 'Stopped' }));
const snapshots = new Snapshots(store, runtime);
const onOutput = (text: string) => {
  if (text.trim() === checkpoint) process.kill(process.pid, 'SIGKILL');
};
try {
  if (checkpoint.startsWith('Recover')) await snapshots.recover(store.get(environmentId), { onOutput });
  else await snapshots.restore(store.get(environmentId), snapshotId, { onOutput });
  throw new Error('Expected interruption checkpoint was not reached');
} finally { store.close(); }
