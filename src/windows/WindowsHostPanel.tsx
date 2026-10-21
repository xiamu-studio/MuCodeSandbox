import {useEffect,useState} from 'react';import {request} from '../api.ts';import {Button,Notice,SectionHeading} from '../components.tsx';import type {WindowsHostStatus} from '../../shared/windows-host.ts';
const phases:Record<string,string>={checking:'检查 Windows 组件', 'enable-hyperv':'启用 Hyper-V','install-ssh':'安装 OpenSSH 客户端','start-service':'启动 Hyper-V 服务',complete:'系统组件操作完成',failed:'系统组件准备未完成'};
export default function WindowsHostPanel({showReady,onChange}:{showReady:boolean;onChange:()=>void}){
 const [state,setState]=useState<WindowsHostStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let live=true,inFlight=false,last='';const update=async()=>{if(inFlight)return;inFlight=true;try{const next=await request<WindowsHostStatus>('/windows/host');if(live){setState(next);const key=JSON.stringify([next.ready,next.runtimeActive,next.operation?.status]);if(key!==last){last=key;onChange();}}}catch(e){if(live)setError((e as Error).message);}finally{inFlight=false;}};void update();const timer=setInterval(()=>void update(),10000);return()=>{live=false;clearInterval(timer);};},[onChange]);
 async function act(prepare=false){setBusy(true);setError('');try{setState(await request<WindowsHostStatus>('/windows/host',prepare?{method:'POST',body:'{}'}:{}));onChange();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 const running=['starting','running'].includes(state?.operation?.status??''),ready=state?.ready&&state.runtimeActive&&!running;if(ready&&!showReady)return null;
 return <section className="windows-setup" aria-label="Windows 系统组件">
  <SectionHeading title="Windows 系统组件"/>
  {!state?<p>正在检查 Windows 虚拟化和连接组件…</p>:<>
   <dl className="facts"><div><dt>Windows</dt><dd>{state.edition} · {state.build} · {state.architecture}</dd></div><div><dt>Hyper-V</dt><dd>{state.hyperV==='enabled'?'已启用':state.hyperV==='pending'?'等待重启':state.hyperV==='disabled'?'未启用':'不可用'}</dd></div><div><dt>OpenSSH 客户端</dt><dd>{state.sshClientPresent?'已安装':'未安装'}</dd></div><div><dt>固件虚拟化</dt><dd>{state.firmwareVirtualization===true?'已开启':state.firmwareVirtualization===false?'未开启':'未能确认'}</dd></div></dl>
   <Notice kind={ready?'success':'info'}>{running?phases[state.operation?.phase??'']??'Windows 正在准备组件':!state.supported?'当前 Windows 版本或处理器架构不支持此预览。需要提供 Hyper-V 的 Windows 11 x64 版本。':state.firmwareVirtualization!==true||state.slat!==true?'请先在 UEFI/BIOS 中开启虚拟化，并确认处理器满足硬件要求。':state.restartRequired?'系统组件需要重启。请保存工作后手动重启电脑，软件不会自动重启。':!state.runtimeActive&&state.ready?'系统组件已就绪，请退出并重新打开软件。':ready?'系统组件已就绪。':'请安装或启用系统组件后继续准备 Linux。'}</Notice>
   {state.operation?.status==='failed'&&<Notice kind="error">Windows 组件操作未完成。请检查 Windows 更新状态后重试{state.operation.errorCode!==null?'，错误码 '+state.operation.errorCode:''}。</Notice>}
  </>}
  <p>只处理 Hyper-V 和 OpenSSH 客户端。安装开始后由 Windows 在后台完成，关闭软件不会取消此操作；不会自动重启电脑。</p>
  {error&&<Notice kind="error">{error}</Notice>}
  <div className="button-row"><Button loading={busy} disabled={busy||!state?.canPrepare||running||!!state?.ready} onClick={()=>void act(true)}>安装或启用系统组件</Button><Button disabled={busy} onClick={()=>void act()}>重新检查</Button></div>
 </section>;
}
