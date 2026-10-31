import {setTimeout as delay} from 'node:timers/promises';
import {AppError} from '../../errors.ts';
import type {HyperVBrokerClient} from './broker.ts';
import {windowsShutdownStatus,type WindowsShutdownStatus} from '../../../shared/windows-shutdown.ts';

type Broker=Pick<HyperVBrokerClient,'call'>;
interface Options {initialStatus?:WindowsShutdownStatus;signal?:AbortSignal;timeoutMs?:number;pollMs?:number;now?:()=>number;wait?:(ms:number,signal?:AbortSignal)=>Promise<void>}
const unconfirmed=()=>new AppError('尚未确认受保护环境全部停止；关闭围栏已保留，请重试退出',409,'STOP_UNCONFIRMED');
function closeReceipt(raw:unknown):WindowsShutdownStatus{const reply=windowsShutdownStatus.parse(raw);if(reply.mode==='recovery')throw new AppError('原生关闭会话已变化，尚未确认停机',409,'SHUTDOWN_IDENTITY');return reply;}

export async function beginWindowsBrokerShutdown(broker:Broker):Promise<WindowsShutdownStatus>{return closeReceipt(await broker.call('shutdown-status',{}, {timeoutMs:5000}));}

// A shutdown RPC is an acceptance receipt. Only the fenced, exact native
// session and complete protected allocation scope can confirm graceful exit.
export async function confirmWindowsBrokerShutdown(broker:Broker,options:Options={}):Promise<WindowsShutdownStatus>{
 const timeout=options.timeoutMs??60000,poll=options.pollMs??250,now=options.now??(()=>performance.now()),wait=options.wait??((ms,signal)=>delay(ms,undefined,{signal}));
 if(!Number.isFinite(timeout)||timeout<1||timeout>120000||!Number.isFinite(poll)||poll<1||poll>5000)throw new AppError('退出等待参数无效',400,'SHUTDOWN_OPTIONS');
 const started=now();if(!Number.isFinite(started))throw unconfirmed();const initial=options.initialStatus?closeReceipt(options.initialStatus):undefined;let session=initial?.session,mode=initial?.mode;
 for(;;){
  options.signal?.throwIfAborted();const elapsed=now()-started;if(!Number.isFinite(elapsed)||elapsed<0||elapsed>=timeout)throw unconfirmed();
  const reply=closeReceipt(await broker.call('shutdown-status',session?{session}:{},{signal:options.signal,timeoutMs:Math.max(1,Math.min(5000,timeout-elapsed))}));
  options.signal?.throwIfAborted();if(reply.mode==='recovery'||session&&reply.session!==session||mode&&reply.mode!==mode)throw new AppError('原生关闭会话已变化，尚未确认停机',409,'SHUTDOWN_IDENTITY');
  const completedAt=now()-started;if(!Number.isFinite(completedAt)||completedAt<0||completedAt>=timeout)throw unconfirmed();
  session=reply.session;mode=reply.mode;if(reply.stopsConfirmed)return reply;
  const remaining=timeout-(now()-started);if(!Number.isFinite(remaining)||remaining<=0)throw unconfirmed();await wait(Math.min(poll,remaining),options.signal);
 }
}
