import {AppError} from '../../errors.ts';
import type {HyperVBrokerClient} from './broker.ts';
import {reviewProtectedStorage,adoptProtectedStorage} from './recovery.ts';
import type {WindowsRecoverySnapshot} from '../../../shared/windows-recovery.ts';
import type {RecoveryInventory} from './recovery-candidates.ts';
const messages:Record<string,string>={POWER_FENCED:'电源或原生监测状态已变化，请重新进入恢复模式后核验。',RECOVERY_REVIEW_CHANGED:'原环境或登记已变化，请重新核验后确认。',DENIED:'原环境身份或文件权限不符合恢复条件，原盘已保留。',BROKER_FAILED:'无法确认原虚拟机完整且已停止，原盘已保留。',BROKER_UNAVAILABLE:'恢复组件已关闭，请退出后重新进入恢复模式。',BROKER_TIMEOUT:'核验未及时完成，原盘已保留，请重新进入恢复模式。'};
export class WindowsRecoveryWizard {
 private value:WindowsRecoverySnapshot={phase:'idle',candidates:[],issue:null,selectedId:null,review:null,message:'请选择需要恢复登记的原环境。',canCancel:false};
 private operation:Promise<void>|undefined;private abort:AbortController|undefined;private closing=false;
 private bindings=new Map<string,string>();
 private broker:HyperVBrokerClient;private load:()=>Promise<RecoveryInventory>;
 constructor(broker:HyperVBrokerClient,load:()=>Promise<RecoveryInventory>){this.broker=broker;this.load=load;}
 snapshot():WindowsRecoverySnapshot{return structuredClone(this.value);}
 async refresh(){this.available();this.operation=Promise.resolve().then(async()=>{const loaded=await this.load();this.bindings=new Map(loaded.bindings);this.value={...this.value,candidates:loaded.candidates,issue:loaded.issue,phase:'idle',selectedId:null,review:null,message:'请选择需要恢复登记的原环境。',canCancel:false};}).finally(()=>{this.operation=undefined;});await this.operation;return this.snapshot();}
 private available(){if(this.closing)throw new AppError('恢复模式正在退出',409,'CLOSING');if(this.operation)throw new AppError('正在核验或恢复，请等待当前操作完成',409,'RECOVERY_BUSY');if(this.value.phase==='completed')throw new AppError('登记已恢复，请重新打开工作区',409,'RECOVERY_REOPEN_REQUIRED');}
 review(id:string){
  this.available();const candidate=this.value.candidates.find(value=>value.id===id);
  const binding=this.bindings.get(id);
  if(!candidate?.ready||!candidate.imageSha256||!candidate.platformId||!binding)throw new AppError('原管理资料不完整，无法核验该环境',409,'RECOVERY_METADATA_REQUIRED');
  this.abort=new AbortController();this.value={...this.value,phase:'reviewing',selectedId:id,review:null,message:'正在核验原虚拟机与磁盘，请稍候。',canCancel:true};
  const signal=this.abort.signal;
  this.operation=Promise.resolve().then(async()=>{
   const result=await reviewProtectedStorage(this.broker,id,candidate.imageSha256!,{signal});
   if(signal.aborted)throw new AppError('核验已取消',409,'CANCELLED');
   const loaded=await this.load();if(signal.aborted)throw new AppError('核验已取消',409,'CANCELLED');
   if(loaded.bindings.get(id)!==binding)throw new AppError('原管理资料已变化，请刷新后重新核验',409,'RECOVERY_METADATA_CHANGED');
   const original=loaded.candidates.find(value=>value.id===id);
   if(!original?.ready||original.imageSha256!==candidate.imageSha256||original.platformId!==candidate.platformId||original.name!==candidate.name||original.cpus!==candidate.cpus||original.memoryGiB!==candidate.memoryGiB||original.diskGiB!==candidate.diskGiB||result.review.platformId!==candidate.platformId||result.review.cpus!==candidate.cpus||result.review.memoryGiB!==candidate.memoryGiB||result.review.diskGiB!==candidate.diskGiB)throw new AppError('本地管理资料与原虚拟机不一致，请先恢复原管理资料',409,'RECOVERY_METADATA_CHANGED');
   this.value={...this.value,phase:'reviewed',review:result,message:'核验完成。请审阅原环境身份和资源，再确认恢复登记。',canCancel:false};
  }).catch(error=>this.failed(error,signal.aborted)).finally(()=>{this.operation=undefined;this.abort=undefined;});
  return this.snapshot();
 }
 adopt(id:string,plan:string,confirmation:string){
  this.available();const candidate=this.value.candidates.find(value=>value.id===id),reviewed=this.value.review;
  if(this.value.phase!=='reviewed'||this.value.selectedId!==id||!candidate||!reviewed||reviewed.plan!==plan)throw new AppError('请重新核验原环境后再确认',409,'RECOVERY_REVIEW_REQUIRED');
  if(confirmation!==candidate.name)throw new AppError('请输入完整原环境名称以确认恢复登记',400,'RECOVERY_CONFIRMATION_REQUIRED');
  this.value={...this.value,phase:'applying',message:'正在重新核验并恢复登记，请等待结果。',canCancel:false};
  this.operation=Promise.resolve().then(async()=>{
   const loaded=await this.load();if(!this.bindings.has(id)||loaded.bindings.get(id)!==this.bindings.get(id))throw new AppError('原管理资料已变化，请刷新后重新核验',409,'RECOVERY_METADATA_CHANGED');
   const original=loaded.candidates.find(value=>value.id===id);
   if(!original?.ready||original.name!==candidate.name||original.platformId!==candidate.platformId||original.imageSha256!==candidate.imageSha256||original.cpus!==candidate.cpus||original.memoryGiB!==candidate.memoryGiB||original.diskGiB!==candidate.diskGiB)throw new AppError('原管理资料已变化，请重新核验',409,'RECOVERY_METADATA_CHANGED');
   await adoptProtectedStorage(this.broker,reviewed,reviewed.review.name);
   this.value={...this.value,phase:'completed',message:'原环境登记已恢复，虚拟机保持停止。重新打开工作区后可核验并启动。',canCancel:false};
  }).catch(error=>this.failed(error,false)).finally(()=>{this.operation=undefined;});
  return this.snapshot();
 }
 private failed(error:unknown,cancelled:boolean){const code=(error as {code?:string})?.code;this.value={...this.value,phase:cancelled?'cancelled':'failed',review:null,canCancel:false,message:cancelled?'核验已取消，原盘和登记未改动。':code==='RECOVERY_METADATA_CHANGED'?(error as Error).message:messages[code??'']??'恢复未完成，原盘和管理资料已保留。请重新核验。'};}
 cancel(){if(this.value.phase==='reviewed'){this.value={...this.value,phase:'cancelled',selectedId:null,review:null,canCancel:false,message:'已取消确认，原盘和登记未改动。'};return this.snapshot();}if(this.value.phase!=='reviewing')throw new AppError('当前操作无法取消，请等待恢复结果',409,'RECOVERY_CANNOT_CANCEL');this.abort?.abort();return this.snapshot();}
 async wait(){await this.operation;}
 async close(){this.closing=true;this.abort?.abort();await this.operation;}
}
