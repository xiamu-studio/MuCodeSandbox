export type ProbeProvider = 'ipwho' | 'ipify';
export interface ExitObservation {
  id: number; at: string; provider: ProbeProvider; status: 'success' | 'failed';
  ip?: string; country?: string; city?: string; latencyMs?: number;
}
export interface ConnectionObservation {
  id: number; at: string; target: string; port: number; status: 'attempt' | 'failed' | 'dns-result' | 'dns-cached';
  protocol: 'TCP' | 'UDP' | 'DNS'; route: 'proxy' | 'proxy-dns';
  domain?: string; domainSource?: 'connection' | 'dns'; domainCandidates?: string[];
  dnsAddresses?: string[]; dnsTtlSeconds?: number;
  exitIp?: string; exitCheckedAt?: string; exitSource?: 'verification' | 'observation';
}
export interface ExitVerificationObservation {
  id: number; at: string; status: 'verified' | 'changed' | 'unavailable'; ip?: string;
}
export interface NetworkObservations {
  enabled: boolean; capture: 'ready' | 'waiting' | 'unsupported' | 'error';
  captureIssue?: string; collectedAt?: string; captureGaps: number; startedAt: string; sampleIntervalSeconds: number;
  lockIp: string | null; samples: ExitObservation[]; connections: ConnectionObservation[];
  summary: { state: 'waiting' | 'unchanged' | 'changed' | 'failed' | 'stale';
    lastIp: string | null; lastCheckedAt: string | null; distinctIps: number; changes: number;
    failures: number; successes: number; firstCheckedAt: string | null };
}

export function exitSummary(samples: ExitObservation[], now = Date.now()): NetworkObservations['summary'] {
  const successes = samples.filter(s => s.status === 'success' && s.ip);
  const last = successes.at(-1), latest = samples.at(-1);
  let changes = 0;
  const byProvider = new Map<string, string>();
  for (const s of successes) {
    if (byProvider.has(s.provider) && byProvider.get(s.provider) !== s.ip) changes++;
    byProvider.set(s.provider, s.ip!);
  }
  const distinctIps = new Set(successes.map(s => s.ip)).size;
  const state = !latest ? 'waiting' : now - Date.parse(latest.at) > 90_000 ? 'stale'
    : latest.status === 'failed' || samples.slice(-2).some(s => s.status === 'failed') ? 'failed'
    : distinctIps > 1 ? 'changed' : successes.length < 2 ? 'waiting' : 'unchanged';
  return { state, lastIp: last?.ip ?? null, lastCheckedAt: latest?.at ?? null, distinctIps, changes,
    failures: samples.filter(s => s.status === 'failed').length, successes: successes.length,
    firstCheckedAt: samples[0]?.at ?? null };
}

export function logSummary(message: string): string {
  const text=message.trim();
  if (/^\d+\.\d+\.\d+\.\d+:[a-f0-9]{64}:\d+$/.test(text)) return `浏览器安装版本 ${text.split(':')[0]} 已核验`;
  if (/^\/usr\/bin\/Xvfb/.test(text)) return '浏览器图形显示组件已就绪';
  if (/^stored passwd in file:/.test(text)) return '浏览器画面连接凭据已准备';
  if (/^Linux browser ready:/.test(text)) return '沙箱浏览器已就绪，可以连接画面';
  if (/^Checking the management gateway/.test(text)) return '正在核验沙箱管理连接';
  if (/^Inspecting applied firewall/.test(text)) return '正在核验网络防护与开机规则';
  if (/^Transparent TCP and proxy DNS enabled/.test(text)) return '透明代理与受控 DNS 已启动';
  if (/Linux renderer and graphics sandbox verified/.test(message)) return '浏览器隔离检查通过，可以打开网页';
  if (/"(?:processes|effectiveCapabilities|separatePidNamespace|seccomp)"/.test(message)) return '浏览器隔离检查详情';
  if (message.trim().startsWith('{') || message.length > 500) return '运行诊断已记录，展开查看详情';
  if (/[a-zA-Z]/.test(text) && !/[\u4e00-\u9fff]/.test(text)) return '运行组件信息，展开查看详情';
  return message.trim().split('\n')[0].slice(0, 180) || '运行事件';
}
