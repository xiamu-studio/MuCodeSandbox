import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Circle, Globe, LoaderCircle, Maximize2, Minimize2, Monitor, RotateCw } from 'lucide-react';
import type RFB from '@novnc/novnc';
import { api,ApiError,request } from './api.ts';
import GuestAudio from './GuestAudio.tsx';
import GuestQuickTools from './GuestQuickTools.tsx';
import { IconButton } from './components.tsx';
import { useEmbeddedGuestLayout } from './guest-view-layout.ts';
import { DEFAULT_FIXED_DISPLAY, FIXED_DISPLAY_PRESETS, FIXED_DISPLAY_SCALE, displayPreference, displayRequestKey, fitDisplay, guestPresentation, type DisplayRequest, type GuestDisplay, type PresentationMode } from '../shared/guest-display.ts';

type Connection = 'connecting' | 'connected' | 'disconnected' | 'failed';

export default function GuestBrowserView({ id, name, embedded = false,desktop=false,active=true,starting=false }: { id: string; name?: string; embedded?: boolean;desktop?:boolean;active?:boolean;starting?:boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const remote = useRef<RFB | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState('');
  const [title, setTitle] = useState(name ?? '沙箱浏览器');
  const [fullscreen, setFullscreen] = useState(false);
  const activeView=useRef(active);activeView.current=active;
  const [display,setDisplay]=useState<GuestDisplay|null>(null);
  const [resizing,setResizing]=useState(false);
  const [displayError, setDisplayError] = useState('');
  const [settings, setSettings] = useState(false);
  const [preference, setPreference] = useState<DisplayRequest>({ ...DEFAULT_FIXED_DISPLAY });
  const [presentationMode, setPresentationMode] = useState<PresentationMode>('fit');
  const [view, setView] = useState({ width: 0, height: 0, density: window.devicePixelRatio });
  const [initialFrame, setInitialFrame] = useState({ width: 2560, height: 1600 });
  const confirmedDisplay = useRef<GuestDisplay | null>(null);
  const requestedDisplay = useRef<DisplayRequest>({ ...DEFAULT_FIXED_DISPLAY });
  const scheduleDisplay = useRef<() => void>(() => {});
  useEmbeddedGuestLayout(surface, embedded, active, fullscreen);

  useEffect(() => {
    if (name) { setTitle(name); return; }
    let live = true;
    void api.snapshot().then(snapshot => { if (live) setTitle(snapshot.environments.find(environment => environment.id === id)?.name ?? '沙箱浏览器'); }).catch(() => {});
    return () => { live = false; };
  }, [id, name]);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === surface.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(()=>{if(!active&&document.fullscreenElement===surface.current)void document.exitFullscreen().catch(()=>{});},[active]);

  useEffect(() => {
    // Retained tabs keep their UI state, but must not keep decoding the same
    // high-resolution desktop in the background. Disconnecting this viewer
    // leaves the guest display, applications and profile running unchanged.
    if (!active) { setConnection('disconnected'); setResizing(false); return; }
    if (!container.current) return;
    let disposed = false;
    let client: RFB | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelReady: (() => void) | undefined;
    let listeners: [string, EventListener][] = [];
    setConnection('connecting'); setError(''); setDisplayError('');
    const target = container.current;
    void (async () => {
      const deadline = Date.now() + 10 * 60_000;
      while (!disposed) {
        const state = await api.guestBrowser(id);
        if (disposed) return;
        if (!state.running&&!state.preparing&&!starting) { setConnection('disconnected'); setError(desktop?'沙箱桌面显示服务已关闭':'沙箱浏览器已关闭'); return; }
        if (state.running&&state.ready) {
          const saved = displayPreference(state.display);
          requestedDisplay.current = saved;
          confirmedDisplay.current = state.display ?? null;
          setPreference(saved); setDisplay(state.display ?? null);
          setInitialFrame({ width: state.width, height: state.height });
          break;
        }
        if (Date.now() >= deadline) throw new Error('浏览器启动超时，请检查操作日志');
        await new Promise<void>(resolve => { cancelReady = resolve; readyTimer = setTimeout(resolve, 2500); });
      }
      if (disposed) return;
      let ticket='',password='';
      const RemoteFrameBuffer=(await import('@novnc/novnc')).default;
      const ticketDeadline=Date.now()+120000;
      while(!disposed){
        try{({ticket,password}=await api.guestBrowserTicket(id));break;}
        catch(error){
          if(!(error instanceof ApiError)||error.code!=='OPERATION_IN_PROGRESS'||Date.now()>=ticketDeadline)throw error;
          await new Promise<void>(resolve=>{cancelReady=resolve;readyTimer=setTimeout(resolve,250);});
        }
      }
      if(disposed)return;
      const endpoint = new URL('/guest-browser', location.href);
      endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      endpoint.searchParams.set('ticket', ticket);
      client = new RemoteFrameBuffer(target, endpoint.href, { shared: true, credentials: { password } });
      remote.current = client;
      client.scaleViewport = true;
      client.resizeSession = false;
      client.focusOnClick = true;
      client.qualityLevel = 9;
      client.compressionLevel = 2;
      client.background = '#e6e9ed';
      listeners = [
        ['connect', () => { if (!disposed) { setConnection('connected'); setError(''); } }],
        ['disconnect', () => { if (!disposed) setConnection(value => value === 'failed' ? value : 'disconnected'); }],
        ['credentialsrequired', () => { if (!disposed) client?.sendCredentials({ password }); }],
        ['securityfailure', event => {
          if (disposed) return;
          setConnection('failed');
          setError((event as CustomEvent<{ reason?: string }>).detail?.reason ?? '浏览器连接验证失败');
        }],
      ];
      for (const [event, listener] of listeners) client.addEventListener(event, listener);
    })().catch(error => { if (!disposed) { setConnection('failed'); setError((error as Error).message); } });
    return () => {
      disposed = true;
      clearTimeout(readyTimer); cancelReady?.();
      remote.current = null;
      for (const [event, listener] of listeners) client?.removeEventListener(event, listener);
      client?.disconnect();
      target.replaceChildren();
    };
  }, [id, attempt, active]);

  useEffect(()=>{
    const target=viewport.current;if(!target||!active||connection!=='connected')return;
    let disposed=false,inFlight=false,last=confirmedDisplay.current?.matched?displayRequestKey(confirmedDisplay.current):'',retry=0;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let pending:DisplayRequest|undefined;
    let media:MediaQueryList|undefined;
    const observeDensity=()=>{
      media?.removeEventListener('change',densityChanged);
      media=window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);media.addEventListener('change',densityChanged);
    };
    const densityChanged=()=>{observeDensity();schedule();};
    const schedule=()=>{
      if(disposed)return;
      const bounds={width:target.clientWidth,height:target.clientHeight,density:window.devicePixelRatio};
      setView(previous=>previous.width===bounds.width&&previous.height===bounds.height&&previous.density===bounds.density?previous:bounds);
      if(!document.hasFocus()||document.hidden||bounds.width<100||bounds.height<100)return;
      const choice=requestedDisplay.current;
      const request=choice.mode==='fixed'?choice:{...fitDisplay(bounds.width,bounds.height,bounds.density),mode:'adaptive' as const};
      if(displayRequestKey(request)===last)return;
      pending=request;clearTimeout(timer);timer=setTimeout(()=>void apply(),220);
    };
    const apply=async()=>{
      timer=undefined;
      if(disposed||inFlight||!pending)return;
      const request=pending;pending=undefined;const key=displayRequestKey(request);if(key===last)return;
      inFlight=true;setResizing(true);
      try {
        const actual=await api.resizeGuestDisplay(id,request);if(disposed)return;
        confirmedDisplay.current=actual;setDisplay(actual);last=key;retry=0;
        const bounds={width:target.clientWidth,height:target.clientHeight,density:window.devicePixelRatio};
        const fits=actual.mode==='fixed'||Math.abs(actual.width-bounds.width*bounds.density)<3&&Math.abs(actual.height-bounds.height*bounds.density)<3;
        setDisplayError(actual.matched&&fits?'':'桌面已调整，但实际尺寸或原生像素密度尚未匹配。可重试显示设置。');
      }catch(e){if(!disposed){setDisplayError(`显示设置失败：${(e as Error).message}`);if(retry++<3){pending=request;timer=setTimeout(()=>void apply(),450);}}}
      finally{inFlight=false;if(!disposed){setResizing(false);if(pending&&!timer)timer=setTimeout(()=>void apply(),220);}}
    };
    scheduleDisplay.current=()=>{last='';retry=0;schedule();};
    const observer=new ResizeObserver(schedule);observer.observe(target);
    window.addEventListener('resize',schedule);window.addEventListener('focus',schedule);document.addEventListener('fullscreenchange',schedule);document.addEventListener('visibilitychange',schedule);window.visualViewport?.addEventListener('resize',schedule);
    observeDensity();schedule();
    return()=>{disposed=true;scheduleDisplay.current=()=>{};clearTimeout(timer);observer.disconnect();media?.removeEventListener('change',densityChanged);window.removeEventListener('resize',schedule);window.removeEventListener('focus',schedule);document.removeEventListener('fullscreenchange',schedule);document.removeEventListener('visibilitychange',schedule);window.visualViewport?.removeEventListener('resize',schedule);};
  },[id,connection,attempt,active]);

  function chooseDisplay(value: DisplayRequest) {
    requestedDisplay.current=value;setPreference(value);scheduleDisplay.current();
  }
  const presentation=guestPresentation(display??initialFrame,view.width,view.height,view.density,presentationMode);
  const presetKey=`${preference.cssWidth}x${preference.cssHeight}`;
  const knownPreset=FIXED_DISPLAY_PRESETS.some(value=>`${value.cssWidth}x${value.cssHeight}`===presetKey);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await surface.current?.requestFullscreen();
    } catch (error) { setError((error as Error).message); }
  }
  async function pasteGuestText(text:string){
    const target=remote.current;
    if(!activeView.current||connection!=='connected'||!target)throw new Error('请先连接当前沙箱画面');
    await request(`/environments/${id}/clipboard/write`,{method:'POST',body:JSON.stringify({text})});
    if(!activeView.current||remote.current!==target)throw new Error('画面已切换，文字已保留在沙箱剪贴板；返回后可手动 Ctrl+V。');
    target.focus();
    target.sendKey(0xffe3,'ControlLeft',true);
    try{target.sendKey(0x76,'KeyV');}finally{target.sendKey(0xffe3,'ControlLeft',false);}
  }
  const label = { connecting: '连接中', connected: '已连接', disconnected: '已断开', failed: '连接失败' }[connection];

  return <div className={`guest-browser-view ${embedded ? 'embedded' : 'standalone'}`} ref={surface}>
    <header className="guest-browser-toolbar" style={{flexWrap:'wrap'}}>
      {!embedded && <IconButton title="返回工作区" onClick={() => location.assign('/')}><ArrowLeft size={17} /></IconButton>}
      <div className="guest-browser-title"><Globe size={17} /><strong title={title}>{title}</strong><span>Linux</span></div>
      <span className="guest-browser-resolution" role="status" title={display?`真实桌面 ${display.screenWidth??display.cssWidth}×${display.screenHeight??display.cssHeight}；画面 ${display.width}×${display.height} 像素；查看区域 ${Math.round(view.width)}×${Math.round(view.height)}。${presentation.scrolls?'拖动查看区域滚动条查看其余桌面。':presentation.downscaled?'画面缩小展示。':'按原始像素展示。'}`:'正在确认真实桌面'}>{resizing?'正在设置桌面':display?`${display.mode==='fixed'?'固定':'自适应'} ${display.cssWidth}×${display.cssHeight} · ${display.browserScaleFactor}×${display.matched?'':' · 未确认'}`:''}</span>
      <IconButton title="显示设置" aria-expanded={settings} onClick={()=>setSettings(value=>!value)}><Monitor size={17}/></IconButton>
      <div className={`guest-browser-connection state-${connection}`} role="status">{connection === 'connecting' ? <LoaderCircle size={13} className="spin" /> : <Circle size={6} fill="currentColor" />}<span>{label}</span></div>
      <GuestAudio id={id} connected={connection === 'connected'} />
      <GuestQuickTools key={id} id={id} active={active} dropTarget={surface} onReturn={()=>remote.current?.focus()} connected={connection === 'connected'} onPaste={pasteGuestText} onKey={key=>{if(activeView.current){remote.current?.focus();remote.current?.sendKey(key==='enter'?0xff0d:0xff08,key==='enter'?'Enter':'Backspace');}}}/>
      <IconButton title={desktop?'重新连接桌面画面':'重新连接浏览器画面'} onClick={() => setAttempt(value => value + 1)}><RotateCw size={16} /></IconButton>
      <IconButton title={fullscreen ? '退出全屏' : '全屏'} disabled={!document.fullscreenEnabled} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</IconButton>
    </header>
    {settings&&<div className="guest-browser-keyboard" style={{flexWrap:'wrap',fontSize:12}}>
      <label>虚拟桌面 <select aria-label="虚拟桌面模式" style={{width:'auto'}} value={preference.mode??'adaptive'} disabled={connection!=='connected'||resizing} onChange={event=>chooseDisplay(event.target.value==='fixed'?{...DEFAULT_FIXED_DISPLAY}:{...preference,mode:'adaptive'})}><option value="fixed">固定尺寸 · 本次浏览器会话</option><option value="adaptive">随查看窗口调整</option></select></label>
      {preference.mode==='fixed'&&<label>桌面尺寸 <select aria-label="固定桌面尺寸" style={{width:'auto'}} value={presetKey} disabled={connection!=='connected'||resizing} onChange={event=>{const [cssWidth,cssHeight]=event.target.value.split('x').map(Number);chooseDisplay({cssWidth,cssHeight,scaleFactor:FIXED_DISPLAY_SCALE,mode:'fixed'});}}>{!knownPreset&&<option value={presetKey}>{preference.cssWidth}×{preference.cssHeight} · 2×</option>}{FIXED_DISPLAY_PRESETS.map(value=><option key={`${value.cssWidth}x${value.cssHeight}`} value={`${value.cssWidth}x${value.cssHeight}`}>{value.cssWidth}×{value.cssHeight} · 2×</option>)}</select></label>}
      <label>查看方式 <select aria-label="画面查看方式" style={{width:'auto'}} value={presentationMode} onChange={event=>setPresentationMode(event.target.value as PresentationMode)}><option value="native">原始像素 · 清晰 / 可滚动</option><option value="fit">适合窗口 · 只缩小</option></select></label>
      <span style={{color:'#627b85',fontSize:11}}>{preference.mode==='fixed'?`窗口和全屏变化保持真实桌面、2× 密度；${presentationMode==='fit'?'画面完整适合查看区域。':'较小区域可滚动查看。'}`:'窗口和屏幕密度变化会调整真实桌面。'} 设置保留到浏览器关闭。</span>
    </div>}
    <div className="guest-browser-display" ref={viewport} style={{overflow:presentationMode==='native'?'auto':'hidden'}}>
      <div style={{width:Math.max(view.width,presentation.width),height:Math.max(view.height,presentation.height),display:'flex',alignItems:'center',justifyContent:'center'}}>
        <div className="guest-browser-canvas" ref={container} style={{width:presentation.width,height:presentation.height,flexShrink:0}} aria-label={desktop?'Linux 沙箱桌面画面':'Linux 沙箱浏览器画面'} />
      </div>
      {connection !== 'connected' && <div className="guest-browser-overlay" aria-live="polite">{connection === 'connecting' ? <LoaderCircle size={25} className="spin" /> : <Globe size={29} strokeWidth={1.4} />}<strong>{label}</strong>{error && <span>{error}</span>}</div>}
    </div>
    {connection === 'connected' && error && <div className="guest-browser-error" role="alert">{error}</div>}
    {connection === 'connected' && displayError && <div className="guest-browser-error" role="alert">{displayError} <button type="button" className="button" disabled={resizing} onClick={()=>scheduleDisplay.current()}>重试显示设置</button></div>}
  </div>;
}
