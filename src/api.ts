import type { Environment, Snapshot, Job, LogEntry, AgentStatus, Metrics, NetworkResult, NetworkProtection, BrowserInspection, BrowserVersionStatus, LabInfo, LocalCheckReport, EnvironmentSnapshot, BridgeGrant, EgressStatus, HostCommand } from '../shared/types.ts';
import type { ConnectionQuery,NetworkObservations } from '../shared/network-observations.ts';
import type { DisplayRequest, GuestDisplay } from '../shared/guest-display.ts';
import type { DesktopAppId,DesktopAppsStatus } from '../shared/guest-desktop.ts';
import type {WindowsDesktopComponentsStatus} from '../shared/windows-desktop-components.ts';
import type {WindowsDesktopClientsState} from '../shared/windows-desktop-clients.ts';
import type {AccessLatency,LatencyTarget} from '../shared/latency.ts';
import type {ProtectionEvent} from '../shared/protection-events.ts';

declare global {
  interface Window {
    __MU_CONFIG__: { token: string; version: string; platform?: 'win32'; windowsMode?:'normal'|'recovery'; capabilities?:{desktopClients?:boolean;desktopComponents?:boolean;agent?:boolean;networkObservations?:boolean;snapshots?:boolean;snapshotRecovery?:boolean;backups?:boolean;terminal:boolean;files:boolean;fileDirectories?:boolean;fileManager?:boolean;independentFileView?:boolean;browser?:boolean;browserDetails?:boolean;browserStartup?:boolean;browserReset?:boolean;browserRepair?:boolean;localChecks?:boolean;audio?:boolean;imageClipboard?:boolean;translation?:boolean;diskGrowth?:boolean;diskCompaction?:boolean;remove?:boolean;setup?:boolean;hostSetup?:boolean;storage?:boolean} };
    muWindowsDesktop?: {openHostLab?:(value:import('../shared/windows-host-lab.ts').WindowsHostLabWindow)=>Promise<{opened:true;runId:string}>;closeHostLab?:(runId:string)=>Promise<{closed:true}>;chooseBackupFile?:(action:'export'|'restore')=>Promise<string|null>;readClipboardImage:()=>Promise<import('../shared/clipboard-image.ts').ClipboardImage>;writeClipboardImage?:(data:Uint8Array)=>Promise<{ok:boolean;width:number;height:number}>;readClipboardText?:()=>Promise<string>;writeClipboardText?:(text:string)=>Promise<unknown>;setViewerFullscreen?:(value:boolean)=>Promise<boolean>;onViewerFullscreenChange?:(listener:(value:boolean)=>void)=>()=>void};
    muDesktop?: { readClipboardImage?:()=>Promise<import('../shared/clipboard-image.ts').ClipboardImage>; onGuestApplication?:(callback:(value:{id:string;target:'browser'|'desktop';application?:string})=>void)=>()=>void; browserAction(input: { id: string; action: string; url?: string }): Promise<void>; onBrowserState(callback: (state: BrowserState) => void): () => void };
  }
}
export interface BrowserState { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
export interface GuestBrowserState { running: boolean; ready: boolean; preparing?:boolean; width: number; height: number; platform: 'Linux'; display?:GuestDisplay }

export class ApiError extends Error { readonly status:number;readonly code:string;constructor(message:string,status:number,code:string){super(message);this.status=status;this.code=code;} }

export async function request<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${endpoint}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.__MU_CONFIG__?.token ?? ''}`, ...init.headers } });
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.error ?? '请求失败',response.status,result.code??'REQUEST_FAILED');
  return result as T;
}
export const api = {
  protectionEvents:(id:string,signal?:AbortSignal)=>request<ProtectionEvent[]>(`/environments/${id}/protection-events`,{signal}),
  retryProtection:(id:string)=>request<Job>(`/environments/${id}/protection-events/retry`,{method:'POST',body:'{}'}),
  focusGuest:(id:string,target:'browser'|'grok-bot'|'claude-desktop')=>request<{focused:boolean;pending:boolean}>(`/environments/${id}/guest-focus`,{method:'POST',body:JSON.stringify({target})}),
  snapshot: () => request<Snapshot>('/snapshot'),
  desktopApps:(id:string)=>request<DesktopAppsStatus>(`/environments/${id}/desktop-apps`),
  windowsDesktopComponents:(id:string)=>request<WindowsDesktopComponentsStatus>(`/environments/${id}/desktop-components`),
  windowsDesktopClients:(id:string)=>request<WindowsDesktopClientsState>(`/environments/${id}/desktop-clients`),
  focusWindowsDesktopClient:(id:string,application:DesktopAppId,viewId:string,signal?:AbortSignal)=>request<{focused:boolean}>(`/environments/${id}/desktop-clients/${application}/focus`,{method:'POST',body:JSON.stringify({viewId}),signal}),
  startWindowsDesktopClient:(id:string,application:DesktopAppId,environmentName:string)=>request<Job>(`/environments/${id}/desktop-clients/${application}/start`,{method:'POST',body:JSON.stringify({confirm:'start-approved-desktop',environmentName})}),
  stopWindowsDesktopClient:(id:string,application:DesktopAppId,viewId:string)=>request<Job>(`/environments/${id}/desktop-clients/${application}/stop`,{method:'POST',body:JSON.stringify({viewId})}),
  windowsDesktopClientTicket:(id:string,application:DesktopAppId,viewId:string)=>request<{ticket:string;password:string}>(`/environments/${id}/desktop-clients/${application}/view-ticket`,{method:'POST',body:JSON.stringify({viewId})}),
  windowsDesktopClientView:(id:string,application:DesktopAppId,viewId:string)=>request<{ready:true;display?:GuestDisplay}>(`/environments/${id}/desktop-clients/${application}/view?viewId=${encodeURIComponent(viewId)}`),
  resizeWindowsDesktopClientView:(id:string,application:DesktopAppId,viewId:string,display:DisplayRequest)=>request<GuestDisplay>(`/environments/${id}/desktop-clients/${application}/display`,{method:'POST',body:JSON.stringify({viewId,display})}),
  installWindowsDesktopComponent:(id:string,application:DesktopAppId,environmentName:string)=>request<Job>(`/environments/${id}/desktop-components/${application}/install`,{method:'POST',body:JSON.stringify({confirm:'install-approved-desktop',environmentName})}),
  desktopAppAction:(id:string,application:DesktopAppId,action:'install'|'start'|'stop')=>request<Job>(`/environments/${id}/desktop-apps/${application}/${action}`,{method:'POST',body:'{}'}),
  cleanRebuild:(id:string)=>request<{job:Job;replacementEnvironmentId:string}>(`/environments/${id}/rebuild-clean`,{method:'POST',body:JSON.stringify({confirm:'erase-entire-environment'})}),
  networkObservations:(id:string,query?:ConnectionQuery,signal?:AbortSignal)=>{const params=new URLSearchParams();if(query){params.set('scope',query.scope??'traffic');if(query.q)params.set('q',query.q);if(query.failures)params.set('failures','1');if(query.before!==undefined)params.set('before',String(query.before));}return request<NetworkObservations>(`/environments/${id}/network/observations${params.size?'?'+params:''}`,{signal});},
  sampleNetwork:(id:string)=>request<NetworkObservations>(`/environments/${id}/network/observations`,{method:'POST',body:'{}'}),
  bridgeGrants: (id:string) => request<BridgeGrant[]>(`/environments/${id}/bridge`),
  grantBridge: (id:string,root:string,writable:boolean,minutes:number,commands:HostCommand[]=[]) => request<Job>(`/environments/${id}/bridge`,{method:'POST',body:JSON.stringify({root,writable,minutes,commands})}),
  revokeBridge: (id:string,grantId:string) => request<Job>(`/environments/${id}/bridge/${grantId}`,{method:'DELETE'}),
  snapshots: (id: string) => request<EnvironmentSnapshot[]>(`/environments/${id}/snapshots`),
  createSnapshot: (id: string, name: string) => request<Job>(`/environments/${id}/snapshots`, { method: 'POST', body: JSON.stringify({ name }) }),
  restoreSnapshot: (id: string, snapshotId: string) => request<Job>(`/environments/${id}/snapshots/${snapshotId}/restore`, { method: 'POST' }),
  deleteSnapshot: (id: string, snapshotId: string) => request(`/environments/${id}/snapshots/${snapshotId}`, { method: 'DELETE' }),
  exportBackup: (id: string, snapshotId: string, path: string, password: string) => request<Job>(`/environments/${id}/snapshots/${snapshotId}/export`, { method: 'POST', body: JSON.stringify({ path, password }) }),
  importBackup: (path: string, password: string, name: string) => request<Job>('/backups/import', { method: 'POST', body: JSON.stringify({ path, password, name }) }),
  pickBackup: (mode: 'open' | 'save') => request<{ path: string | null }>('/backups/pick', { method: 'POST', body: JSON.stringify({ mode }) }),
  lab: () => request<LabInfo>('/lab'),
  localChecks: () => request<LocalCheckReport[]>('/lab/checks'),
  checkEnvironment: (id:string) => request<Job>(`/environments/${id}/lab/check`,{method:'POST'}),
  localProxy: () => request<{available:boolean;nodes:{name:string;type:string}[];ports:{port:number;ready:boolean}[];line:{name:string;port:number;running:boolean}|null;error?:string}>('/local-proxy'),
  startLocalLine: (name:string) => request<{name:string;port:number}>('/local-proxy/line',{method:'POST',body:JSON.stringify({name})}),
  startLab: () => request<LabInfo>('/lab/start', { method: 'POST' }),
  stopLab: () => request<LabInfo>('/lab/stop', { method: 'POST' }),
  labReceipts: () => request<{receipts: {id:string;result:unknown}[];events:unknown[]}>('/lab/receipts'),
  create: (input: unknown) => request<Environment>('/environments', { method: 'POST', body: JSON.stringify(input) }),
  update: (id: string, input: unknown) => request<Environment>(`/environments/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  diskStatus: (id: string) => request<{ pending: boolean; targetGiB: number | null }>(`/environments/${id}/disk`),
  growDisk: (id: string, diskGiB: number) => request<Job>(`/environments/${id}/disk`, { method: 'POST', body: JSON.stringify({ diskGiB }) }),
  action: (id: string, action: string) => request<Job>(`/environments/${id}/actions/${action}`, { method: 'POST' }),
  browser: (id: string, action: 'open' | 'close', showWindow=true) => request<Job | { ok: boolean }>(`/environments/${id}/browser/${action}`, { method: 'POST', ...(action==='open'?{body:JSON.stringify({showWindow})}:{}) }),
  browserVersion: (id: string) => request<BrowserVersionStatus>(`/environments/${id}/browser/version`),
  maintainBrowser: (id: string, action: 'update' | 'recover') => request<Job>(`/environments/${id}/browser/${action}`, { method: 'POST' }),
  resetBrowser: (id: string) => request<Job>(`/environments/${id}/browser/reset`, { method: 'POST', body: JSON.stringify({ confirm: 'erase-browser-profile' }) }),
  guestBrowser: (id: string) => request<GuestBrowserState>(`/environments/${id}/guest-browser`),
  resizeGuestDisplay:(id:string,input:DisplayRequest)=>request<GuestDisplay>(`/environments/${id}/guest-browser/display`,{method:'POST',body:JSON.stringify(input)}),
  guestBrowserTicket: (id: string) => request<{ ticket: string; password: string }>(`/environments/${id}/guest-browser-ticket`, { method: 'POST' }),
  logs: (id?: string, after = 0) => request<LogEntry[]>(`/logs?after=${after}${id ? `&environmentId=${id}` : ''}`),
  metrics: (id: string) => request<Metrics>(`/environments/${id}/metrics`),
  agent: (id: string) => request<AgentStatus>(`/environments/${id}/agent`),
  testNetwork: (id: string) => request<NetworkResult>(`/environments/${id}/network/test`, { method: 'POST' }),
  accessLatency:(id:string)=>request<AccessLatency|null>(`/environments/${id}/network/latency`),
  testAccessLatency:(id:string,target:LatencyTarget='google')=>request<AccessLatency>(`/environments/${id}/network/latency`,{method:'POST',body:JSON.stringify({target})}),
  egress: (id: string, signal?:AbortSignal) => request<EgressStatus>(`/environments/${id}/network/egress`,{signal}),
  protection: (id: string, signal?:AbortSignal) => request<NetworkProtection>(`/environments/${id}/network/protection`,{signal}),
  inspectBrowser: (id: string) => request<BrowserInspection>(`/environments/${id}/browser/inspect`),
  installRuntime: () => request<Job>('/runtime/install', { method: 'POST' }),
  cancel: (id: string) => request(`/jobs/${id}/cancel`, { method: 'POST' }),
  pickDirectory: () => request<{ path: string | null }>('/directories/pick', { method: 'POST' }),
  terminalTicket: (id: string, command: 'shell' | 'claude', cols: number, rows: number,signal?:AbortSignal) => request<{ ticket: string }>(`/environments/${id}/terminal-ticket`, { method: 'POST', body: JSON.stringify({ command, cols, rows }),signal }),
};

export function editConfig(e: Environment) {
  const wireguard = e.network.wireguard ? { address: e.network.wireguard.address, peerPublicKey: e.network.wireguard.peerPublicKey, listenPort: e.network.wireguard.listenPort, mtu: e.network.wireguard.mtu } : undefined;
  return { name: e.name, description: e.description, kind: e.kind, color: e.color, cpus: e.cpus, memoryGiB: e.memoryGiB, diskGiB: e.diskGiB, mounts: e.mounts, ports: e.ports, identity: e.identity, network: { mode: e.network.mode, host: e.network.host, port: e.network.port, username: e.network.username, noProxy: e.network.noProxy, strict: e.network.strict, transparent: Boolean(e.network.transparent), tls: e.network.tls, dns: e.network.dns, egressLock: e.network.egressLock, wireguard }, browserUrl: e.browserUrl };
}
