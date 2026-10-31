import { isIPv4 } from 'node:net';
import { z } from 'zod';
import type { Environment, NetworkResult, EgressVerification,EgressCheck } from '../shared/types.ts';
import type { LimaRuntime } from './runtime.ts';
import type { RunOptions } from './process.ts';
import { AppError, SshProcessError, errorMessage } from './errors.ts';

export const EGRESS_URL = 'https://ipwho.is/';
// This includes starting the bounded command through Lima / SSH. The HTTPS
// receiver gets 12s (and connect 8s), independently of transport setup. This
// remains below the 45s kernel lease; an IP mismatch still rejects immediately.
export const EGRESS_TIMEOUT_MS = 24_000;
export const EGRESS_RECEIVERS = [
  { receiver: 'ipwho', url: EGRESS_URL },
  { receiver: 'ipify', url: 'https://api.ipify.org/?format=json' },
  { receiver: 'icanhazip', url: 'https://ipv4.icanhazip.com/' },
] as const;
const diagnosticMarker='MU_EGRESS_DIAGNOSTICS=';
const diagnosticFormat='\n'+diagnosticMarker+'{"curlExitCode":"%{exitcode}","httpStatus":"%{http_code}","tcp":"%{time_connect}","tls":"%{time_appconnect}","firstByte":"%{time_starttransfer}","total":"%{time_total}"}\n';
const timingValue=z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number).pipe(z.number().min(0).max(120));
const probeDiagnostic=z.object({
 curlExitCode:z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(255)),
 httpStatus:z.string().regex(/^\d{3}$/).transform(Number).pipe(z.number().int().refine(value=>value===0||value>=100&&value<=599)),
 tcp:timingValue,tls:timingValue,firstByte:timingValue,total:timingValue,
});
export function parseEgressProbeOutput(output:string):{body:string;diagnostics?:EgressCheck['diagnostics']}{
 const index=output.lastIndexOf(diagnosticMarker);
 if(index<0||index>0&&output[index-1]!=='\n')return {body:output};
 const raw=output.slice(index+diagnosticMarker.length).split('\n')[0];
 if(raw.length>1024)throw new Error('Invalid probe diagnostics');
 const value=probeDiagnostic.parse(JSON.parse(raw));
 // Zero also means curl never reached this stage. Preserve any completed
 // sub-millisecond stage so it cannot be mistaken for an unstarted handshake.
 const ms=(seconds:number)=>Math.ceil(seconds*1000);
 return {body:output.slice(0,index),diagnostics:{curlExitCode:value.curlExitCode,httpStatus:value.httpStatus,
  tcpConnectMs:ms(value.tcp),tlsHandshakeMs:ms(value.tls),firstByteMs:ms(value.firstByte),totalMs:ms(value.total)}};
}
export class EgressMismatchError extends Error {
  readonly actualIp: string;
  readonly checks:EgressCheck[];
  constructor(actualIp: string,checks:EgressCheck[]=[]) { super(`出口回执不一致：检测到 ${actualIp}`); this.name='EgressMismatchError'; this.actualIp=actualIp;this.checks=structuredClone(checks); }
}
export class EgressMeasurementError extends AppError {
 readonly checks:EgressCheck[];
 constructor(message:string,code:string,checks:EgressCheck[]){super(message,409,code);this.checks=structuredClone(checks);}
}
const failureChecks=new WeakMap<Error,EgressCheck[]>();
export function egressErrorChecks(error:unknown):EgressCheck[]{
 if(error instanceof EgressMismatchError||error instanceof EgressMeasurementError)return structuredClone(error.checks);
 return error instanceof Error?structuredClone(failureChecks.get(error)??[]):[];
}
export function checkFailure(error:unknown):EgressCheck['status']{
 const message=errorMessage(error);
 if(error instanceof AppError&&error.code==='CANCELLED')return 'cancelled';
 if(error instanceof AppError&&error.code==='TIMEOUT')return 'command-timeout';
 if(error instanceof SshProcessError&&error.exitStatus===255)return 'connection-error';
 // Windows OpenSSH can exit 255 without stderr. This is a failed management
 // command, not evidence that a receiver returned an invalid IP response.
 if(error instanceof AppError&&error.code==='PROCESS_FAILED'&&message==='SSH 任务失败（255）')return 'connection-error';
 if(error instanceof SshProcessError&&error.exitStatus!==28&&/\bcurl:\s*\(28\)/.test(message))return error.exitStatus===255?'connection-error':'invalid-response';
 if(/curl:\s*\(28\)/.test(message))return 'timeout';
 if(/curl:\s*\((35|60)\)/.test(message))return 'tls-error';
 if(/407|(?:SOCKS|proxy).*auth|authentication/i.test(message))return 'auth-error';
 if(/curl:\s*\((5|6)\)/.test(message))return 'dns-error';
 if(/curl:\s*\((7|52|56|97)\)/.test(message))return 'connection-error';
 return 'invalid-response';
}
const receipt = z.object({
  success: z.boolean().optional(), ip: z.string().refine(isIPv4),
  country: z.string().max(256).optional(), city: z.string().max(256).optional(),
}).refine(value => value.success !== false, 'Exit measurement failed');

export function parseEgress(output: string) {
  if (Buffer.byteLength(output) > 65_536) throw new Error('Exit measurement is too large');
  return receipt.parse(JSON.parse(output));
}

export async function measureEgress(runtime: Pick<LimaRuntime, 'management' | 'egressProbeProxy'>, e: Environment, options: RunOptions = {}): Promise<NetworkResult> {
  const started = performance.now();
  const dns = e.network.dns ?? { address:'1.1.1.1',serverName:'cloudflare-dns.com',port:443,path:'/dns-query' };
  const proxy = runtime.egressProbeProxy(e);
  const resolution = proxy ? [] : ['--doh-url',`https://${dns.serverName}:${dns.port}${dns.path}`,'--resolve',`${dns.serverName}:${dns.port}:${dns.address}`];
  const controller=new AbortController();
  const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
  let rejectCritical!: (error: unknown)=>void, observedIp: string|undefined;
  const critical=new Promise<never>((_,reject)=>{rejectCritical=reject;});
  const checks:EgressCheck[]=EGRESS_RECEIVERS.map(target=>({receiver:target.receiver,status:'pending'}));
  // Every receiver uses the same restricted identity, DNS and sole upstream.
  const tasks=EGRESS_RECEIVERS.map(async (target,index)=>{
    const probeStarted=performance.now();
    let diagnostics:EgressCheck['diagnostics'];
    // Windows SSH keeps stdout out of a failed command's stderr summary.
    // curl writes --write-out to stdout even when it exits nonzero. Retain a
    // bounded stream tail locally; only validated numeric stages enter checks.
    let probeOutput='';
    try {
      const output = await runtime.management(e, ['/usr/bin/sudo', '-H', '-u', 'mu-probe', '--', 'env', '-i', 'PATH=/usr/bin:/bin', '/usr/bin/curl', '-q',
    '--ipv4', '--fail', '--silent', '--show-error', '--proto', '=https', '--tlsv1.2',
    '--max-time', '12', '--connect-timeout', '8', '--max-filesize', '65536',
    '--proxy', proxy, '--noproxy', proxy ? '' : '*', '--cacert', '/etc/ssl/certs/ca-certificates.crt',
        ...resolution,'--write-out',diagnosticFormat,target.url],
      { ...options, signal, timeoutMs: EGRESS_TIMEOUT_MS,onOutput:text=>{
        probeOutput=(probeOutput+text).slice(-8192);options.onOutput?.(text);
      } });
      const parsed=parseEgressProbeOutput(output);diagnostics=parsed.diagnostics;
      const result=target.receiver==='icanhazip'?parseEgress(JSON.stringify({ip:parsed.body.trim()})):parseEgress(parsed.body);
      checks[index]={receiver:target.receiver,status:'success',ip:result.ip,latencyMs:Math.round(performance.now()-probeStarted),...(diagnostics?{diagnostics}:{})};
      if(e.network.egressLock&&result.ip!==e.network.egressLock.expectedIp||observedIp&&result.ip!==observedIp)
        throw new EgressMismatchError(result.ip,checks);
      observedIp??=result.ip;
      return {receiver:target.receiver,result,latencyMs:Math.round(performance.now()-probeStarted)};
    } catch(error) {
      for(const output of [errorMessage(error),probeOutput]){
        if(diagnostics)break;
        try{diagnostics=parseEgressProbeOutput(output).diagnostics;}catch{/* A failed diagnostic cannot replace the original failure. */}
      }
      const sshExitStatus=error instanceof SshProcessError?error.exitStatus:null;
      if(!(error instanceof EgressMismatchError))checks[index]={receiver:target.receiver,status:checkFailure(error),latencyMs:Math.round(performance.now()-probeStarted),...(sshExitStatus!==null&&Number.isInteger(sshExitStatus)&&sshExitStatus>=0&&sshExitStatus<=255?{sshExitStatus}:{}),...(diagnostics?{diagnostics}:{})};
      // Only a clearly bounded timeout may be covered by two other fresh receipts.
      // Windows SSH preserves the actual remote exit status. Do not accept a
      // timeout-looking message when that status says the command failed for
      // some other reason; arbitrary error text is not a timeout receipt.
      const timedOut=error instanceof AppError&&error.code==='TIMEOUT'||(error instanceof SshProcessError?error.exitStatus===28&&/\bcurl:\s*\(28\)/.test(errorMessage(error)):/\bcurl:\s*\(28\)/.test(errorMessage(error)));
      if(!timedOut)rejectCritical(error);
      throw error;
    }finally{probeOutput='';}
  });
  try {
    const outcomes=await Promise.race([Promise.allSettled(tasks),critical]);
    const successful=outcomes.flatMap(value=>value.status==='fulfilled'?[value.value]:[]);
    if(successful.length<2){
      const detail=outcomes.map((value,index)=>`${EGRESS_RECEIVERS[index].receiver}：${value.status==='fulfilled'?'已取得':'超时'}`).join('；');
      throw new AppError(`不足两个独立出口回执（${detail}），联网保持关闭`,409,'EGRESS_UNAVAILABLE');
    }
    const best=successful.find(value=>value.receiver==='ipwho')??successful[0];
    const verification:EgressVerification={requiredReceivers:2,receipts:successful.map(value=>({receiver:value.receiver,ip:value.result.ip,latencyMs:value.latencyMs,...(value.result.country?{country:value.result.country}:{}),...(value.result.city?{city:value.result.city}:{})})),
      timedOutReceivers:EGRESS_RECEIVERS.filter((_,index)=>outcomes[index].status==='rejected').map(value=>value.receiver)};
    return {ip:best.result.ip,country:best.result.country??'',city:best.result.city??'',latencyMs:Math.round(performance.now()-started),source:'guest',verification};
  } catch(error){
    if(error instanceof EgressMismatchError)throw error;
    if(error instanceof EgressMeasurementError)throw error;
    // Retain the original TLS / authentication / DNS error identity and code.
    // A private map attaches evidence without mutating third-party errors.
    if(error instanceof Error&&!(error instanceof AppError&&error.code==='EGRESS_UNAVAILABLE')){failureChecks.set(error,structuredClone(checks));throw error;}
    const failures=checks.filter(c=>c.status!=='pending'&&c.status!=='success');
    const names=failures.map(c=>`${c.receiver}：${c.status}`).join('；');
    const message=error instanceof AppError&&error.code==='EGRESS_UNAVAILABLE'?error.message:`出口核验未完成（${names||'未取得有效回执'}），联网保持关闭`;
    throw new EgressMeasurementError(message,error instanceof AppError?error.code:'EGRESS_PROBE_FAILED',checks);
  } finally { controller.abort(); }
}
