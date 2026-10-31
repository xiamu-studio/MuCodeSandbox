// Both prerequisites must settle before the service can become available or
// begin cleanup after a failure. Neither check may waive the other.
export async function initializeWindowsPrerequisites(host:()=>Promise<unknown>,base:()=>Promise<unknown>){
 const checks=await Promise.allSettled([Promise.resolve().then(host),Promise.resolve().then(base)]);
 const failure=checks.find((check):check is PromiseRejectedResult=>check.status==='rejected');
 if(failure)throw failure.reason;
}
