export type EnvironmentState = 'not_created' | 'stopped' | 'running' | 'creating' | 'starting' | 'stopping' | 'deleting' | 'error';
export type EnvironmentKind = 'vm' | 'browser';
export interface Mount { id: string; hostPath: string; guestPath: string; writable: boolean }
export interface PortForward { id: string; guestPort: number; hostPort: number }
export interface NetworkConfig {
  mode: 'direct' | 'http' | 'https' | 'socks5' | 'wireguard';
  host: string;
  port: number;
  username: string;
  password?: string;
  passwordConfigured?: boolean;
  noProxy: string;
  strict: boolean;
  transparent?: boolean;
  tls?: { serverName: string; certificate?: string };
  wireguard?: { address: string; privateKey?: string; privateKeyConfigured?: boolean; peerPublicKey: string; listenPort: number; mtu: number };
  egressLock?: { expectedIp: string };
  dns?: { address: string; serverName: string; port: number; path: string };
}
export interface IdentityConfig { timezone: string; locale: 'en-US' | 'zh-CN' | 'zh-TW' | 'ja-JP' | 'de-DE' }
export interface Environment {
  id: string;
  instanceName: string;
  name: string;
  description: string;
  kind: EnvironmentKind;
  color: string;
  cpus: number;
  memoryGiB: number;
  diskGiB: number;
  mounts: Mount[];
  ports: PortForward[];
  network: NetworkConfig;
  browserUrl: string;
  identity: IdentityConfig;
  state: EnvironmentState;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  browserRunning: boolean;
}
export interface Job {
  id: string;
  environmentId: string | null;
  action: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  message: string;
  createdAt: string;
  finishedAt: string | null;
}
export interface LogEntry {
  id: number;
  environmentId: string | null;
  jobId: string | null;
  level: 'info' | 'error';
  message: string;
  createdAt: string;
}
export interface SystemInfo {
  platform: string;
  arch: string;
  hostname: string;
  cpus: number;
  memoryGiB: number;
  freeMemoryGiB: number;
  dataDir: string;
  version: string;
  runtime: { available: boolean; path: string | null; version: string | null; error: string | null };
  browser: { available: boolean; engine: string; native: boolean };
  application?: { channel: 'desktop-test' | 'source-preview'; buildId: string; builtAt: string | null };
  hostNetwork?: { state: 'starting' | 'ready' | 'failed'; issue: string | null };
}
export interface Metrics {
  cpuPercent: number;
  memoryUsedMiB: number;
  memoryTotalMiB: number;
  diskUsedGiB: number;
  diskTotalGiB: number;
  uptimeSeconds: number;
}
export interface Snapshot { environments: Environment[]; jobs: Job[]; system: SystemInfo }
export const HOST_COMMANDS = ['git-status', 'git-diff', 'git-log'] as const;
export type HostCommand = typeof HOST_COMMANDS[number];
export interface BridgeGrant { id:string; environmentId:string; root:string; writable:boolean; commands:HostCommand[]; expiresAt:string; guestReady:boolean }
export interface AgentStatus { installed: boolean; version: string | null; nodeVersion: string | null }
export interface EgressVerification {
  requiredReceivers: 2;
  receipts: { receiver: 'ipwho' | 'ipify' | 'icanhazip'; ip: string; latencyMs: number; country?: string; city?: string }[];
  timedOutReceivers: ('ipwho' | 'ipify' | 'icanhazip')[];
}
export interface EgressCheck {
  receiver:'ipwho'|'ipify'|'icanhazip';
  status:'pending'|'success'|'timeout'|'command-timeout'|'tls-error'|'auth-error'|'dns-error'|'connection-error'|'invalid-response'|'cancelled';
  ip?:string;latencyMs?:number;
  diagnostics?: {curlExitCode:number;httpStatus:number;tcpConnectMs:number;tlsHandshakeMs:number;firstByteMs:number;totalMs:number};
}
export interface NetworkResult { ip: string; country: string; city: string; latencyMs: number; source: 'guest' | 'host'; verification?: EgressVerification }
export interface EgressStatus {
  status: 'disabled' | 'unverified' | 'verified' | 'changed' | 'unavailable';
  expectedIp?: string;
  actualIp?: string;
  checkedAt?: string;
  issue?: string;
  verification?: EgressVerification;
  checks?:EgressCheck[];
}
export interface NetworkProtection {
  prepared: boolean;
  bootArmed: boolean;
  active: boolean;
  policy: 'transparent' | 'packet-tunnel' | 'proxy-only' | 'application-proxy' | 'direct';
  firewallActive: boolean;
  transparentReady: boolean;
  transparentActive: boolean;
  proxyEndpoints: string[];
  blockedPackets: number;
  checkedAt: string;
  integrity?: 'verified' | 'changed' | 'unverified' | 'inactive';
  firewallHash?: string;
  bootFileHash?: string;
  tunnelConfigHash?: string;
  routingReady?: boolean;
  dnsGuardActive?: boolean;
  leasePrepared?: boolean;
  leaseActive?: boolean;
  leaseRemainingMs?: number;
  leaseRulesHash?: string;
  leaseBootHash?: string;
  wireguardStateHash?: string;
  wireguardBootHash?: string;
  wireguardHandshakeAge?: number;
  issues?: string[];
}
export interface BrowserInspection {
  timezone: string; locale: string; language: string; languages: string[];
  platform: string; userAgent: string; hardwareConcurrency: number;
  deviceMemoryGiB: number | null; screenWidth: number; screenHeight: number;
  webRtcPolicy: string; matchesConfiguration: boolean; checkedAt: string;
}
export interface BrowserVersionStatus {
  installedVersion: string | null;
  availableVersion: string;
  updateAvailable: boolean;
  recoveryRequired: boolean;
  installedChannel?: 'stable' | 'testing' | null;
  availableChannel?: 'stable' | 'testing';
  requiresFreshProfile?: boolean;
}
export interface LabInfo { running: boolean; url?: string; dnsPort?: number; stunPort?: number; receiptCount?: number; eventCount?: number; modelCalls?: number; scope?: string }
export interface LocalCheckReport {
  id: string; environmentId: string; environmentName: string; checkedAt: string;
  state: 'running' | 'passed' | 'failed'; accountFree: true; paidModelCalls: 0;
  scope: string; checks: { name: string; passed: boolean; detail: string }[]; error?: string;
}
export interface EnvironmentSnapshot { id: string; environmentId: string; name: string; createdAt: string; bytes: number }
