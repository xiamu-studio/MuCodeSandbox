import {z} from 'zod';import {AppError} from '../../errors.ts';
export const windowsPowerSchema=z.object({session:z.string().regex(/^[a-f0-9]{32}$/),monitoring:z.boolean(),fenced:z.boolean(),issue:z.enum(['suspend','resume','monitor-gap','clock-change','monitor-unavailable','authority-stalled']).nullable(),cleanupRunning:z.boolean(),stopsConfirmed:z.boolean()}).strict();
export function powerIssue(reason:string|null){return reason==='suspend'||reason==='resume'?'宿主休眠或唤醒已关闭本次运行会话':reason==='clock-change'?'宿主时钟连续性已变化':reason==='monitor-gap'||reason==='authority-stalled'?'原生防护或传输监测已中断':'电源防护状态无法确认';}
export function powerError(error:unknown){return error instanceof AppError&&error.code==='POWER_FENCED'?new AppError('电源或原生监测状态已变化，请重新打开软件后再启动',409,'POWER_FENCED'):error;}
