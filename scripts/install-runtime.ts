import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { LimaRuntime } from '../server/runtime.ts';

const dataDir = path.resolve(process.env.MU_DATA_DIR ?? path.join(homedir(), '.mucodesandbox'));
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const runtime = new LimaRuntime(dataDir);
await runtime.install({ onOutput: text => process.stdout.write(text) });
console.log(await runtime.info());
