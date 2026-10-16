import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';

const root = path.resolve(import.meta.dirname, '..', 'test-results/client-environment-audit');
const registry = 'https://registry.npmjs.org';
const name = '@anthropic-ai/claude-code-linux-arm64';
const metadata = await json(`${registry}/@anthropic-ai%2fclaude-code/latest`);
const version = process.argv[2] ?? metadata.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid version');
const pkg = await json(`${registry}/@anthropic-ai%2fclaude-code-linux-arm64/${version}`);
if (pkg.name !== name || pkg.version !== version || pkg.dist.unpackedSize > 400 * 1024 ** 2) throw Error('Package identity or size rejected');
const target = new URL(pkg.dist.tarball);
if (target.origin !== registry || !target.pathname.startsWith('/@anthropic-ai/claude-code-linux-arm64/-/')) throw Error('Package source rejected');
const keys = await json(`${registry}/-/npm/v1/keys`);
const signed = Buffer.from(`${name}@${version}:${pkg.dist.integrity}`);
const signatureVerified = pkg.dist.signatures.some(signature => {
  const key = keys.keys.find(key => key.keyid === signature.keyid);
  if (!key || key.expires && Date.parse(key.expires) <= Date.now()) return false;
  return verify('sha256', signed, createPublicKey({ key: Buffer.from(key.key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(signature.sig, 'base64'));
});
if (!signatureVerified) throw Error('Registry signature not verified');
const directory = path.join(root, 'packages', version);
// Bind reused executables to an approved digest, rather than a mutable cache receipt alone.
const approved = {'2.1.296':'f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa'};
await mkdir(directory, { recursive: true, mode: 0o700 });
const existing = path.join(directory, 'receipt.json');
try {
  const receipt = JSON.parse(await readFile(existing, 'utf8'));
  const binary = await readFile(path.join(directory, receipt.binary));
  if (approved[version] && receipt.integrity === pkg.dist.integrity && receipt.signatureVerified &&
      sha(binary) === approved[version] && receipt.sha256 === approved[version]) {
    console.log(JSON.stringify({ reused: true, ...receipt }));
    process.exit(0);
  }
} catch {}
const response = await fetch(target, { signal: AbortSignal.timeout(180_000) });
if (!response.ok || new URL(response.url).origin !== registry) throw Error('Download source rejected');
const chunks = []; let bytes = 0;
for await (const chunk of response.body) {
  bytes += chunk.length;
  if (bytes > 128 * 1024 ** 2) throw Error('Download exceeds 128 MiB');
  chunks.push(chunk);
}
const archive = Buffer.concat(chunks);
if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== pkg.dist.integrity) throw Error('Archive integrity failed');
const extract = tar.extract(); let unpacked = 0; const files = [];
const finished = new Promise((resolve, reject) => {
  extract.on('entry', (header, stream, next) => {
    const parts = header.name.split('/');
    if (parts[0] !== 'package' || parts.some(part => part === '..') || path.posix.isAbsolute(header.name) || !['file','directory'].includes(header.type)) {
      extract.destroy(Error('Unsafe archive entry')); return;
    }
    const relative = parts.slice(1).join('/');
    if (header.type === 'directory') { stream.resume(); stream.on('end', next); return; }
    const data = [];
    stream.on('data', chunk => { unpacked += chunk.length; if (unpacked > 400 * 1024 ** 2) extract.destroy(Error('Unpacked size limit')); else data.push(chunk); });
    stream.on('end', async () => {
      try {
        const output = path.join(directory, relative);
        await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        const buffer = Buffer.concat(data);
        await writeFile(output, buffer, { mode: 0o600 });
        files.push({ path: relative, bytes: buffer.length, sha256: sha(buffer) }); next();
      } catch (error) { extract.destroy(error); }
    });
    stream.on('error', reject);
  });
  extract.on('finish', resolve); extract.on('error', reject);
});
Readable.from(archive).pipe(createGunzip()).pipe(extract);
await finished;
const entry = files.find(file => file.path === 'claude' || file.path === 'bin/claude');
if (!entry || (await stat(path.join(directory,entry.path))).size < 1000) throw Error('Native executable missing');
await chmod(path.join(directory, entry.path), 0o700);
const receipt = { fetchedAt: new Date().toISOString(), name, version, registryLatest: metadata.version,
  tarball: target.href, integrity: pkg.dist.integrity, signatureVerified, compressedBytes: bytes,
  unpackedBytes: unpacked, binary: entry.path, sha256: entry.sha256, files };
await writeFile(existing, JSON.stringify(receipt,null,2), { mode: 0o600 });
await writeFile(path.join(root,'registry-latest.json'), JSON.stringify({ checkedAt: new Date().toISOString(), version: metadata.version }, null, 2), { mode: 0o600 });
console.log(JSON.stringify(receipt));

function sha(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok || new URL(response.url).origin !== registry) throw Error('Registry request failed');
  const text = await response.text(); if (text.length > 1_000_000) throw Error('Registry response too large');
  return JSON.parse(text);
}
