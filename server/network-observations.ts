import { randomUUID, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Environment, NetworkResult, EgressStatus } from '../shared/types.ts';
import { exitSummary, type ConnectionQuery,type ConnectionObservation, type ExitObservation, type ExitVerificationObservation, type NetworkObservations, type ProbeProvider } from '../shared/network-observations.ts';
import type { Store } from './store.ts';
import type { LimaRuntime } from './runtime.ts';

export const JOURNAL_NAMESPACE = 'mucodesandbox-network';
const MAX_JOURNAL = 501;
export function observationKey(e: Environment) { return createHash('sha256').update(JSON.stringify(e.network)).digest('hex'); }
export function captureSupported(e: Environment) { return e.kind === 'vm' && e.network.strict && e.network.transparent && ['http','https','socks5'].includes(e.network.mode); }

export function safeTarget(input: string): { target: string; port: number } | null {
  if (input.length > 300 || /[\s/@?#\\]/.test(input)) return null;
  const m = input.match(/^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9._:-]+):(\d{1,5})$/);
  if (!m) return null;
  const target = m[1].replace(/^\[|\]$/g, ''), port = Number(m[2]);
  if (port < 1 || port > 65535 || (!isIP(target) && !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(target))) return null;
  return { target, port };
}
export function parseConnection(message: string): Omit<ConnectionObservation, 'id'|'at'> | null {
  if (message.length > 8192) return null;
  const clean = message.replace(/\x1b\[[0-9;]*m/g, '');
  const dns=clean.match(/dns: (cached|exchanged) (?:A|AAAA|CNAME|HTTPS|SVCB) ([a-zA-Z0-9.-]+)\.\s/);
  if(dns) {
    const target=safeTarget(`${dns[2]}:53`);
    if(target) {
      const answer=clean.match(/\.(?:\s+)(\d+) IN (A|AAAA) ([0-9a-fA-F:.]+)(?:\s|$)/);
      return {...target,status:dns[1]==='cached'?'dns-cached':'dns-result',protocol:'DNS',route:'proxy-dns',
        ...(answer&&isIP(answer[3])?{dnsAddresses:[answer[3]],dnsTtlSeconds:Math.min(Number(answer[1]),86400)}:{})};
    }
  }
  // Extract only a host and port. Arbitrary log text, URLs and credentials never enter storage.
  const route = clean.match(/outbound\/(?:http|socks)\[upstream\]: outbound (?:packet )?connection to ([^\s,]+)(?:\s|$)/);
  const error = /\bERROR\b/.test(clean) ? clean.match(/(?:dial (?:tcp|udp)|connect(?:ion)? to) ([^\s,]+)(?:\s|: |$)/) : null;
  const destination = safeTarget(((route ?? error)?.[1] ?? '').replace(/:$/,''));
  return destination ? { ...destination, status: route ? 'attempt' : 'failed', protocol: /\b(?:udp|packet)\b/i.test(clean) ? 'UDP' : 'TCP', route: 'proxy' } : null;
}

export interface JournalBatch { cursor: string | null; events: { key: string; at: string; value: Omit<ConnectionObservation,'id'|'at'> }[]; truncated: boolean }
// Only observed host names are retained. DNS associations are explicitly weaker than
// a domain requested by this exact connection; shared CDN IPs must not be guessed.
export class JournalContext {
  traces = new Map<string,{domain?:string;port:number;at:number;addresses:string[];origin:'exit-check'|'traffic'}>();
  dns = new Map<string,Map<string,{at:number;expires:number}>>();
  prune(at:number) {
    for(const [key,value] of this.traces)if(at-value.at>120_000)this.traces.delete(key);
    for(const [ip,domains] of this.dns){for(const [domain,value] of domains)if(value.expires<at)domains.delete(domain);if(!domains.size)this.dns.delete(ip);}
    while(this.traces.size>2048)this.traces.delete(this.traces.keys().next().value!);
    while(this.dns.size>1024)this.dns.delete(this.dns.keys().next().value!);
  }
}
export function parseJournal(output: string, context=new JournalContext()): JournalBatch {
  if (Buffer.byteLength(output) > 2_000_000) throw new Error('Journal too large');
  const lines = output.trim().split('\n').filter(Boolean);
  const events: JournalBatch['events'] = []; let cursor: string | null = null;
  for (const line of lines.slice(-MAX_JOURNAL)) {
    const entry = JSON.parse(line);
    if (typeof entry.__CURSOR !== 'string' || !/^[a-zA-Z0-9_:;=.-]{1,512}$/.test(entry.__CURSOR)) throw new Error('Invalid journal cursor');
    cursor = entry.__CURSOR;
    const message:string|null=typeof entry.MESSAGE==='string'?entry.MESSAGE:Array.isArray(entry.MESSAGE)&&entry.MESSAGE.length<=8192&&entry.MESSAGE.every((n:unknown)=>Number.isInteger(n)&&Number(n)>=0&&Number(n)<=255)?Buffer.from(entry.MESSAGE).toString('utf8'):null;
    if (message===null) continue;
    const time = Number(entry.__REALTIME_TIMESTAMP) / 1000;
    if (!Number.isFinite(time) || time < 0 || time > Date.now() + 60_000) continue;
    const clean=message.replace(/\x1b\[[0-9;]*m/g,''),trace=clean.match(/\[(\d+) \d+(?:ms|s)\]/)?.[1];
    const scope=`${String(entry._BOOT_ID??'boot')}:${String(entry._SYSTEMD_INVOCATION_ID??'service')}`;
    const traceKey=trace?`${scope}:${trace}`:null;
    context.prune(time);
    const inbound=clean.match(/inbound\/(?:socks|http|tun)\[([\w-]+)\]: inbound connection to ([^\s,]+)(?:\s|$)/);
    const requested=inbound?safeTarget(inbound[2]):null;
    if(traceKey&&inbound){
      context.traces.delete(traceKey);
      if(requested)context.traces.set(traceKey,{...(!isIP(requested.target)?{domain:requested.target.toLowerCase()}:{}),port:requested.port,at:time,addresses:isIP(requested.target)?[requested.target]:[],origin:inbound[1]==='exit-probe'?'exit-check':'traffic'});
    }
    const lookup=clean.match(/dns: lookup succeed for ([a-zA-Z0-9.-]+): ([0-9a-fA-F:. ]+)$/);
    const request=traceKey?context.traces.get(traceKey):undefined;
    if(request&&lookup&&request.domain===lookup[1].toLowerCase()&&time>=request.at)request.addresses=lookup[2].trim().split(/\s+/).filter(ip=>isIP(ip)).slice(0,20);
    const value = parseConnection(message); if (!value) continue;
    if(request&&time>=request.at)value.origin=request.origin;
    if(value.protocol==='DNS'&&value.dnsAddresses){
      for(const ip of value.dnsAddresses){const key=`${scope}:${ip}`,domains=context.dns.get(key)??new Map();
        const domain=value.target.toLowerCase(),expires=time+(value.dnsTtlSeconds??0)*1000;
        domains.set(domain,{at:time,expires});while(domains.size>16)domains.delete(domains.keys().next().value!);context.dns.set(key,domains);}
    } else if(isIP(value.target)) {
      if(request?.domain&&time>=request.at&&request.port===value.port&&request.addresses.includes(value.target)){
        value.domain=request.domain;value.domainSource='connection';
      }else {
        const domains=[...(context.dns.get(`${scope}:${value.target}`)??[])].filter(([,seen])=>seen.at<=time&&seen.expires>=time).map(([domain])=>domain);
        if(domains.length===1){value.domain=domains[0];value.domainSource='dns';}
        else if(domains.length>1)value.domainCandidates=domains.slice(0,5);
      }
    }
    context.prune(time);
    const key=value.protocol==='DNS'&&trace?`${String(entry._BOOT_ID??'boot')}:${trace}:${value.target}:${value.status}`:entry.__CURSOR;
    events.push({key,at:new Date(time).toISOString(),value});
  }
  return { cursor, events, truncated: lines.length >= MAX_JOURNAL || /(?:Suppressed|Missed) \d+ messages/i.test(output) };
}

export function connectionExit(at:string,locked:boolean,approvals:ExitVerificationObservation[],samples:ExitObservation[]):Pick<ConnectionObservation,'exitIp'|'exitCheckedAt'|'exitSource'> {
  const eventTime=Date.parse(at);
  // Records can be persisted out of timestamp order when probes finish later.
  // On a tie, keep an unsuccessful receipt instead of asserting an exit IP.
  const latest=<T extends {at:string;status:string}>(rows:T[],success:string) => rows.reduce<T|undefined>((best,row)=>{
    const time=Date.parse(row.at),bestTime=best?Date.parse(best.at):-Infinity;
    return Number.isFinite(time)&&time<=eventTime&&(time>bestTime||(time===bestTime&&row.status!==success))?row:best;
  },undefined);
  if(locked){
    const receipt=latest(approvals,'verified');
    return receipt?.status==='verified'&&receipt.ip&&eventTime-Date.parse(receipt.at)<=45_000
      ?{exitIp:receipt.ip,exitCheckedAt:receipt.at,exitSource:'verification'}:{};
  }
  const receipt=latest(samples,'success');
  return receipt?.status==='success'&&receipt.ip&&eventTime-Date.parse(receipt.at)<=90_000
    ?{exitIp:receipt.ip,exitCheckedAt:receipt.at,exitSource:'observation'}:{};
}

export class NetworkObserver {
  readonly startedAt = new Date().toISOString();
  private session = randomUUID();
  private cursors = new Map<string,{key:string;cursor:string}>();
  private status = new Map<string,{key:string;generation:number;capture:NetworkObservations['capture'];captureIssue?:string;collectedAt?:string}>();
  private due = new Map<string,number>();
  private configured = new Map<string,string>();
  private contexts = new Map<string,{key:string;generation:number;context:JournalContext}>();
  private sampling = new Map<string,Promise<void>>();
  private writeIssues = new Map<string,{key:string;generation:number;sample:boolean;approval:boolean}>();
  private pending?: Promise<void>;
  private timer: ReturnType<typeof setInterval>|undefined;
  private closed = false;
  private store:Store; private runtime:Pick<LimaRuntime,'management'>;
  private probe:(e:Environment,provider:ProbeProvider)=>Promise<NetworkResult>;
  private available:(e:Environment)=>boolean; private generation:(id:string)=>number;
  private failureCategory?:(error:unknown)=>import('../shared/network-observations.ts').ObservationFailure;
  constructor(store: Store, runtime: Pick<LimaRuntime,'management'>,
    probe: (e:Environment,provider:ProbeProvider)=>Promise<NetworkResult>,
    available:(e:Environment)=>boolean,generation:(id:string)=>number=()=>0,automatic=true,failureCategory?:(error:unknown)=>import('../shared/network-observations.ts').ObservationFailure) {
    this.store=store;this.runtime=runtime;this.probe=probe;this.available=available;this.generation=generation;
    this.failureCategory=failureCategory;
    if(automatic){this.timer=setInterval(()=>{void this.tick().catch(()=>{});},8000);this.timer.unref();}
  }
  private current(e: Environment, generation=this.generation(e.id)) {
    if(this.closed)return false;
    try { const current=this.store.get(e.id);return this.generation(e.id)===generation&&current.state==='running'&&observationKey(current)===observationKey(e)&&this.available(current); } catch{return false;}
  }
  private writeIssue(e:Environment,kind:'sample'|'approval',failed:boolean,generation=this.generation(e.id)){
    const key=observationKey(e),old=this.writeIssues.get(e.id);
    const value=old?.key===key&&old.generation===generation?{...old}:{key,generation,sample:false,approval:false};
    value[kind]=failed;if(value.sample||value.approval)this.writeIssues.set(e.id,value);else this.writeIssues.delete(e.id);
  }
  record(e:Environment,provider:ProbeProvider,result?:NetworkResult,generation=this.generation(e.id),at=new Date().toISOString(),failureReason?:import('../shared/network-observations.ts').ObservationFailure) {
    if(!this.current(e,generation))return;
    if(result&&(!isIP(result.ip)||result.source!=='guest'))throw new Error('Invalid guest receipt');
    if(!Number.isFinite(Date.parse(at))||Date.parse(at)>Date.now()+60_000)throw new Error('Invalid observation time');
    const value:Omit<ExitObservation,'id'>={at,provider,status:result?'success':'failed',
      ...(result?{ip:result.ip,country:result.country.slice(0,120),city:result.city.slice(0,120),latencyMs:result.latencyMs}:failureReason?{failureReason}:{})};
    try{this.store.addNetworkRecord(e.id,'sample',`${this.session}:${observationKey(e)}:${generation}`,randomUUID(),value);}
    catch(error){this.writeIssue(e,'sample',true,generation);throw error;}
  }
  recordVerification(e:Environment,result:EgressStatus) {
    if(this.closed||!result.checkedAt||!['verified','changed','unavailable'].includes(result.status))return;
    if(result.actualIp&&!isIP(result.actualIp))throw new Error('Invalid exit verification IP');
    // Recording is observational: a storage error cannot change the approval policy.
    try {this.store.addNetworkRecord(e.id,'approval',`${this.session}:${observationKey(e)}:${this.generation(e.id)}`,randomUUID(),
      {at:result.checkedAt,status:result.status,...(result.actualIp?{ip:result.actualIp}:{})});this.writeIssue(e,'approval',false);}
    catch {this.writeIssue(e,'approval',true);}
  }
  sample(e:Environment):Promise<void> {
    if(this.sampling.has(e.id))return this.sampling.get(e.id)!;
    if(!this.current(e))return Promise.resolve();
    const generation=this.generation(e.id);
    this.due.set(e.id,Date.now());
    const pending=Promise.allSettled((['ipwho','ipify'] as const).map(async provider=>{
      let result:NetworkResult|undefined,category:import('../shared/network-observations.ts').ObservationFailure|undefined;
      try { result=await this.probe(e,provider); }
      catch(error) {try{category=this.failureCategory?.(error);}catch{/* Diagnostics must not interrupt collection. */}}
      this.record(e,provider,result,generation,undefined,category);
    })).then(results=>{if(this.current(e,generation))this.writeIssue(e,'sample',results.some(result=>result.status==='rejected'),generation);}).finally(()=>{if(this.sampling.get(e.id)===pending)this.sampling.delete(e.id);});
    this.sampling.set(e.id,pending);return pending;
  }
  private async collect(e:Environment) {
    if(!captureSupported(e))return;
    const key=observationKey(e), previous=this.cursors.get(e.id),generation=this.generation(e.id);
    try {
      if(this.configured.get(e.id)!==key) {
        const namespace=(await this.runtime.management(e,['systemctl','show','mucodesandbox-tunnel.service','--property=LogNamespace','--value'],{timeoutMs:6000,maxBytes:1024})).trim();
        if(namespace!==JOURNAL_NAMESPACE)throw new Error('Observation namespace not enabled');
        this.configured.set(e.id,key);
      }
      const args=['sudo','journalctl',`--namespace=${JOURNAL_NAMESPACE}`,'-b','-o','json','--no-pager','-n',String(MAX_JOURNAL)];
      if(previous?.key===key)args.push(`--after-cursor=${previous.cursor}`);
      const output=await this.runtime.management(e,args,{timeoutMs:6000,maxBytes:2_000_000});
      const previousContext=this.contexts.get(e.id);
      const context=previousContext?.key===key&&previousContext.generation===generation?previousContext.context:new JournalContext();
      const batch=parseJournal(output,context);
      if(!this.current(e,generation))return;
      this.contexts.set(e.id,{key,generation,context});
      const sessionKey=`${this.session}:${key}:${generation}`;
      const approvals=this.store.networkRecords(e.id,'approval',sessionKey) as ExitVerificationObservation[];
      const samples=this.store.networkRecords(e.id,'sample',sessionKey) as ExitObservation[];
      this.store.addNetworkRecords(e.id,'connection',key,batch.events.map(entry=>({source:entry.key,
        payload:{...entry.value,at:entry.at,...connectionExit(entry.at,!!e.network.egressLock,approvals,samples)}})));
      if(batch.cursor)this.cursors.set(e.id,{key,cursor:batch.cursor});
      if(batch.truncated)this.store.addNetworkRecord(e.id,'gap',key,`gap:${batch.cursor??randomUUID()}`,{at:new Date().toISOString(),reason:'capacity'});
      this.status.set(e.id,{key,generation,capture:batch.truncated?'error':'ready',collectedAt:new Date().toISOString(),
        ...(batch.truncated?{captureIssue:'连接较多，部分记录可能已超出本次采集范围'}:{})});
    }catch{
      if(this.current(e,generation)) {
        const reportGap=this.status.get(e.id)?.capture!=='error';
        this.status.set(e.id,{key,generation,capture:'error',captureIssue:'连接记录暂不可读取或保存；这不代表没有网络访问；升级后请重新启动环境'});
        // A full or temporarily unwritable database must not hide the failed
        // capture behind its last successful in-memory status.
        if(reportGap)try{this.store.addNetworkRecord(e.id,'gap',key,randomUUID(),{at:new Date().toISOString(),reason:'unavailable'});}catch{/* Keep the explicit in-memory failure when persistence is unavailable. */}
      }
    }
  }
  tick() {
    if(this.closed)return Promise.resolve();if(this.pending)return this.pending;
    const guests=this.store.list().filter(e=>e.kind==='vm'&&e.state==='running'&&this.available(e));
    this.pending=Promise.allSettled(guests.map(async e=>{
      // Ordinary observation probes have their own per-environment in-flight
      // guard and shutdown wait. A slow probe must not hold the journal queue.
      // This does not change Manager's independent quorum/lease protection.
      if(Date.now()-(this.due.get(e.id)??0)>=30_000)void this.sample(e).catch(()=>{});
      await this.collect(e);
    })).then(()=>{}).finally(()=>{this.pending=undefined;});return this.pending;
  }
  info(e:Environment,query?:ConnectionQuery):NetworkObservations {
    const key=observationKey(e);
    const currentSamples=this.store.networkRecords(e.id,'sample',`${this.session}:${key}:${this.generation(e.id)}`) as ExitObservation[];
    const samples=this.store.networkSampleHistory(e.id,key) as ExitObservation[];
    const paged=query?this.store.networkConnectionPage(e.id,key,query):undefined;
    const connections=paged?.connections??this.store.networkRecords(e.id,'connection',key) as ConnectionObservation[];
    const candidate=captureSupported(e)?this.status.get(e.id):undefined;
    const state=candidate?.key===key&&candidate.generation===this.generation(e.id)?candidate:undefined;
    const issue=this.writeIssues.get(e.id),storageIssue=issue?.key===key&&issue.generation===this.generation(e.id);
    return {enabled:e.kind==='vm'&&e.state==='running',environmentState:e.state,capture:captureSupported(e)?state?.capture??'waiting':'unsupported',
      ...(state?{capture:state.capture,captureIssue:state.captureIssue,collectedAt:state.collectedAt}:{}),
      ...(storageIssue?{storageIssue:'部分出口检测或核验回执暂不可保存，历史记录可能不完整；联网防护独立运行。'}:{}),
      captureGaps:this.store.networkRecords(e.id,'gap',key).length,startedAt:this.startedAt,sampleIntervalSeconds:30,lockIp:e.network.egressLock?.expectedIp??null,
      samples,connections,...(paged?{connectionPage:paged.connectionPage}:{}),summary:exitSummary(e.state==='running'?currentSamples:samples)};
  }
  async close(){this.closed=true;clearInterval(this.timer);await this.pending;await Promise.allSettled(this.sampling.values());}
  forget(id:string){this.cursors.delete(id);this.status.delete(id);this.due.delete(id);this.configured.delete(id);this.contexts.delete(id);this.writeIssues.delete(id);}
}
