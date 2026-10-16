import { rebuild } from '@electron/rebuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import { access, chmod } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const version = require('electron/package.json').version;
await rebuild({ buildPath: root, electronVersion: version, onlyModules: ['node-pty-electron'], force: true });
for (const name of ['node-pty', 'node-pty-electron']) {
  for (const relative of ['build/Release/spawn-helper', `prebuilds/${process.platform}-${process.arch}/spawn-helper`]) {
    const helper = path.join(root, 'node_modules', name, relative);
    try { await access(helper); await chmod(helper, 0o755); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
console.log(`Electron ${version} terminal binding is ready.`);
