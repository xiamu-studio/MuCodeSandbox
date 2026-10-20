import {useEffect,useRef,useState} from 'react';
import type RFB from '@novnc/novnc';
import {Maximize2,RefreshCw} from 'lucide-react';
import {api,request} from '../api.ts';
import {Button,Notice,SectionHeading} from '../components.tsx';
import GuestTimezoneClock from '../GuestTimezoneClock.tsx';
import type {Environment} from '../../shared/types.ts';

export default function WindowsBrowserView({environment}:{environment:Environment}){
 const container=useRef<HTMLDivElement>(null),surface=useRef<HTMLDivElement>(null),remote=useRef<RFB|null>(null);
 const [attempt,retry]=useState(0),[status,setStatus]=useState('连接中'),[error,setError]=useState(''),[text,setText]=useState(''),[busy,setBusy]=useState(false),[address,setAddress]=useState('');
 useEffect(()=>{
  let closed=false,rfb:RFB|undefined;setStatus('连接中');setError('');
  void(async()=>{const ticket=await api.guestBrowserTicket(environment.id);if(closed||!container.current)return;const FrameBuffer=(await import('@novnc/novnc')).default;if(closed)return;
   rfb=new FrameBuffer(container.current,`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/guest-browser?ticket=${encodeURIComponent(ticket.ticket)}`,{credentials:{password:ticket.password},shared:true});remote.current=rfb;
   rfb.scaleViewport=true;rfb.resizeSession=false;rfb.viewOnly=false;rfb.focusOnClick=true;
   rfb.addEventListener('connect',()=>{if(!closed){setStatus('已连接');rfb!.focus();}});
   rfb.addEventListener('disconnect',()=>{if(!closed)setStatus('已断开');});rfb.addEventListener('securityfailure',()=>{if(!closed){setStatus('连接失败');setError('客体画面认证失败，请重试连接。');}});
  })().catch(e=>{if(!closed){setStatus('连接失败');setError(e.message);}});
  return()=>{closed=true;if(remote.current===rfb)remote.current=null;rfb?.disconnect();};
 },[environment.id,attempt]);
 async function paste(){
  if(!remote.current||status!=='已连接')return;setBusy(true);setError('');
  try{await request(`/environments/${environment.id}/clipboard/write`,{method:'POST',body:JSON.stringify({text})});if(!remote.current)throw Error('画面已断开，文字已保留');remote.current.focus();remote.current.sendKey(0xffe3,'ControlLeft',true);remote.current.sendKey(0x76,'KeyV');remote.current.sendKey(0xffe3,'ControlLeft',false);setText('');}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 async function resize(){setBusy(true);setError('');try{const actual=await api.resizeGuestDisplay(environment.id,{cssWidth:1600,cssHeight:1000,scaleFactor:2,mode:'fixed'});if(!actual.matched)throw Error('客体画面与请求尺寸尚未一致，请重试');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function navigate(event:React.SubmitEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');try{await request(`/environments/${environment.id}/browser/navigate`,{method:'POST',body:JSON.stringify({url:address})});}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="windows-browser" ref={surface}>
  <SectionHeading title="Linux 浏览器" subtitle={status} action={<><GuestTimezoneClock timezone={environment.identity.timezone}/><Button disabled={busy||status!=='已连接'} onClick={()=>void resize()}>1600 × 1000 · 2×</Button><Button aria-label="重新连接画面" onClick={()=>retry(value=>value+1)} icon={<RefreshCw size={15}/>}/><Button aria-label="全屏画面" onClick={()=>void surface.current?.requestFullscreen().catch(e=>setError(e.message))} icon={<Maximize2 size={15}/>}/></>}/>
  <form className="windows-address" onSubmit={event=>void navigate(event)}><input type="url" aria-label="浏览器网址" placeholder="输入 HTTP 或 HTTPS 网址后打开" value={address} onChange={event=>setAddress(event.target.value)} required/><Button type="submit" disabled={busy||status!=='已连接'}>打开网址</Button></form>
  {error&&<Notice kind="error">{error}</Notice>}<div className="windows-browser-canvas" ref={container}/>
  <div className="windows-terminal-input"><label>中文与多行输入<textarea aria-label="浏览器待粘贴文字" value={text} maxLength={65536} onChange={event=>setText(event.target.value)}/></label><Button disabled={busy||status!=='已连接'||!text} onClick={()=>void paste()}>粘贴到客体</Button><Button disabled={busy||status!=='已连接'} onClick={()=>{setBusy(true);void request<{text:string}>(`/environments/${environment.id}/clipboard/read`,{method:'POST',body:'{}'}).then(result=>setText(result.text),e=>setError(e.message)).finally(()=>setBusy(false));}}>取回客体文字</Button><small>先点击客体输入框，再粘贴；不会自动发送。此处不会自动读取宿主剪贴板。</small></div>
 </section>;
}
