import {z} from 'zod';
export const windowsDiskSize=z.number().int().min(16).max(256);
// Hyper-V exposes a Windows disk GUID, not an application-generated RFC UUID.
export const windowsDiskIdentifier=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).refine(value=>value!=='00000000-0000-0000-0000-000000000000');
export const windowsDiskGrowthInfo=z.object({platformId:z.uuid(),diskIdentifier:windowsDiskIdentifier,actualGiB:windowsDiskSize,registeredGiB:windowsDiskSize,pending:z.boolean(),fromGiB:windowsDiskSize,targetGiB:windowsDiskSize}).strict();
export type WindowsDiskGrowthInfo=z.infer<typeof windowsDiskGrowthInfo>;
