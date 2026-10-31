import {z} from 'zod';
export const windowsDiskSize=z.number().int().min(16).max(256);
// Hyper-V exposes a Windows disk GUID, not an application-generated RFC UUID.
export const windowsDiskIdentifier=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).refine(value=>value!=='00000000-0000-0000-0000-000000000000');
export const windowsDiskGrowthInfo=z.object({platformId:z.uuid(),diskIdentifier:windowsDiskIdentifier,actualGiB:windowsDiskSize,allocatedBytes:z.number().int().nonnegative().safe(),registeredGiB:windowsDiskSize,pending:z.boolean(),fromGiB:windowsDiskSize,targetGiB:windowsDiskSize}).strict();
export type WindowsDiskGrowthInfo=z.infer<typeof windowsDiskGrowthInfo>;
// Allocated VHDX bytes are a file measurement, not a host free-space receipt.
export function windowsDiskAllocationSummary(before:number,after:number){
 const format=(bytes:number)=>bytes>=1024**3?`${(bytes/1024**3).toFixed(2)} GiB`:bytes>=1024**2?`${(bytes/1024**2).toFixed(1)} MiB`:bytes>=1024?`${(bytes/1024).toFixed(1)} KiB`:`${bytes} 字节`;
 const change=before===after?'分配量未变化':after<before?`分配量减少约 ${format(before-after)}`:`分配量增加约 ${format(after-before)}`;
 return `虚拟磁盘文件分配量 ${format(before)} → ${format(after)}，${change}`;
}
