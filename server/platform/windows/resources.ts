import {WINDOWS_RESOURCE_ERRORS} from '../../../shared/windows-resource-errors.ts';
import {z} from 'zod';import {AppError} from '../../errors.ts';
const bytes=z.number().int().nonnegative().safe();
export const windowsResourcesSchema=z.object({session:z.string().regex(/^[a-f0-9]{32}$/),totalMemoryBytes:bytes,availableMemoryBytes:bytes,memoryReserveBytes:bytes,memoryCriticalBytes:bytes,freeDiskBytes:bytes,diskFloorBytes:bytes,lastReservedGrowthBytes:bytes,virtualDiskLimitGiB:bytes,registeredDiskGiB:bytes,fenced:z.boolean(),issue:z.enum(['disk','memory','metrics-unavailable']).nullable(),cleanupRunning:z.boolean(),stopsConfirmed:z.boolean()}).strict();
export function resourceIssue(issue:string|null){return issue==='disk'?'宿主磁盘可用空间低于保护底线':issue==='memory'?'宿主可用内存低于保护底线':'宿主资源状态无法确认';}
export function resourceError(error:unknown){const messages=WINDOWS_RESOURCE_ERRORS;return error instanceof AppError&&messages[error.code]?new AppError(messages[error.code],409,error.code):error;}
