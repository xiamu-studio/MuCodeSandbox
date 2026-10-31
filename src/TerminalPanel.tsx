import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RotateCw, TerminalSquare, Bot, Circle, Maximize2, Minimize2 } from 'lucide-react';
import type { Environment } from '../shared/types.ts';
import { api,ApiError } from './api.ts';
import GuestQuickTools from './GuestQuickTools.tsx';
import {safeTerminalPaste,terminalInputChunks} from './terminal-input.ts';
import {windowsPasteShortcut} from './windows/text-input.ts';
import WindowsTextTools from './windows/WindowsTextTools.tsx';
import GuestExchangePanel from './GuestExchangePanel.tsx';
import '@xterm/xterm/css/xterm.css';

export default function TerminalPanel({ environment, command = 'shell',active=true,quickTools='full' }: { environment: Environment; command?: 'shell' | 'claude';active?:boolean;quickTools?:'full'|'text' }) {
  const container = useRef<HTMLDivElement>(null);
  const surface=useRef<HTMLDivElement>(null);
  const session=useRef<{term:Terminal;socket?:WebSocket;ready:boolean;abort:AbortController}|null>(null);
  const visible=useRef(active);visible.current=active;
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('连接中');
  const [fullscreen,setFullscreen]=useState(false),[fullscreenBusy,setFullscreenBusy]=useState(false),[fullscreenError,setFullscreenError]=useState('');
  const nativeFullscreen=useRef(false),fullscreenEpoch=useRef(0);
  const [draft,setDraft]=useState(''),[textError,setTextError]=useState('');
  const draftComposing=useRef(false),draftValue=useRef('');const [composing,setComposing]=useState(false);
  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let waitTimer:ReturnType<typeof setTimeout>|undefined,cancelWait:(()=>void)|undefined;
    const term = new Terminal({ disableStdin:true,cursorBlink: true, fontSize: 13, fontFamily: window.__MU_CONFIG__?.platform==='win32'?'Consolas, monospace':'"SFMono-Regular", Menlo, monospace', theme: { background: '#181d20', foreground: '#e4e9e7', cursor: '#78bca2', selectionBackground: '#344c43', black: '#20272c', red: '#ee8f8c', green: '#87c8a4', yellow: '#e8c482', blue: '#8cb4d9', magenta: '#c3a8d9', cyan: '#82c4ca', white: '#e4e9e7' }, scrollback: 5000 });
    const current={term,ready:false,socket:undefined as WebSocket|undefined,abort:new AbortController()};session.current=current;setStatus('连接中');
    const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current); fit.fit();
    const observer = new ResizeObserver(() => { if (disposed||!visible.current||!container.current?.clientWidth||!container.current.clientHeight) return; fit.fit(); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); });
    observer.observe(container.current);
    const dataSubscription = term.onData(data => { if (!disposed&&session.current===current&&current.ready&&socket?.readyState === WebSocket.OPEN) for (const chunk of terminalInputChunks(data)) socket.send(JSON.stringify({ type: 'input', data: chunk })); });
    const getTicket=async()=>{
      const deadline=Date.now()+120000;
      while(!disposed&&session.current===current){
        try{return await api.terminalTicket(environment.id,command,Math.max(20,Math.min(300,term.cols)),Math.max(5,Math.min(100,term.rows)),current.abort.signal);}
        catch(error){if(disposed||session.current!==current||current.abort.signal.aborted||!(error instanceof ApiError)||error.code!=='OPERATION_IN_PROGRESS'||Date.now()>=deadline)throw error;
          setStatus('等待当前操作完成');await new Promise<void>(resolve=>{cancelWait=resolve;waitTimer=setTimeout(resolve,250);});}
      }
      return null;
    };
    void getTicket().then(value=>{
      if(!value)return;const {ticket}=value;
      if (disposed||session.current!==current) return;
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/terminal?ticket=${ticket}`);
      current.socket=socket;
      socket.onmessage = event => {
        if(disposed||session.current!==current)return;
        const message = JSON.parse(event.data);
        if (message.type === 'data') term.write(message.data);
        if (message.type === 'connected') { current.ready=true;term.options.disableStdin=false;setStatus('已连接'); if(visible.current)term.focus(); }
        if (message.type === 'error') { current.ready=false;term.options.disableStdin=true;setStatus('连接失败'); term.writeln(`\r\n${message.data}`); }
        if (message.type === 'exit') {current.ready=false;term.options.disableStdin=true;setStatus('已结束');}
      };
      socket.onclose = () => {current.ready=false;if (!disposed&&session.current===current){term.options.disableStdin=true;setStatus('已断开');} };
      socket.onerror = () => {current.ready=false;if (!disposed&&session.current===current){term.options.disableStdin=true;setStatus('连接失败');} };
    }).catch(error => { if (!disposed&&session.current===current) { setStatus('连接失败'); term.writeln(error.message); } });
    return () => {disposed=true;current.ready=false;current.abort.abort();if(session.current===current)session.current=null;clearTimeout(waitTimer);cancelWait?.();socket?.close();observer.disconnect();dataSubscription.dispose();term.dispose();};
  }, [environment.id, command, attempt]);
  // Retained hidden terminals still answer protocol queries. Blur user input,
  // but disable xterm's whole outgoing stream only while the session is unready.
  useEffect(()=>{const current=session.current;if(current&&!active)current.term.blur();},[active]);
  useEffect(()=>{
    const target=surface.current,epoch=++fullscreenEpoch.current;
    const changed=()=>setFullscreen(document.fullscreenElement===target);
    const unsubscribe=window.muWindowsDesktop?.onViewerFullscreenChange?.(value=>{if(fullscreenEpoch.current===epoch&&nativeFullscreen.current){nativeFullscreen.current=value;setFullscreen(value);}});
    document.addEventListener('fullscreenchange',changed);
    return()=>{fullscreenEpoch.current++;document.removeEventListener('fullscreenchange',changed);unsubscribe?.();if(nativeFullscreen.current){nativeFullscreen.current=false;void window.muWindowsDesktop?.setViewerFullscreen?.(false).catch(()=>{});}else if(target&&document.fullscreenElement===target)void document.exitFullscreen().catch(()=>{});};
  },[environment.id]);
  async function changeFullscreen(enabled:boolean){
    if(fullscreenBusy)return;const epoch=fullscreenEpoch.current,desktop=window.muWindowsDesktop;setFullscreenBusy(true);setFullscreenError('');
    try{
      if(desktop?.setViewerFullscreen){nativeFullscreen.current=enabled;const actual=await desktop.setViewerFullscreen(enabled);if(fullscreenEpoch.current===epoch){nativeFullscreen.current=actual;setFullscreen(actual);}}
      else if(enabled)await surface.current?.requestFullscreen();else if(document.fullscreenElement===surface.current)await document.exitFullscreen();
    }catch{if(fullscreenEpoch.current===epoch){setFullscreenError('全屏切换未完成，请重试。');if(nativeFullscreen.current){nativeFullscreen.current=false;void desktop?.setViewerFullscreen?.(false).catch(()=>{});}setFullscreen(false);}}
    finally{if(fullscreenEpoch.current===epoch)setFullscreenBusy(false);}
  }
  useEffect(()=>{if(!active&&fullscreen&&!fullscreenBusy)void changeFullscreen(false);},[active,fullscreen,fullscreenBusy]);
  useEffect(()=>{
    if(!fullscreen)return;
    const escape=(event:KeyboardEvent)=>{if(event.key!=='Escape'||event.isComposing||event.keyCode===229||[...document.querySelectorAll<HTMLElement>('.guest-input-floating,.guest-translation-expanded,.modal-backdrop')].some(node=>node.getClientRects().length))return;event.preventDefault();event.stopImmediatePropagation();void changeFullscreen(false);};
    window.addEventListener('keydown',escape,true);return()=>window.removeEventListener('keydown',escape,true);
  },[fullscreen,fullscreenBusy]);
  function reconnect(){const current=session.current;if(current){current.ready=false;current.term.options.disableStdin=true;current.term.blur();current.abort.abort();current.socket?.close();session.current=null;}setStatus('连接中');setAttempt(n=>n+1);}
  function currentSession(){const current=session.current;if(!visible.current||!current?.ready||current.socket?.readyState!==WebSocket.OPEN)throw new Error('当前终端未连接或已切换，文字已保留，请返回后重试。');return current;}
  async function paste(text:string){const current=currentSession();const value=safeTerminalPaste(text,current.term.modes.bracketedPasteMode);current.term.focus();current.term.paste(value);}
  async function readText(){return currentSession().term.getSelection();}
  function sendKey(key:'backspace'|'enter'){try{const current=currentSession();current.term.focus();current.socket!.send(JSON.stringify({type:'input',data:key==='enter'?'\r':'\x7f'}));}catch{/* Disconnected controls are disabled. */}}
  function editDraft(value:string){draftValue.current=value;setDraft(value);}
  function pasteDraft(){if(draftComposing.current)return;const sent=draftValue.current;if(!sent)return;setTextError('');void paste(sent).then(()=>{if(draftValue.current===sent&&!draftComposing.current){draftValue.current='';setDraft('');}},error=>setTextError(error.message));}
  return <div className={`terminal-tool${fullscreen?' terminal-fullscreen':''}`} ref={surface}>
    <div className="terminal-header"><span>{command === 'claude' ? <Bot size={16} /> : <TerminalSquare size={16} />} {environment.name}<span className="terminal-path">{environment.mounts[0]?.guestPath ?? '/workspace'}</span></span><span className="terminal-actions"><span className="terminal-connection" role="status"><Circle size={7} fill={status === '已连接' ? '#87c8a4' : '#8b969a'} /> {status}</span>{quickTools==='text'&&window.__MU_CONFIG__?.platform==='win32'&&window.__MU_CONFIG__.capabilities?.files&&<GuestExchangePanel key={environment.id+':'+command} id={environment.id} active={active} connected={status==='已连接'} dropTarget={surface} onPasteText={paste} onReadText={readText} onReturn={()=>{if(visible.current)session.current?.term.focus();}}/>}{quickTools==='text'&&window.__MU_CONFIG__?.platform==='win32'&&window.__MU_CONFIG__.capabilities?.translation&&<WindowsTextTools key={command} id={environment.id} connected={active&&status==='已连接'} terminal onPaste={async(value,signal)=>{signal.throwIfAborted();await paste(value);}} onReadText={readText} onKey={sendKey}/ >}{quickTools==='full'&&<GuestQuickTools key={environment.id+':'+command} id={environment.id} active={active} connected={status==='已连接'} dropTarget={surface} terminal onPaste={paste} onReadText={readText} onKey={sendKey} onReturn={()=>{if(visible.current)session.current?.term.focus();}}/>}<button className="icon-button dark" title="重新连接" aria-label="重新连接终端" onClick={reconnect}><RotateCw size={15} /></button><button type="button" className="icon-button dark" title={fullscreen?'退出全屏 · Esc':'全屏终端'} aria-label={fullscreen?'退出全屏终端':'全屏终端'} aria-pressed={fullscreen} disabled={fullscreenBusy} onClick={()=>void changeFullscreen(!fullscreen)}>{fullscreen?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button></span></div>
    {fullscreenError&&<p className="terminal-fullscreen-error" role="alert">{fullscreenError}</p>}
    <div className="terminal-container" ref={container} />
    {quickTools==='text'&&<div className="windows-terminal-input"><label>中文与多行输入<textarea aria-label="终端待粘贴文字" value={draft} maxLength={65536} onChange={event=>editDraft(event.target.value)} onCompositionStart={()=>{draftComposing.current=true;setComposing(true);}} onCompositionEnd={event=>{draftComposing.current=false;setComposing(false);editDraft(event.currentTarget.value);}} onKeyDown={event=>{if(windowsPasteShortcut(event.nativeEvent,draftComposing.current)){event.preventDefault();pasteDraft();}}}/></label><button type="button" className="button" disabled={!active||status!=='已连接'||!draft||composing} onClick={pasteDraft}>粘贴到终端</button><small>仅粘贴文字，不自动执行。Ctrl+Enter 粘贴；候选选字时不会触发。</small>{textError&&<p role="alert">{textError}</p>}</div>}
  </div>;
}
