import {z} from 'zod';
import type {HyperVBrokerClient} from './broker.ts';
const digest=z.string().regex(/^[a-f0-9]{64}$/),id=z.uuid().refine(value=>value===value.toLowerCase()&&value!=='00000000-0000-0000-0000-000000000000');
export const recoveryReviewSchema=z.object({review:z.object({version:z.literal(1),id,name:z.string().regex(/^mu-win-[a-f0-9]{32}$/),platformId:id,cpus:z.number().int().min(1).max(16),memoryGiB:z.number().int().min(2).max(32),diskGiB:z.number().int().min(16).max(256),imageSha256:digest,diskSha256:digest,seedSha256:digest,registryFingerprint:digest,registeredDiskGiB:z.number().int().min(0).max(1024)}).strict(),plan:digest,registered:z.literal(false),state:z.literal('Off'),diskPreserved:z.literal(true)}).strict().refine(value=>value.review.name==='mu-win-'+value.review.id.replaceAll('-',''),'Recovery VM name mismatch');
export type RecoveryReview=z.infer<typeof recoveryReviewSchema>;
export async function reviewProtectedStorage(client:HyperVBrokerClient,vmId:string,imageSha256:string){return recoveryReviewSchema.parse(await client.call('recovery-review',{id:id.parse(vmId),imageSha256:digest.parse(imageSha256)},{timeoutMs:1200000}));}
export async function adoptProtectedStorage(client:HyperVBrokerClient,value:unknown,confirmName:string){
 const reviewed=recoveryReviewSchema.parse(value);
 if(confirmName!==reviewed.review.name)throw Error('请输入审阅结果中的完整虚拟机名称，确认恢复登记');
 return z.object({registered:z.literal(true),id:z.literal(reviewed.review.id),platformId:z.literal(reviewed.review.platformId),state:z.literal('Off'),diskPreserved:z.literal(true),reopenRequired:z.literal(true)}).strict().parse(await client.call('recovery-adopt',{id:reviewed.review.id,imageSha256:reviewed.review.imageSha256,plan:reviewed.plan,confirmName},{timeoutMs:1200000}));
}
