import {z} from 'zod';
const id=z.uuid(),port=z.number().int().min(1).max(65535),count=z.number().int().min(0).max(1000000);
export const windowsHostLabStatusSchema=z.object({enabled:z.boolean(),phase:z.enum(['stopped','starting','running','stopping','error']),running:z.boolean(),runId:id.optional(),url:z.string().max(300).optional(),dnsPort:port.optional(),stunPort:port.optional(),receiptCount:count,eventCount:count,modelCalls:count,scope:z.literal('windows-host-control-loopback'),issue:z.string().max(500).optional()}).strict();
export type WindowsHostLabStatus=z.infer<typeof windowsHostLabStatusSchema>;
export const windowsHostLabWindowSchema=z.object({version:z.literal(1),runId:id,appOrigin:z.string().max(100),url:z.string().max(300),expiresAt:z.number().int().positive().safe(),signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type WindowsHostLabWindow=z.infer<typeof windowsHostLabWindowSchema>;
