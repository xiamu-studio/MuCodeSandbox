import { Manager } from '../server/manager.ts';

const [dataDir, file] = process.argv.slice(2);
if (!dataDir || !file) throw new Error('Missing isolated backup worker paths');
let input = '';
for await (const chunk of process.stdin) {
  input += chunk.toString();
  if (input.length > 16_384) throw new Error('Backup worker input too large');
}
const { password } = JSON.parse(input) as { password: string };
const manager = new Manager(dataDir);
try {
  await manager.backups.import(file, password, 'Interrupted import', { onOutput: message => {
    if (message.startsWith('Materializing')) process.kill(process.pid, 'SIGKILL');
  } });
  throw new Error('Backup interruption checkpoint was not reached');
} finally { await manager.close(); }
