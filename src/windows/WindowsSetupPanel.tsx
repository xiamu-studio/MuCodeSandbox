import {useEffect,useState} from 'react';
import {request} from '../api.ts';
import {Button,Notice,SectionHeading} from '../components.tsx';
import type {WindowsSetupState,WindowsSetupPhase} from '../../shared/windows-setup.ts';

const labels:Record<WindowsSetupPhase,string>={checking:'检查系统组件', 'download-base':'下载并校验 Ubuntu 镜像',extracting:'校验和提取系统镜像','download-tunnel':'下载并校验网络防护组件','download-browser':'下载并校验浏览器','download-display':'下载并校验画面组件',creating:'创建临时构建器',booting:'启动空白 Linux', 'installing-system':'安装 Linux 系统组件','installing-desktop':'安装浏览器和桌面',verifying:'核验组件与关闭的联网许可',sealing:'保存受保护基盘',cleaning:'清理临时构建器',publishing:'完成准备',ready:'Linux 组件已准备好'};
export default function WindowsSetupPanel({onReady}:{onReady:()=>void}){
 const [state,setState]=useState<WindowsSetupState|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let live=true,inFlight=false,ready=false;const update=async()=>{if(inFlight)return;inFlight=true;try{const value=await request<WindowsSetupState>('/windows/setup');if(live){setState(value);if(value.status==='ready'&&!ready){ready=true;onReady();}}}catch(e){if(live)setError((e as Error).message);}finally{inFlight=false;}};void update();const timer=setInterval(()=>void update(),2000);return()=>{live=false;clearInterval(timer);};},[onReady]);
 async function act(cancel=false){setBusy(true);setError('');try{setState(await request<WindowsSetupState>('/windows/setup'+(cancel?'/cancel':''),{method:'POST',body:'{}'}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 if(state?.status==='ready')return null;
 const running=state?.status==='running';return <section className="windows-setup" aria-label="Linux 组件准备">
  <SectionHeading title="准备 Linux 组件"/>
  <p>首次使用会下载 Ubuntu、浏览器和网络防护组件，并创建空白基盘。准备完成后即可新建环境。</p>
  <p>需要已启用的 Hyper-V 和 Windows OpenSSH 客户端。系统盘和数据目录会保存镜像与缓存，准备期间不自动重启电脑。</p>
  {state&&<Notice kind={state.status==='failed'?'error':'info'}>{running?labels[state.phase]:state.message??'准备只使用空白 Linux，不导入现有环境和账号。'}</Notice>}
  {running&&state&&state.totalBytes>0&&<div><progress aria-label="组件下载进度" value={state.completedBytes} max={state.totalBytes}/><span>{Math.floor(state.completedBytes/1048576)} / {Math.ceil(state.totalBytes/1048576)} MiB</span></div>}
  {error&&<Notice kind="error">{error}</Notice>}
  <div className="button-row">{running?<Button disabled={busy||state?.phase==='publishing'||state?.phase==='cleaning'} onClick={()=>void act(true)}>取消准备</Button>:<Button className="primary" loading={busy} disabled={!state?.canPrepare} onClick={()=>void act()}>准备 Linux 组件</Button>}</div>
 </section>;
}
