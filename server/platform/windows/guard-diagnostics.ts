import {AppError} from '../../errors.ts';
import {z} from 'zod';
import {guardComponentKeys,guardFailureCodes,type GuardDiagnostics,type GuardFailureCode} from '../../../shared/windows-guard-diagnostics.ts';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const windowsGuardInspection=z.object({digest,leaseActive:z.boolean(),remainingMs:z.number().nonnegative().max(45000),components:z.object({tables:digest,files:digest,networkRules:digest,networkRoutes:digest,networkDns:digest,networkDomains:digest}).strict().optional()}).strict();
export type GuardInspection=z.infer<typeof windowsGuardInspection>;

// Only evidence attached by this process is accepted. Arbitrary error fields,
// SSH stderr and guest paths must never become a structured diagnostic payload.
const evidence=new WeakMap<object,GuardDiagnostics>();
const failureSources=new WeakMap<object,NonNullable<GuardDiagnostics['failureSource']>>();
export function attachGuardFailureSource(error:unknown,source:NonNullable<GuardDiagnostics['failureSource']>){
 const target=error instanceof Error?error:Error('防护检查未完成');failureSources.set(target,source);return target;
}
export function guardFailureSource(error:unknown){return error instanceof Error?failureSources.get(error):undefined;}
export function attachWindowsGuardDiagnostics(error:unknown,value:GuardDiagnostics){
 const target=error instanceof Error?error:Error(String(error));evidence.set(target,structuredClone(value));return target;
}
export function windowsGuardDiagnostics(error:unknown):GuardDiagnostics|undefined{
 const pending=[error],seen=new Set<unknown>();
 for(let count=0;count<8&&pending.length;count++){
  const candidate=pending.shift();if(seen.has(candidate))continue;seen.add(candidate);
  if(candidate&&typeof candidate==='object'){const value=evidence.get(candidate);if(value)return structuredClone(value);}
  if(candidate instanceof AggregateError)pending.push(...candidate.errors.slice(0,3));
  if(candidate instanceof Error&&candidate.cause)pending.push(candidate.cause);
 }
}
export function changedGuardComponents(baseline:GuardInspection['components'],current:GuardInspection['components']){
 return baseline&&current?guardComponentKeys.filter(key=>baseline[key]!==current[key]):undefined;
}

export function guardFailureCode(error:unknown):GuardFailureCode|undefined{
 if(error instanceof z.ZodError)return 'INVALID_GUARD_RESPONSE';
 if(error instanceof AppError&&(guardFailureCodes as readonly string[]).includes(error.code))return error.code as GuardFailureCode;
}
