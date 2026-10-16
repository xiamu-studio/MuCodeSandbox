import { isIPv4 } from 'node:net';
import { createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { z } from 'zod';

export const WIREGUARD_INTERFACE = 'mu_wg';
export const WIREGUARD_MARK = 0x4d550003;
export interface WireguardTransport { endpoint: { address: string; port: number }; listenPort: number }
export function validateWireguardTransport(value: WireguardTransport) {
  wireguardEndpointSchema.parse(value.endpoint);
  z.number().int().min(1).max(65535).parse(value.listenPort);
  return value;
}
const key = z.string().refine(value => {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value && decoded.some(byte => byte !== 0);
}, 'WireGuard keys must contain exactly 32 bytes in canonical base64');
const unicast = z.string().refine(value => {
  if (!isIPv4(value)) return false;
  const first = Number(value.split('.')[0]);
  return first > 0 && first < 224 && first !== 127;
}, 'An explicit unicast IPv4 address is required');

// The first packet tunnel supports one IPv4 peer and a full default route.
// Arbitrary directives, split routes and shell hooks are deliberately absent.
export const wireguardParametersSchema = z.object({
  address: z.string().refine(value => value.endsWith('/32') && unicast.safeParse(value.slice(0, -3)).success, 'An IPv4 /32 tunnel address is required'),
  privateKey: key.optional(),
  peerPublicKey: key,
  listenPort: z.number().int().min(1).max(65535).default(51821),
  mtu: z.number().int().min(1280).max(1420).default(1420),
}).strict();
export const wireguardEndpointSchema = z.object({ address: unicast, port: z.number().int().min(1).max(65535) }).strict();
export const wireguardSchema = wireguardParametersSchema.extend({ privateKey: key, endpoint: wireguardEndpointSchema }).superRefine((value, context) => {
  if (value.address.slice(0, -3) === value.endpoint.address) context.addIssue({ code: 'custom', path: ['endpoint', 'address'], message: 'The peer endpoint must differ from the tunnel address' });
});

export type WireguardConfig = z.infer<typeof wireguardSchema>;

export function wireguardPublicKey(privateKey: string) {
  const raw = Buffer.from(key.parse(privateKey), 'base64');
  const secret = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
  return createPublicKey(secret).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

export function wireguardPublicState(input: WireguardConfig) {
  const c = wireguardSchema.parse(input);
  return { publicKey: wireguardPublicKey(c.privateKey), peerPublicKey: c.peerPublicKey, endpoint: `${c.endpoint.address}:${c.endpoint.port}`, address: c.address, listenPort: c.listenPort, mtu: c.mtu, mark: WIREGUARD_MARK, allowedIPs: '0.0.0.0/0', keepalive: 25 };
}

export function wireguardStateHash(input: WireguardConfig) {
  return createHash('sha256').update(JSON.stringify(wireguardPublicState(input))).digest('hex');
}

/** Contains a private key: write to a root-only file, never logs or arguments. */
export function wireguardSetconf(input: WireguardConfig) {
  const config = wireguardSchema.parse(input);
  return `[Interface]\nPrivateKey = ${config.privateKey}\nListenPort = ${config.listenPort}\nFwMark = ${WIREGUARD_MARK}\n\n[Peer]\nPublicKey = ${config.peerPublicKey}\nEndpoint = ${config.endpoint.address}:${config.endpoint.port}\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25\n`;
}

export function wireguardNamespaceFirewall(input: WireguardConfig) {
  const config = wireguardSchema.parse(input);
  return `table inet mu_wg_fixture {
  counter blocked {}
  chain output {
    type filter hook output priority 0; policy drop;
    oifname "lo" accept
    oifname "${WIREGUARD_INTERFACE}" meta nfproto ipv4 meta l4proto tcp accept
    oifname "${WIREGUARD_INTERFACE}" meta nfproto ipv4 udp dport 53 accept
    meta mark ${WIREGUARD_MARK} ip daddr ${config.endpoint.address} udp dport ${config.endpoint.port} accept
    counter name blocked drop
  }
  chain input {
    type filter hook input priority 0; policy drop;
    iifname "lo" accept
    iifname "${WIREGUARD_INTERFACE}" meta nfproto ipv4 ct state established,related accept
    ip saddr ${config.endpoint.address} udp sport ${config.endpoint.port} udp dport ${config.listenPort} accept
    counter name blocked drop
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    counter name blocked drop
  }
}\n`;
}
