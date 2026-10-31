import {windowsBrowserStartPage} from '../../../shared/windows-browser-start.ts';
import {GUEST_HOME_URL,browserHomeInstallScript} from '../../browser-startpage.ts';
import {AppError} from '../../errors.ts';

export type WindowsBrowserStartup='blank'|'configured';
export interface WindowsBrowserStartupPlan {kind:'blank'|'home'|'url';url:string}
export function windowsBrowserStartupPlan(value:unknown,startup:WindowsBrowserStartup='blank'):WindowsBrowserStartupPlan{
 if(startup==='blank')return {kind:'blank',url:'about:blank'};
 if(startup!=='configured')throw new AppError('浏览器启动方式无效',400,'BROWSER_STARTUP_INVALID');
 try{const chosen=windowsBrowserStartPage(value);return {...chosen,url:chosen.kind==='home'?GUEST_HOME_URL:chosen.kind==='blank'?'about:blank':chosen.url};}
 catch{throw new AppError('启动页无效，请停止环境后重新设置',400,'BROWSER_STARTUP_INVALID');}
}
export interface WindowsBrowserStartupActions {
 signal?:AbortSignal;assertCurrent:()=>void;verifyProtection:()=>Promise<unknown>;
 prepareHome:()=>Promise<string>;installHome:(script:string)=>Promise<unknown>;navigate:(url:string)=>Promise<unknown>;
}
export async function applyWindowsBrowserStartup(plan:WindowsBrowserStartupPlan,actions:WindowsBrowserStartupActions){
 const current=()=>{actions.signal?.throwIfAborted();actions.assertCurrent();};
 current();
 if(plan.kind==='blank'){if(plan.url!=='about:blank')throw Error('Invalid blank startup plan');return;}
 if(plan.kind==='home'){if(plan.url!==GUEST_HOME_URL)throw Error('Invalid local browser homepage');}
 else if(plan.kind!=='url'||windowsBrowserStartPage(plan.url).kind!=='url')throw Error('Invalid browser startup plan');
 if(plan.kind==='home'){
  // This reads only the bundled local asset. The guard immediately before
  // guest publication remains mandatory, including after a slow read.
  const script=await actions.prepareHome();current();
  await actions.verifyProtection();current();
  await actions.installHome(script);current();
  await actions.verifyProtection();current();
 }else{await actions.verifyProtection();current();}
 const reply=await actions.navigate(plan.url);current();
 if(reply&&typeof reply==='object'&&(('errorText' in reply&&reply.errorText)||('isDownload' in reply&&reply.isDownload)))throw new AppError('浏览器未能打开启动页，请检查网址和网络后重试',409,'BROWSER_STARTUP_FAILED');
 await actions.verifyProtection();current();
}
export const prepareWindowsBrowserHome=()=>browserHomeInstallScript(true);
