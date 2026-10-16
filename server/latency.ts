import {z} from 'zod';
import type {Environment} from '../shared/types.ts';
import {LATENCY_TARGETS,type AccessLatency,type LatencySample,type LatencyTarget} from '../shared/latency.ts';
import type {LimaRuntime} from './runtime.ts';
import type {RunOptions} from './process.ts';
import {AppError,errorMessage} from './errors.ts';

export const latencyInput=z.object({target:z.enum(['google','cloudflare']).default('google')}).strict();
const timingSchema=z.object({httpCode:z.string().regex(/^2\d\d$/),firstByte:z.number().finite().positive().max(8),total:z.number().finite().positive().max(8.1)}).strict()
  .refine(value=>value.total+.001>=value.firstByte,'Timing order is invalid');
export const LATENCY_WRITE_OUT='{"httpCode":"%{http_code}","firstByte":%{time_starttransfer},"total":%{time_total},"connections":%{num_connects}}\n';

export function parseLatencyTiming(output:string):{ok:true;firstByteMs:number;totalMs:number;httpStatus:number}{
  if(Buffer.byteLength(output)>1024)throw new Error('计时回执过大');
  const value=timingSchema.parse(JSON.parse(output));
  return {ok:true,firstByteMs:Math.round(value.firstByte*1000),totalMs:Math.round(value.total*1000),httpStatus:Number(value.httpCode)};
}
export function parseUnifiedLatency(output:string):Extract<LatencySample,{ok:true}>{
  if(Buffer.byteLength(output)>2048)throw new Error('计时回执过大');
  const lines=output.trim().split('\n');if(lines.length!==2)throw new Error('统一延迟需要建连与复用两次回执');
  const raw=lines.map(line=>JSON.parse(line));
  const timing=raw.map(({connections,...value})=>{if(connections!==0&&connections!==1)throw new Error('连接计数无效');return parseLatencyTiming(JSON.stringify(value));});
  if(raw[1].connections!==0)throw new AppError('测试连接未能复用，统一延迟不可用',502,'CONNECTION_NOT_REUSED');
  return {...timing[0],lineDelayMs:Math.max(1,Math.floor(raw[1].total*1000)),httpStatus:timing[1].httpStatus,reusedConnection:true};
}
export function summarizeLatency(target:LatencyTarget,samples:LatencySample[]):AccessLatency{
  const times=samples.flatMap(s=>s.ok?[s.lineDelayMs]:[]).sort((a,b)=>a-b),first=samples.flatMap(s=>s.ok?[s.firstByteMs]:[]).sort((a,b)=>a-b);
  const median=(values:number[])=>{const i=Math.floor(values.length/2);return values.length?Math.round(values.length%2?values[i]:(values[i-1]+values[i])/2):null;};
  return {target,checkedAt:new Date().toISOString(),source:'guest',metric:'http-url-test-unified',samples,successfulSamples:times.length,
    medianMs:median(times),firstResponseMedianMs:median(first),minMs:times.length?times[0]:null,maxMs:times.length?times.at(-1)!:null};
}
function failureIssue(error:unknown){
  const message=errorMessage(error);
  if(error instanceof AppError&&error.code==='CONNECTION_NOT_REUSED')return error.message;
  if(error instanceof AppError&&error.code==='TIMEOUT')return '沙箱检测超时，未取得响应';
  if(/curl: \(28\)/.test(message))return '连接或响应超时';
  if(/curl: \((5|6)\)/.test(message))return '域名解析失败';
  if(/curl: \(7\)/.test(message))return '无法建立连接';
  if(/curl: \((35|60)\)/.test(message))return 'HTTPS 安全连接验证失败';
  if(/curl: \(22\)/.test(message))return '测试站点返回错误状态';
  return '未取得有效响应；线路或测试站点可能暂时不可用';
}
export async function measureAccessLatency(runtime:LimaRuntime,e:Environment,target:LatencyTarget,options:RunOptions={}):Promise<AccessLatency>{
  const endpoint=LATENCY_TARGETS.find(value=>value.id===target);
  if(!endpoint)throw new AppError('不支持的延迟检测站点',400);
  const samples:LatencySample[]=[];
  for(let i=0;i<3;i++){
    if(options.signal?.aborted)throw new AppError('延迟检测已取消',409,'CANCELLED');
    try{
      // Mihomo unified-delay model: HEAD warms the connection, then the second
      // HEAD measures the same connection. Require proof of reuse; never mix a
      // new-connection/page timing into the line-delay result.
      const output=await runtime.guest(e,['/usr/bin/curl','-q','--head','--http1.1','--ipv4','--fail','--silent','--show-error','--proto','=https',
        '--cacert','/etc/ssl/certs/ca-certificates.crt','--noproxy','','--max-time','4','--connect-timeout','3',
        '--max-filesize','8192','--write-out',LATENCY_WRITE_OUT,'--output','/dev/null',endpoint.url,'--output','/dev/null',endpoint.url],{...options,timeoutMs:12_000,maxBytes:4096});
      samples.push(parseUnifiedLatency(output));
    }catch(error){
      if(options.signal?.aborted)throw new AppError('延迟检测已取消',409,'CANCELLED');
      samples.push({ok:false,issue:failureIssue(error)});
    }
  }
  return summarizeLatency(target,samples);
}
