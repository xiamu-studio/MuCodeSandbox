import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import { z } from 'zod';

export const isSealedBase=(value:string)=>/^mu-base:[a-f0-9]{64}$/.test(value);
export const windowsBaseSchema=z.object({image:z.string().refine(v=>path.isAbsolute(v)||isSealedBase(v)),imageSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().refine(v=>!isSealedBase(v.image)||v.image.slice(8)===v.imageSha256,'Sealed base digest mismatch');
export const windowsConfigSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  cpus: z.number().int().min(1).max(16).default(2),
  memoryGiB: z.number().int().min(2).max(32).default(4),
  diskGiB: z.number().int().min(16).max(256).default(24),
  timezone: z.string().refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }).default('UTC'),
  // A protected image is explicitly prepared before it can be used for work.
  image: z.string().refine(v => path.isAbsolute(v)||isSealedBase(v)),
  imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  proxy: z.object({
    mode: z.enum(['http', 'https', 'socks5']),
    address: z.string().refine(isIPv4),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(1024).default(''),
    password: z.string().max(4096).default(''),
    serverName: z.string().regex(/^[a-zA-Z0-9.-]+$/).optional(),
  }).strict().refine(v => v.mode !== 'https' || !!v.serverName, 'HTTPS proxy requires a TLS server name'),
  expectedIp: z.string().refine(isIPv4),
  dns:z.object({address:z.string().refine(isIPv4),serverName:z.string().regex(/^[a-zA-Z0-9.-]+$/),port:z.number().int().min(1).max(65535),path:z.string().regex(/^\/[a-zA-Z0-9/_?=.%+-]*$/)}).strict().optional(),
}).strict().refine(v=>!isSealedBase(v.image)||v.image.slice(8)===v.imageSha256,'Sealed base digest mismatch');
export type WindowsConfig = z.infer<typeof windowsConfigSchema>;
export const RELAY_PORT = 17401;
export const PROBE_PORT = 17402;
// Reserved before package installation; 991 is systemd-resolve in the pinned
// Canonical image and must never be mistaken for our tunnel identity.
export const NET_UID = 970;
export const PROBE_UID = 971;

export function vmIdentity(id: string) {
  z.uuid().parse(id);
  const hash = createHash('sha256').update(id).digest();
  const slot = hash.readUInt16BE(0) % 16384;
  const third = slot >> 6, fourth = (slot & 63) * 4;
  return {
    name: `mu-win-${id.replaceAll('-', '')}`,
    subnet: `172.29.${third}.${fourth}/30`,
    host: `172.29.${third}.${fourth + 1}`,
    guest: `172.29.${third}.${fourth + 2}`,
    mac: `00155D${hash.subarray(2, 5).toString('hex').toUpperCase()}`,
  };
}

export function windowsPaths(root: string, id: string) {
  const directory = path.join(root, vmIdentity(id).name);
  return { directory, disk: path.join(directory, 'disk.vhdx'), seed: path.join(directory, 'seed.iso'),
    key: path.join(directory, 'management'), hostKey: path.join(directory, 'host-ed25519'),
    knownHosts: path.join(directory, 'known_hosts'), manifest: path.join(directory, 'manifest.json') };
}
