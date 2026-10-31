import {z} from 'zod';
const text=(maximum:number)=>z.string().max(maximum),positive=z.number().int().positive().max(65536);
export const windowsCheckFeaturesSchema=z.object({
 timezone:text(100),locale:text(80),language:text(80),languages:z.array(text(80)).max(20),platform:text(80),userAgent:text(1024),
 hardwareConcurrency:positive,deviceMemoryGiB:z.number().finite().nonnegative().max(65536).nullable(),
 clientHints:z.object({brands:z.array(z.object({brand:text(100),version:text(100)}).strict()).max(20).optional(),mobile:z.boolean().optional(),platform:text(100),architecture:text(100).optional(),bitness:text(30).optional(),model:text(200).optional(),fullVersionList:z.array(z.object({brand:text(100),version:text(100)}).strict()).max(20).optional()}).strict().nullable(),
 canvasHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),gpu:z.object({vendor:text(500),renderer:text(1000)}).strict().nullable(),
 screen:z.object({width:positive,height:positive,colorDepth:positive,pixelRatio:z.number().finite().positive().max(20)}).strict().nullable(),
}).strict();
export const windowsCheckProbeSchema=z.object({page:windowsCheckFeaturesSchema,worker:windowsCheckFeaturesSchema,frame:windowsCheckFeaturesSchema}).strict();
export type WindowsCheckProbe=z.infer<typeof windowsCheckProbeSchema>;
export const windowsCheckItemSchema=z.object({name:text(100),passed:z.boolean(),detail:text(1000)}).strict();
export const windowsBrowserCheckResultSchema=z.object({
 probe:windowsCheckProbeSchema,checks:z.array(windowsCheckItemSchema).max(8),requests:z.number().int().min(1).max(64),
 syntheticModelCalls:z.literal(1),paidModelCalls:z.literal(0),cleanupVerified:z.literal(true),cleanupRecovered:z.boolean(),
 isolatedContext:z.literal(true),receiptId:z.uuid(),
}).strict();
export type WindowsBrowserCheckResult=z.infer<typeof windowsBrowserCheckResultSchema>;
export const windowsLocalCheckReportSchema=z.object({
 version:z.literal(1),id:z.uuid(),jobId:z.uuid(),environmentId:z.uuid(),environmentName:text(60),sessionId:z.uuid(),environmentUpdatedAt:z.iso.datetime(),
 startedAt:z.iso.datetime(),checkedAt:z.iso.datetime(),state:z.enum(['running','passed','failed']),
 accountFree:z.literal(true),paidModelCalls:z.literal(0),scope:text(500),checks:z.array(windowsCheckItemSchema).max(10),
 result:windowsBrowserCheckResultSchema.optional(),error:text(1000).optional(),
}).strict().superRefine((report,context)=>{
 if(report.state==='passed'&&(!report.result||!report.checks.length||report.checks.some(check=>!check.passed)||report.error))context.addIssue({code:'custom',message:'An incomplete check cannot be reported as passed'});
 if(report.state==='running'&&(report.result||report.error))context.addIssue({code:'custom',message:'A running check has no completed result'});
});
export type WindowsLocalCheckReport=z.infer<typeof windowsLocalCheckReportSchema>;
export const windowsLocalCheckStatusSchema=z.object({enabled:z.boolean(),reports:z.array(windowsLocalCheckReportSchema).max(50),issue:text(500).nullable()}).strict();
export type WindowsLocalCheckStatus=z.infer<typeof windowsLocalCheckStatusSchema>;
export const windowsLocalCheckStartSchema=z.object({reportId:z.uuid(),job:z.object({id:z.uuid(),environmentId:z.uuid(),action:z.literal('lab-check')}).passthrough()}).strict();
