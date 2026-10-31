import {saveBuildReceipt,pruneWindowsBuilds} from './build-retention.ts';

// A build may need independent payload/runtime review before it can replace
// the last checked candidate. Publish its ownership receipt in either mode;
// deferred retention must not inspect processes or remove earlier artifacts.
export async function finalizeWindowsPackage(root:string,output:string,stage:string,version:string,artifacts:string[],deferRetention=false){
 await saveBuildReceipt(output,stage,version,artifacts);
 if(deferRetention)return {deferred:true,reason:'Retention deferred until the new candidate has completed independent package review',removed:[] as string[],skipped:[] as {path:string;reason:string}[]};
 return {deferred:false,...await pruneWindowsBuilds(root,output,stage)};
}
