import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import type { Environment, EgressStatus, NetworkProtection, BrowserInspection, BrowserVersionStatus, BridgeGrant } from '../shared/types.ts';
import { api, ApiError } from './api.ts';
import { Button, SectionHeading } from './components.tsx';
import { exitVerified, freshReading, protectionVerified, type StatusDestination } from './environment-status.ts';

type NetworkReading = { protection: NetworkProtection | null; egress: EgressStatus | null; protectionError: string; egressError: string; loading: boolean; refresh: () => Promise<void> };
const empty: Omit<NetworkReading, 'refresh'> = { protection: null, egress: null, protectionError: '', egressError: '', loading: false };
const NetworkContext = createContext<NetworkReading>({ ...empty, refresh: async () => {} });
export const useEnvironmentNetwork = () => useContext(NetworkContext);

export function EnvironmentStatusProvider({ environment, children, busy = false }: { environment: Environment; children: ReactNode; busy?: boolean }) {
  const key = `${environment.id}:${environment.updatedAt}:${environment.state}:${busy}`;
  const [reading, setReading] = useState({ ...empty, key });
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let live = true, guardFailed = false, pending: Promise<void> | null = null, requestAbort: AbortController | undefined;
    setReading({ ...empty, key });
    const update = () => {
      if (pending) return pending;
      if (busy || environment.kind !== 'vm' || environment.state !== 'running') return Promise.resolve();
      setReading(value => ({ ...value, loading: true }));
      pending = (async () => {
        const windows=window.__MU_CONFIG__?.platform==='win32',abort=windows?new AbortController():undefined;
        requestAbort=abort;const signal=abort?AbortSignal.any([abort.signal,AbortSignal.timeout(12000)]):undefined;
        if(windows){
          const failure=(reason:unknown)=>reason instanceof ApiError&&reason.code==='PROTECTION_BUSY'?'':reason instanceof Error&&reason.name==='TimeoutError'?'状态读取超时，请等待重新核验。':String(reason instanceof Error?reason.message:reason);
          const protection=(environment.network.strict?api.protection(environment.id,signal):Promise.resolve(null)).then(
            value=>{if(live&&!guardFailed)setReading(previous=>({...previous,protection:value,protectionError:''}));},
            reason=>{const message=failure(reason);if(live&&(!guardFailed||message))setReading(previous=>({...previous,protection:null,protectionError:message}));},
          );
          const egress=api.egress(environment.id,signal).then(
            value=>{if(exitVerified(environment,value))guardFailed=false;if(live)setReading(previous=>({...previous,egress:value,egressError:''}));},
            reason=>{if(reason instanceof ApiError&&reason.code==='GUARD_FAILED')guardFailed=true;const block=guardFailed,message=failure(reason);if(live)setReading(previous=>({...previous,egress:null,egressError:message,...(block?{protection:null,protectionError:message||previous.protectionError}:{})}));},
          );
          await Promise.all([protection,egress]);if(requestAbort===abort)requestAbort=undefined;
          if(live)setReading(previous=>({...previous,loading:false}));return;
        }
        const [protection, egress] = await Promise.allSettled([
          environment.network.strict ? api.protection(environment.id,signal) : Promise.resolve(null), api.egress(environment.id,signal),
        ]);
        if(requestAbort===abort)requestAbort=undefined;
        const failure=(value:PromiseSettledResult<unknown>)=>value.status==='rejected'?String(value.reason?.message??value.reason):'';
        if (live) setReading({ key, loading: false,
          protection: protection.status === 'fulfilled' ? protection.value : null,
          egress: egress.status === 'fulfilled' ? egress.value : null,
          protectionError: failure(protection),
          egressError: failure(egress),
        });
      })().finally(() => { pending = null; });
      return pending;
    };
    refresh.current = update;
    void update();
    const timer = setInterval(() => void update(), 10_000);
    return () => { live = false; requestAbort?.abort(); clearInterval(timer); refresh.current = async () => {}; };
  }, [key, environment.kind, environment.network.strict, busy]);
  return <NetworkContext.Provider value={{ ...(reading.key === key ? reading : empty), refresh: () => refresh.current() }}>{children}</NetworkContext.Provider>;
}

type Metadata = { version: BrowserVersionStatus | null; inspection: BrowserInspection | null; grants: BridgeGrant[] | null; errors: { version?: string; inspection?: string; grants?: string }; readAt?: string };
const emptyMetadata: Metadata = { version: null, inspection: null, grants: null, errors: {} };
const checkedTime = (at?: string) => at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '尚未读取';

export function EnvironmentHealth({ environment, busy, onNavigate, bridgeAvailable = true }: { environment: Environment; busy: boolean; onNavigate: (tab: StatusDestination) => void; bridgeAvailable?: boolean }) {
  const network = useEnvironmentNetwork();
  const [,expire] = useState(0);
  useEffect(() => {
    if (window.__MU_CONFIG__?.platform !== 'win32') return;
    const deadlines = [
      Date.parse(network.protection?.checkedAt ?? '') + Math.min(45_000, network.protection?.leaseRemainingMs ?? 0),
      Date.parse(network.egress?.checkedAt ?? '') + 45_000,
    ];
    const timers = deadlines.flatMap(deadline => {
      const delay = deadline - Date.now();
      return Number.isFinite(delay) && delay > 0 ? [setTimeout(() => expire(value => value + 1), delay + 1)] : [];
    });
    return () => timers.forEach(clearTimeout);
  }, [network.protection?.checkedAt, network.protection?.leaseRemainingMs, network.egress?.checkedAt]);
  const key = `${environment.id}:${environment.updatedAt}:${environment.state}:${environment.browserRunning}:${busy}`;
  const [metadata, setMetadata] = useState<Metadata & { key: string }>({ ...emptyMetadata, key });
  const [loading, setLoading] = useState(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let live = true, pending: Promise<void> | null = null;
    setMetadata({ ...emptyMetadata, key });
    setLoading(false);
    const update = () => {
      if (pending) return pending;
      if (busy) return Promise.resolve();
      setLoading(true);
      pending = (async () => {
        const running = environment.state === 'running';
        const [version, inspection, grants] = await Promise.allSettled([
          running ? api.browserVersion(environment.id) : Promise.resolve(null),
          running && environment.browserRunning ? api.inspectBrowser(environment.id) : Promise.resolve(null),
          bridgeAvailable ? api.bridgeGrants(environment.id) : Promise.resolve(null),
        ]);
        if (live) setMetadata({ key, version: version.status === 'fulfilled' ? version.value : null,
          inspection: inspection.status === 'fulfilled' ? inspection.value : null,
          grants: grants.status === 'fulfilled' ? grants.value : null, readAt: new Date().toISOString(),
          errors: Object.fromEntries(([['version', version], ['inspection', inspection], ['grants', grants]] as const)
            .flatMap(([name, result]) => result.status === 'rejected' ? [[name, String(result.reason.message ?? result.reason)]] : [])),
        });
      })().finally(() => { pending = null; if (live) setLoading(false); });
      return pending;
    };
    refresh.current = update; void update();
    return () => { live = false; refresh.current = async () => {}; };
  }, [key, bridgeAvailable]);
  const data = metadata.key === key ? metadata : emptyMetadata;
  const { protection, egress } = network;
  const running = environment.state === 'running', now = Date.now();
  const protectedNow = protectionVerified(environment, protection, now);
  const exitNow = exitVerified(environment, egress, now);
  const inspectionFresh = running && environment.browserRunning && freshReading(data.inspection?.checkedAt, now, 300_000);
  const browserMatches = inspectionFresh && data.inspection?.matchesConfiguration;
  const errorState = (error: string | undefined, value: unknown, good: boolean, at?: string) =>
    !running ? '未运行' : error ? '读取失败' : !value ? '待检测' : good ? '已核验' : at && !freshReading(at, now) ? '待刷新' : '需检查';
  const rows = [
    { title: '联网防护', target: environment.network.strict ? '仅代理联网 · 异常时关闭访问' : '未启用强制防护',
      actual: network.protectionError || (!running ? '启动后读取实际防护' : protection ? protectedNow ? '规则一致 · 联网许可有效' : protection.issues?.[0] || '当前防护未确认通过' : '尚未取得防护结果'),
      status: !environment.network.strict ? '未启用' : errorState(network.protectionError, protection, protectedNow, protection?.checkedAt), good: protectedNow, at: protection?.checkedAt, tab: 'network' },
    { title: '出口 IP', target: environment.network.egressLock?.expectedIp ?? '未配置批准出口',
      actual: network.egressError || (egress?.actualIp ? `${egress.actualIp} · ${egress.verification?.receipts.length ?? 0} 份回执` : egress?.issue || '尚无有效出口回执'),
      status: !environment.network.egressLock ? '未锁定' : errorState(network.egressError, egress?.status === 'unverified' ? null : egress, exitNow, egress?.checkedAt), good: exitNow, at: egress?.checkedAt, tab: 'network' },
    { title: '浏览器地区', target: `${environment.identity.timezone} · ${environment.identity.locale}`,
      actual: data.errors.inspection || (data.inspection ? `${data.inspection.timezone} · ${data.inspection.language}` : environment.browserRunning ? '等待读取浏览器' : '浏览器未打开，尚未实测'),
      status: !running ? '未运行' : data.errors.inspection ? '读取失败' : !data.inspection ? '待检测' : !inspectionFresh ? '待刷新' : browserMatches ? '与配置一致' : '存在差异', good: browserMatches, at: data.inspection?.checkedAt, tab: 'browser' },
    { title: '浏览器版本', target: data.version ? `${data.version.availableChannel === 'stable' ? '正式版' : '可用版本'} ${data.version.availableVersion}` : '读取本应用支持的版本',
      actual: data.errors.version || (data.version ? data.version.installedVersion ? `${data.version.installedChannel === 'stable' ? '正式版' : data.version.installedChannel === 'testing' ? '测试版' : '版本'} ${data.version.installedVersion}` : '尚未安装' : '启动后读取安装记录'),
      status: !running ? '未运行' : data.errors.version ? '读取失败' : !data.version ? '待检测' : data.version.recoveryRequired ? '需要恢复' : data.version.requiresFreshProfile ? '需空白资料' : data.version.updateAvailable ? '可更新' : data.version.installedVersion ? '已读取' : '未安装', good: false, at: data.version ? data.readAt : undefined, tab: 'browser' },
  ];
  const grants = data.grants?.filter(grant => Date.parse(grant.expiresAt) > now);
  const commands = grants?.filter(grant => grant.commands.length > 0);
  return <section className="environment-health" aria-label="环境状态总览">
    <SectionHeading title="环境状态" subtitle="配置与实际读数分开显示，检测时间按本机时区。" action={<Button icon={<RefreshCw size={15}/>} loading={loading || network.loading} disabled={busy} onClick={() => void Promise.allSettled([network.refresh(), refresh.current()])}>刷新状态</Button>}/>
    <div className="health-grid">{rows.map(row => <article className="health-card" key={row.title}>
      <header><h3>{row.title}</h3><span className={`health-state ${row.good ? 'verified' : 'pending'}`}>{row.status}</span></header>
      <dl><div><dt>配置</dt><dd>{row.target}</dd></div><div><dt>读取结果</dt><dd>{row.actual}</dd></div></dl>
      <footer><time>{row.at ? `检测于 ${checkedTime(row.at)}` : '尚未检测'}</time><button onClick={() => onNavigate(row.tab as StatusDestination)}>查看{row.tab === 'network' ? '网络' : '浏览器'}<ArrowRight size={13}/></button></footer>
    </article>)}</div>
    <div className="health-access"><div><strong>宿主访问</strong><span>{bridgeAvailable ? `${environment.mounts.length} 个共享目录 · ${environment.mounts.filter(m => m.writable).length} 个可写` : '手动上传与下载 · 无持续共享'}</span></div><div><strong>命令授权</strong><span>{!bridgeAvailable ? 'Windows 宿主命令授权尚未提供' : data.errors.grants ? '读取失败，请检查授权' : !commands ? '尚未读取' : commands.length ? `${commands.length} 项有效授权${commands.some(g => !g.guestReady) ? ' · 含未就绪项' : ''}` : '无有效命令授权'}</span></div><Button onClick={() => onNavigate(bridgeAvailable ? 'bridge' : 'settings')}>{bridgeAvailable ? '检查宿主授权' : '查看访问边界'}</Button></div>
  </section>;
}
