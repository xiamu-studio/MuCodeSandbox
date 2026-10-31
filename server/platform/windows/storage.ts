import {z} from 'zod';import type {HyperVBrokerClient} from './broker.ts';import type {WindowsStorageStatus} from '../../../shared/windows-storage.ts';import {AppError} from '../../errors.ts';
const bytes=z.number().int().nonnegative().safe();
export const windowsStorageSchema=z.object({imageBytes:bytes,imageAllocatedBytes:bytes,temporaryBytes:bytes,catalogueBytes:bytes,reclaimableBytes:bytes,retainedBytes:bytes,imageCount:bytes,reclaimableFiles:bytes,unrecognizedEntries:bytes,quotaBytes:bytes,freeBytes:bytes,allocatedDiskGiB:bytes,unregisteredStorage:bytes,plan:z.string().regex(/^[a-f0-9]{64}$/),canPrune:z.boolean(),reason:z.enum(['host-unavailable','unregistered-storage','dependencies-unavailable','unrecognized-cache-data']).nullable()}).strict();
export class WindowsStorage {
 private pending:Promise<WindowsStorageStatus>|undefined;
 private clearing:Promise<{deletedFiles:number;reclaimedBytes:number}>|undefined;
 private broker:Pick<HyperVBrokerClient,'call'>;private keep:()=>string|null;private idle:()=>boolean;
 constructor(broker:Pick<HyperVBrokerClient,'call'>,keep:()=>string|null,idle:()=>boolean){this.broker=broker;this.keep=keep;this.idle=idle;}
 private async call(action:'cache-status'|'cache-prune',parameters:Record<string,unknown>){try{return await this.broker.call(action,parameters,{timeoutMs:60000});}catch(error){const messages:Record<string,string>={STORAGE_BUSY:'正在准备镜像，请稍后重新检查。',CACHE_PLAN_CHANGED:'缓存或引用已变化，请重新检查后再清理。',CACHE_NOT_READY:'目前不能安全清理缓存，请重新检查存储状态。',CACHE_UNKNOWN_DATA:'缓存包含未识别数据，已保留，请先检查。',CACHE_INTEGRITY:'缓存权限、文件身份或基盘登记未通过检查，已保留文件。'};if(error instanceof AppError&&messages[error.code])throw new AppError(messages[error.code],409,error.code);throw error;}}
 inspect():Promise<WindowsStorageStatus>{if(this.clearing)return this.clearing.catch(()=>{}).then(()=>this.inspect());return this.pending??=this.call('cache-status',{keepDigest:this.keep()}).then(value=>windowsStorageSchema.parse(value)).finally(()=>{this.pending=undefined;});}
 prune(plan:string,additionalIdle:()=>boolean=()=>true):Promise<{deletedFiles:number;reclaimedBytes:number}>{
  if(this.clearing)return Promise.reject(new AppError('缓存清理正在进行，请等待完成',409,'STORAGE_BUSY'));
  const pending=this.pending,work=(async()=>{
   if(!this.idle()||!additionalIdle())throw new AppError('请等待当前环境操作或组件准备完成后再清理缓存',409,'STORAGE_BUSY');
   z.string().regex(/^[a-f0-9]{64}$/).parse(plan);await pending;
   if(!this.idle()||!additionalIdle())throw new AppError('请等待当前环境操作或组件准备完成后再清理缓存',409,'STORAGE_BUSY');
   return z.object({deletedFiles:bytes,reclaimedBytes:bytes}).strict().parse(await this.call('cache-prune',{keepDigest:this.keep(),plan}));
  })();
  const tracked=work.finally(()=>{if(this.clearing===tracked)this.clearing=undefined;});this.clearing=tracked;return tracked;
 }
}
