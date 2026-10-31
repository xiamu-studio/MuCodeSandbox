import {useEffect,useRef,useState} from 'react';
import {Button,Notice,SectionHeading} from '../components.tsx';
import {request} from '../api.ts';
import type {BrowserInspection,BrowserVersionStatus,Environment,Job} from '../../shared/types.ts';
import WindowsBrowserStartupSettings from './WindowsBrowserStartupSettings.tsx';
import WindowsBrowserResetPanel from './WindowsBrowserResetPanel.tsx';
import WindowsBrowserRepairPanel from './WindowsBrowserRepairPanel.tsx';

function useReading<T>(key:string,enabled:boolean,endpoint:string){
 const live=useRef(false),latest=useRef(key),inflight=useRef<{key:string;controller:AbortController}|null>(null);latest.current=key;
 const [result,setResult]=useState<{key:string;pending:boolean;value?:T;error?:string;at?:string}>({key:'',pending:false});
 useEffect(()=>{live.current=true;return()=>{live.current=false;inflight.current?.controller.abort();};},[]);
 useEffect(()=>{const pending=inflight.current;if(pending&&pending.key!==key){pending.controller.abort();if(inflight.current===pending)inflight.current=null;}},[key]);
 async function read(){
  if(!enabled||!live.current||inflight.current?.key===key&&!inflight.current.controller.signal.aborted)return;
  inflight.current?.controller.abort();const controller=new AbortController();inflight.current={key,controller};
  setResult(previous=>({key,pending:true,value:previous.key===key?previous.value:undefined,at:previous.key===key?previous.at:undefined}));
  try{const value=await request<T>(endpoint,{signal:controller.signal});if(live.current&&latest.current===key&&!controller.signal.aborted)setResult({key,pending:false,value,at:new Date().toISOString()});}
  catch(error){if(live.current&&latest.current===key&&!controller.signal.aborted)setResult(previous=>({...previous,key,pending:false,error:(error as Error).message}));}
  finally{if(inflight.current?.controller===controller)inflight.current=null;}
 }
 return {value:result.key===key?result.value:undefined,error:result.key===key?result.error:undefined,pending:result.key===key&&result.pending,at:result.key===key?result.at:undefined,read};
}

export default function WindowsBrowserDetails({environment,disabled=false,startupEnabled=false,resetEnabled=false,repairEnabled=false,jobs=[],onChange}:{environment:Environment;disabled?:boolean;startupEnabled?:boolean;resetEnabled?:boolean;repairEnabled?:boolean;jobs?:Job[];onChange?:()=>Promise<void>}){
 const running=environment.state==='running',key=JSON.stringify([environment.id,environment.updatedAt,environment.state,environment.browserRunning,disabled]);
 const version=useReading<BrowserVersionStatus>(key,running&&!disabled,`/environments/${environment.id}/browser/version`);
 const inspection=useReading<BrowserInspection>(key,running&&environment.browserRunning&&!disabled,`/environments/${environment.id}/browser/inspect`);
 const actual=inspection.value;
 return <details className="panel-width windows-browser-details"><summary>浏览器设置</summary>
  <dl className="facts"><div><dt>运行位置</dt><dd>独立 Linux 环境</dd></div><div><dt>浏览器引擎</dt><dd>Google Chrome · Linux AMD64</dd></div><div><dt>会话存储</dt><dd>当前虚拟机磁盘</dd></div><div><dt>网络</dt><dd>严格透明代理</dd></div></dl>
  {startupEnabled&&onChange&&<WindowsBrowserStartupSettings environment={environment} disabled={disabled} onChange={onChange}/>}
  <WindowsBrowserResetPanel environment={environment} enabled={resetEnabled} disabled={disabled} jobs={jobs} onChange={onChange}/>
  {!running&&<Notice>启动环境后可读取浏览器版本，打开浏览器后可检测页面特征。</Notice>}
  <section className="network-test" aria-label="Windows 浏览器版本"><SectionHeading title="浏览器版本" action={<Button disabled={!running||disabled||version.pending} loading={version.pending} onClick={()=>void version.read()}>检测浏览器版本</Button>}/>
   <dl className="facts"><div><dt>已安装</dt><dd className="mono">{version.value?.installedVersion??(version.value?.installationState?'尚未确认':'--')}</dd></div><div><dt>本机已批准版本</dt><dd className="mono">{version.value?.availableVersion??'--'}</dd></div><div><dt>版本状态</dt><dd>{version.value?.installationState==='missing'?'缺少浏览器组件':version.value?.installationState==='untrusted'?'安装资料未通过核验':version.value?version.value.recoveryRequired?'与已批准版本不一致':'与已批准版本一致':'尚未检测'}</dd></div>{version.value?.recordedVersion&&!version.value.installedVersion&&<div><dt>登记版本</dt><dd className="mono">{version.value.recordedVersion}</dd></div>}</dl>
   {version.value?.installationIssue&&<Notice kind="error">{version.value.installationIssue}</Notice>}
   {version.value?.profileCompatibility&&<section aria-label="浏览器资料版本"><dl className="facts"><div><dt>资料记录版本</dt><dd className="mono">{version.value.profileCompatibility.recordedVersion??'未记录'}</dd></div><div><dt>资料版本状态</dt><dd>{{absent:'尚无浏览器资料',unrecorded:'无法确认此前使用的版本',compatible:'与当前批准版兼容',newer:'资料来自更高版本',untrusted:'资料版本未通过核验'}[version.value.profileCompatibility.state]}</dd></div></dl>
    {version.value.profileCompatibility.state==='newer'&&<Notice kind="error">现有资料来自更高版本，当前批准版不能降级打开。请保留资料，使用匹配版本的应用或新建空白环境。恢复当前批准版组件不会降低资料版本。</Notice>}
    {version.value.profileCompatibility.state==='untrusted'&&<Notice kind="error">资料版本或路径无法核验，浏览器保持关闭；请核对资料及客体权限。</Notice>}
    {version.value.profileCompatibility.state==='unrecorded'&&<Notice>未找到资料版本记录，不能据此确认此前使用的版本。打开前仍会重新检查；现有资料保留。</Notice>}
   </section>}
   {version.at&&<p className="muted">读取于 {new Date(version.at).toLocaleTimeString()}</p>}{version.error&&<Notice kind="error">{version.error}</Notice>}
   <p>本机已批准版本随应用组件提供；这里不查询在线最新版本。</p>
   <WindowsBrowserRepairPanel environment={environment} enabled={repairEnabled} disabled={disabled} jobs={jobs} onChange={onChange}/>
  </section>
  <section className="network-test" aria-label="Windows 浏览器页面特征"><SectionHeading title="实际环境特征" action={<Button disabled={!running||!environment.browserRunning||disabled||inspection.pending} loading={inspection.pending} onClick={()=>void inspection.read()}>检测特征</Button>}/>
   <dl className="facts"><div><dt>时区</dt><dd>{actual?.timezone??'--'}</dd></div><div><dt>页面语言</dt><dd>{actual?.language??'--'}</dd></div><div><dt>区域格式</dt><dd>{actual?.locale??'--'}</dd></div><div><dt>操作系统</dt><dd>{actual?.platform??'--'}</dd></div><div><dt>CPU 线程</dt><dd>{actual?.hardwareConcurrency??'--'}</dd></div><div><dt>屏幕尺寸</dt><dd>{actual?`${actual.screenWidth} × ${actual.screenHeight}`:'--'}</dd></div><div><dt>WebRTC 策略</dt><dd className="mono path-text">{actual?.webRtcPolicy??'--'}</dd></div><div><dt>与地区配置一致</dt><dd>{actual?actual.matchesConfiguration?'是':'否':'--'}</dd></div></dl>
   {actual&&<p className="muted">检测于 {new Date(actual.checkedAt).toLocaleTimeString()}</p>}{inspection.error&&<Notice kind="error">{inspection.error}</Notice>}
  </section>
  <Notice>{startupEnabled?'浏览器先核验空白页，再打开已保存的启动页。在线更新尚未提供。':'Windows 当前使用固定的已批准版本，并从空白页启动。启动页设置及在线更新尚未提供。'}</Notice>
 </details>;
}
