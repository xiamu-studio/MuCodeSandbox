import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../server/process.ts';
const root = path.resolve(import.meta.dirname, '..');
if (process.platform !== 'darwin') throw new Error('Native bridge currently requires macOS');
await mkdir(path.join(root, 'native/bin'), { recursive: true });
await run('/usr/bin/xcrun', ['swiftc', '-O', path.join(root, 'native/BridgeHelper.swift'), '-o', path.join(root, 'native/bin/mu-host-bridge')], { timeoutMs: 90_000, onOutput: text => process.stdout.write(text) });
await copyFile(path.join(root, 'native/host-command.sb'), path.join(root, 'native/bin/host-command.sb'));
await run('/usr/bin/xcrun', ['swiftc', '-O', path.join(root, 'native/NetworkSnapshot.swift'), path.join(root, 'native/NetworkMonitor.swift'), '-o', path.join(root, 'native/bin/mu-network-monitor')], { timeoutMs: 90_000, onOutput: text => process.stdout.write(text) });
