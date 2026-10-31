import {z} from 'zod';
import type {Metrics} from '../../../shared/types.ts';
import type {HyperVRuntime} from './runtime.ts';
import type {WindowsManager} from './manager.ts';
import {AppError} from '../../errors.ts';
import {WINDOWS_BROWSER_VERSION_SCRIPT,parseWindowsBrowserVersion} from './browser-installation.ts';
import {WINDOWS_BROWSER_PROFILE_INSPECT,parseWindowsBrowserProfile} from './browser-profile.ts';
export const WINDOWS_BROWSER_OBSERVATION_SCRIPT=WINDOWS_BROWSER_VERSION_SCRIPT+'\n'+WINDOWS_BROWSER_PROFILE_INSPECT;
export {parseWindowsBrowserVersion} from './browser-installation.ts';
import {measureAccessLatency} from '../../latency.ts';
import type {AccessLatency,LatencyTarget} from '../../../shared/latency.ts';

// Fixed read-only guest observations. Never substitute host resource readings.
export const WINDOWS_METRICS_SCRIPT=`import json,os,time
def cpu():
 v=list(map(int,open('/proc/stat').readline().split()[1:9]));return sum(v),v[3]+v[4]
a=cpu();time.sleep(.2);b=cpu();total=b[0]-a[0];idle=b[1]-a[1]
m={line.split(':')[0]:int(line.split()[1]) for line in open('/proc/meminfo')}
d=os.statvfs('/');size=d.f_blocks*d.f_frsize;used=(d.f_blocks-d.f_bfree)*d.f_frsize
print(json.dumps(dict(cpuPercent=100*(total-idle)/total if total>0 else 0,memoryUsedMiB=(m['MemTotal']-m['MemAvailable'])/1024,memoryTotalMiB=m['MemTotal']/1024,diskUsedGiB=used/1073741824,diskTotalGiB=size/1073741824,uptimeSeconds=float(open('/proc/uptime').read().split()[0]))))
`;
const nonnegative=z.number().finite().nonnegative();
const metricsSchema=z.object({cpuPercent:nonnegative.max(100),memoryUsedMiB:nonnegative,memoryTotalMiB:nonnegative.positive(),diskUsedGiB:nonnegative,diskTotalGiB:nonnegative.positive(),uptimeSeconds:nonnegative}).strict().refine(v=>v.memoryUsedMiB<=v.memoryTotalMiB&&v.diskUsedGiB<=v.diskTotalGiB);
export function parseWindowsMetrics(source:string):Metrics{return metricsSchema.parse(JSON.parse(source));}
export class WindowsOverviewReadings{
 private manager:Pick<WindowsManager,'assertAccess'|'sessions'|'profile'>;
 private guest:HyperVRuntime['guest'];
 private latencyReports=new Map<string,{session:unknown;report:AccessLatency}>();
 private measuring=new Set<string>();
 constructor(manager:Pick<WindowsManager,'assertAccess'|'sessions'|'profile'>,guest:HyperVRuntime['guest']){this.manager=manager;this.guest=guest;}
 private async read(id:string,command:string[],input?:string,timeoutMs=8000){
  const environment=await this.manager.assertAccess(id),session=this.manager.sessions.get(id);
  const assertCurrent=()=>{if(!session||session.state!=='active'||this.manager.sessions.get(id)!==session)throw new AppError('环境已变化，请重新读取状态',409,'CONFIGURATION_CHANGED');};
  assertCurrent();const config=await this.manager.profile(environment);assertCurrent();
  const result=await this.guest(config,command,{input,timeoutMs,maxBytes:16384});
  assertCurrent();await this.manager.assertAccess(id);assertCurrent();return result;
 }
 async metrics(id:string){return parseWindowsMetrics(await this.read(id,['python3','-c',WINDOWS_METRICS_SCRIPT]));}
 async browserVersion(id:string){const lines=(await this.read(id,['/usr/bin/python3','-I','-c',WINDOWS_BROWSER_OBSERVATION_SCRIPT],undefined,20000)).trim().split(/\r?\n/);if(lines.length!==2)throw new AppError('浏览器版本与资料回执无法对应，请重新检测',502,'BROWSER_PROFILE_RECEIPT');const installed=parseWindowsBrowserVersion(lines[0]),profileCompatibility=parseWindowsBrowserProfile(lines[1]);if(installed.selectedVersion!==profileCompatibility.selectedVersion)throw new AppError('浏览器版本选择在读取期间变化，请重新检测',409,'BROWSER_SELECTION_CHANGED');return {...installed,profileCompatibility};}
 async latency(id:string){await this.manager.assertAccess(id);const saved=this.latencyReports.get(id);return saved?.session===this.manager.sessions.get(id)?saved?.report??null:null;}
 async measureLatency(id:string,target:LatencyTarget){
  if(this.measuring.has(id))throw new AppError('线路延迟检测正在进行',409,'LATENCY_BUSY');
  this.measuring.add(id);
  try{
   const environment=await this.manager.assertAccess(id),session=this.manager.sessions.get(id);
   const report=await measureAccessLatency({guest:async(_environment,command,options={})=>this.read(id,command,undefined,options.timeoutMs??12000)},environment,target);
   await this.manager.assertAccess(id);
   if(!session||session.state!=='active'||this.manager.sessions.get(id)!==session)throw new AppError('环境已变化，请重新检测线路',409,'CONFIGURATION_CHANGED');
   this.latencyReports.set(id,{session,report});return report;
  }finally{this.measuring.delete(id);}
 }
}
