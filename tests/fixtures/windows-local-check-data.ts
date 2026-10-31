import {randomUUID} from 'node:crypto';
import type {Environment,Job} from '../../shared/types.ts';
import {windowsBrowserCheckItems} from '../../server/platform/windows/local-check-browser.ts';
import {WINDOWS_LOCAL_CHECK_SCOPE} from '../../server/platform/windows/local-checks.ts';
import type {WindowsBrowserCheckResult,WindowsLocalCheckReport} from '../../shared/windows-local-check.ts';

export function syntheticBrowserCheck():WindowsBrowserCheckResult{
 const page={timezone:'UTC',locale:'en-US',language:'en-US',languages:['en-US'],platform:'Linux x86_64',userAgent:'Synthetic Chrome Linux',hardwareConcurrency:2,deviceMemoryGiB:2,clientHints:null,canvasHash:'a'.repeat(64),gpu:{vendor:'SYNTHETIC_GPU_PRIVATE_MARKER',renderer:'synthetic renderer'},screen:{width:1280,height:720,colorDepth:24,pixelRatio:1}};
 const probe={page,worker:{...structuredClone(page),screen:null},frame:structuredClone(page)};
 return {probe,checks:windowsBrowserCheckItems(probe,{locale:'en-US',timezone:'UTC'}),requests:11,syntheticModelCalls:1,paidModelCalls:0,cleanupVerified:true,cleanupRecovered:false,isolatedContext:true,receiptId:randomUUID()};
}
export function syntheticCheckReport(environment:Environment,job:Job,state:'running'|'passed'|'failed'='passed'):WindowsLocalCheckReport{
 const now=new Date().toISOString(),result=syntheticBrowserCheck();
 return {version:1,id:randomUUID(),jobId:job.id,environmentId:environment.id,environmentName:environment.name,environmentUpdatedAt:environment.updatedAt,sessionId:randomUUID(),startedAt:now,checkedAt:now,state,accountFree:true,paidModelCalls:0,scope:WINDOWS_LOCAL_CHECK_SCOPE,checks:state==='running'?[]:result.checks,...state==='running'?{}:{result},...state==='failed'?{error:'Synthetic unfinished check'}:{}};
}
