import {z} from 'zod';

export const windowsShutdownStatus=z.object({
 version:z.literal(1),session:z.string().regex(/^[a-f0-9]{32}$/),
 mode:z.enum(['normal','setup','recovery']),fenced:z.literal(true),
 activeWrites:z.number().int().min(0).max(16),allocationCount:z.number().int().min(0).max(32),stopsConfirmed:z.boolean(),
}).strict().superRefine((value,context)=>{
 if(value.stopsConfirmed&&(value.activeWrites!==0||value.mode==='setup'&&value.allocationCount!==0))context.addIssue({code:'custom',message:'停止确认与原生范围不一致'});
});
export type WindowsShutdownStatus=z.infer<typeof windowsShutdownStatus>;
