import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isIPv4 } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import type { NetworkConfig, Environment } from '../shared/types.ts';
import { AppError } from './errors.ts';
import { wireguardParametersSchema, wireguardEndpointSchema } from './wireguard.ts';
import { BROWSER_HOME_URL } from '../shared/browser-home.ts';

const mountSchema = z.object({
  id: z.string().uuid(),
  hostPath: z.string().min(1).max(4096),
  guestPath: z.string().regex(/^\/workspace(?:\/[A-Za-z0-9._ -]+)*$/).max(256),
  writable: z.boolean(),
}).strict().refine(m => m.guestPath.split('/').every(p => p !== '.' && p !== '..'), '共享目录不能包含路径跳转');

function validCACertificate(pem: string) {
  if (!pem) return true;
  if (!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/.test(pem)) return false;
  try { return new X509Certificate(pem).ca; } catch { return false; }
}

export const networkSchema = z.object({
  mode: z.enum(['direct', 'http', 'https', 'socks5', 'wireguard']),
  host: z.string().max(253).default(''),
  port: z.number().int().min(1).max(65535).default(7890),
  username: z.string().max(256).default(''),
  password: z.string().max(512).optional(),
  wireguard: wireguardParametersSchema.optional(),
  noProxy: z.string().max(2048).regex(/^[A-Za-z0-9.*,:/\-\[\]\s]*$/).default('localhost,127.0.0.1'),
  strict: z.boolean().default(false),
  transparent: z.boolean().default(false),
  egressLock: z.object({ expectedIp: z.string().trim().refine(isIPv4, '请输入明确批准的 IPv4 地址') }).strict().optional(),
  tls: z.object({
    serverName: z.string().trim().min(1).max(253).regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/),
    certificate: z.string().trim().max(16384).refine(validCACertificate, '请输入单份有效的 CA 证书，不能使用私钥或服务器证书').optional(),
  }).strict().optional(),
  dns: z.object({
    address: z.string().refine(isIPv4, '请输入 DNS 服务的 IPv4 地址'),
    serverName: z.string().max(253).regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/),
    port: z.number().int().min(1).max(65535).default(443),
    path: z.string().max(256).regex(/^\/[A-Za-z0-9._~\/-]*$/).default('/dns-query'),
  }).strict().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.mode === 'wireguard') {
    if (!v.strict || !v.transparent) ctx.addIssue({ code: 'custom', path: ['mode'], message: '整包隧道必须启用 Linux 防火墙和受控路由' });
    if (!v.wireguard) ctx.addIssue({ code: 'custom', path: ['wireguard'], message: '请填写 WireGuard 配置' });
    if (!wireguardEndpointSchema.safeParse({ address: v.host, port: v.port }).success) ctx.addIssue({ code: 'custom', path: ['host'], message: '隧道端点必须填写明确的单播 IPv4 地址' });
    if (v.wireguard?.address.slice(0, -3) === v.host) ctx.addIssue({ code: 'custom', path: ['host'], message: '隧道端点不能与隧道地址相同' });
    if (v.username || v.password) ctx.addIssue({ code: 'custom', path: ['username'], message: '整包隧道使用密钥，不使用代理用户名和密码' });
  } else if (v.wireguard) ctx.addIssue({ code: 'custom', path: ['wireguard'], message: 'WireGuard 设置仅适用于整包隧道' });
  if (v.mode !== 'direct' && !/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|[0-9a-fA-F:]+)$/.test(v.host)) {
    ctx.addIssue({ code: 'custom', path: ['host'], message: '请输入有效的代理服务器地址' });
  }
  if (v.strict && v.mode === 'direct') ctx.addIssue({ code: 'custom', path: ['strict'], message: '仅代理联网模式必须配置代理' });
  if (v.transparent && !v.strict) ctx.addIssue({ code: 'custom', path: ['transparent'], message: '透明代理必须启用 Linux 防火墙' });
  if (v.egressLock && (!v.strict || !v.transparent)) ctx.addIssue({ code: 'custom', path: ['egressLock'], message: '出口变化停机须启用 Linux 防火墙与透明代理' });
  if (v.mode === 'https' && (!v.strict || !v.transparent)) ctx.addIssue({ code: 'custom', path: ['mode'], message: 'HTTPS 加密代理须启用仅代理联网和透明代理' });
  if (v.mode === 'https' && !v.tls) ctx.addIssue({ code: 'custom', path: ['tls'], message: 'HTTPS 加密代理须填写证书服务器名称' });
  if (v.mode !== 'https' && v.tls) ctx.addIssue({ code: 'custom', path: ['tls'], message: '证书设置仅适用于 HTTPS 加密代理' });
  if (v.strict && v.noProxy.split(',').some(s => s.trim() && !['localhost', '127.0.0.1', '::1'].includes(s.trim()))) ctx.addIssue({ code: 'custom', path: ['noProxy'], message: '仅代理联网模式不允许外部直连地址' });
});

export const identitySchema = z.object({
  timezone: z.string().max(100).regex(/^[A-Za-z0-9_+\-/]+$/).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, '请输入有效的 IANA 时区').transform(value => new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone),
  locale: z.enum(['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'de-DE']),
}).strict();

export const environmentSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(240).default(''),
  kind: z.enum(['vm', 'browser']).default('vm'),
  color: z.enum(['green', 'blue', 'amber', 'rose']).default('green'),
  cpus: z.number().int().min(1).max(32).default(4),
  memoryGiB: z.number().int().min(1).max(64).default(4),
  diskGiB: z.number().int().min(10).max(256).default(30),
  mounts: z.array(mountSchema).max(16).default([]),
  ports: z.array(z.object({ id: z.string().uuid(), guestPort: z.number().int().min(1024).max(65535), hostPort: z.number().int().min(1024).max(65535) }).strict()).max(16).default([]),
  network: networkSchema.default({ mode: 'direct', host: '', port: 7890, username: '', noProxy: 'localhost,127.0.0.1', strict: false, transparent: false }),
  browserUrl: z.string().url().max(2048).refine(v => ['https:', 'http:'].includes(new URL(v).protocol), '只支持 HTTP 或 HTTPS 地址').default(BROWSER_HOME_URL),
  identity: identitySchema.default(() => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: 'en-US' as const })),
}).strict().superRefine((e, ctx) => {
  if (e.kind === 'browser' && e.network.strict) ctx.addIssue({ code: 'custom', path: ['network', 'strict'], message: '本机浏览器尚不支持 Linux 仅代理联网防火墙' });
  if (e.kind !== 'vm' && ['https', 'wireguard'].includes(e.network.mode)) ctx.addIssue({ code: 'custom', path: ['network', 'mode'], message: '此网络模式当前只支持 Linux 虚拟机' });
});

export async function validateMounts(mounts: Environment['mounts'], dataDir: string) {
  const home = await realpath(homedir());
  const privateRoot = await realpath(dataDir);
  const guestPaths: string[] = [];
  const result = [];
  for (const mount of mounts) {
    let hostPath: string;
    try {
      hostPath = await realpath(path.resolve(mount.hostPath));
      if (!(await stat(hostPath)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new AppError(`项目目录不存在或无法访问：${mount.hostPath}`);
    }
    const relative = path.relative(home, hostPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new AppError('请选择用户目录中的具体项目文件夹');
    if (hostPath === privateRoot || hostPath.startsWith(privateRoot + path.sep) || privateRoot.startsWith(hostPath + path.sep)) throw new AppError('不能共享应用的数据目录或其父目录');
    for (const sensitive of ['.ssh', '.gnupg', '.aws', '.config', 'Library']) {
      const protectedPath = path.join(home, sensitive);
      if (hostPath === protectedPath || hostPath.startsWith(protectedPath + path.sep)) throw new AppError('不能把密钥或系统配置目录作为项目共享');
    }
    const guestPath = path.posix.normalize(mount.guestPath);
    if (guestPath !== mount.guestPath || guestPath.split('/').some(part => part === '..' || part === '.')) throw new AppError('沙箱目录必须位于 /workspace 下');
    if (guestPaths.some(p => p === guestPath || p.startsWith(guestPath + '/') || guestPath.startsWith(p + '/'))) throw new AppError('共享目录的沙箱路径不能重复或互相嵌套');
    guestPaths.push(guestPath);
    result.push({ ...mount, hostPath, guestPath });
  }
  return result;
}

export function proxyUrl(network: NetworkConfig, guest = false) {
  if (network.mode === 'direct' || network.mode === 'wireguard') return '';
  const host = guest && ['localhost', '127.0.0.1', '::1'].includes(network.host) ? 'host.lima.internal' : network.host;
  const url = new URL(`${network.mode === 'socks5' ? 'socks5h' : network.mode}://${host.includes(':') ? `[${host}]` : host}:${network.port}`);
  if (network.username) url.username = network.username;
  if (network.password) url.password = network.password;
  return url.toString().replace(/\/$/, '');
}

export function redact(text: string) {
  return text.replace(/(https?|socks5h?):\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, '$1://***@')
    .replace(/((?:api[_-]?key|private[_-]?key|token|password)["']?\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1***');
}
