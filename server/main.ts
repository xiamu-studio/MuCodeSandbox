import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from './service.ts';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requested = Number(process.env.MU_PORT ?? 4367);
let service;
try { service = await createService({ rootDir, port: requested, dev: process.argv.includes('--dev') }); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  service = await createService({ rootDir, port: 0, dev: process.argv.includes('--dev') });
}
console.log(`MuCodeSandbox is ready at ${service.launchUrl()}`);
console.log(`Data: ${service.manager.store.dataDir}`);
const shutdown = () => void service.close().then(() => process.exit(0));
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
