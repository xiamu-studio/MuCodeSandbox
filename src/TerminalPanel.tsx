import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RotateCw, TerminalSquare, Bot, Circle } from 'lucide-react';
import type { Environment } from '../shared/types.ts';
import { api,ApiError } from './api.ts';
import GuestQuickTools from './GuestQuickTools.tsx';
import {safeTerminalPaste,terminalInputChunks} from './terminal-input.ts';
import '@xterm/xterm/css/xterm.css';

export default function TerminalPanel({ environment, command = 'shell',active=true }: { environment: Environment; command?: 'shell' | 'claude';active?:boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const surface=useRef<HTMLDivElement>(null);
  const session=useRef<{term:Terminal;socket?:WebSocket;ready:boolean}|null>(null);
  const visible=useRef(active);visible.current=active;
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState('连接中');
  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let waitTimer:ReturnType<typeof setTimeout>|undefined,cancelWait:(()=>void)|undefined;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: '"SFMono-Regular", Menlo, monospace', theme: { background: '#181d20', foreground: '#e4e9e7', cursor: '#78bca2', selectionBackground: '#344c43', black: '#20272c', red: '#ee8f8c', green: '#87c8a4', yellow: '#e8c482', blue: '#8cb4d9', magenta: '#c3a8d9', cyan: '#82c4ca', white: '#e4e9e7' }, scrollback: 5000 });
    const current={term,ready:false,socket:undefined as WebSocket|undefined};session.current=current;setStatus('连接中');
    const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current); fit.fit();
    const observer = new ResizeObserver(() => { if (disposed||!visible.current||!container.current?.clientWidth||!container.current.clientHeight) return; fit.fit(); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); });
    observer.observe(container.current);
    const dataSubscription = term.onData(data => { if (socket?.readyState === WebSocket.OPEN) for (const chunk of terminalInputChunks(data)) socket.send(JSON.stringify({ type: 'input', data: chunk })); });
    const getTicket=async()=>{
      const deadline=Date.now()+120000;
      while(!disposed){
        try{return await api.terminalTicket(environment.id,command,Math.max(20,Math.min(300,term.cols)),Math.max(5,Math.min(100,term.rows)));}
        catch(error){if(!(error instanceof ApiError)||error.code!=='OPERATION_IN_PROGRESS'||Date.now()>=deadline)throw error;
          setStatus('等待当前操作完成');await new Promise<void>(resolve=>{cancelWait=resolve;waitTimer=setTimeout(resolve,250);});}
      }
      return null;
    };
    void getTicket().then(value=>{
      if(!value)return;const {ticket}=value;
      if (disposed) return;
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/terminal?ticket=${ticket}`);
      current.socket=socket;
      socket.onmessage = event => {
        if(disposed)return;
        const message = JSON.parse(event.data);
        if (message.type === 'data') term.write(message.data);
        if (message.type === 'connected') { current.ready=true;setStatus('已连接'); if(visible.current)term.focus(); }
        if (message.type === 'error') { current.ready=false;setStatus('连接失败'); term.writeln(`\r\n${message.data}`); }
        if (message.type === 'exit') {current.ready=false;setStatus('已结束');}
      };
      socket.onclose = () => {current.ready=false;if (!disposed) setStatus('已断开'); };
      socket.onerror = () => {current.ready=false;if (!disposed) setStatus('连接失败'); };
    }).catch(error => { if (!disposed) { setStatus('连接失败'); term.writeln(error.message); } });
    return () => {disposed=true;current.ready=false;if(session.current===current)session.current=null;clearTimeout(waitTimer);cancelWait?.();socket?.close();observer.disconnect();dataSubscription.dispose();term.dispose();};
  }, [environment.id, command, attempt]);
  function currentSession(){const current=session.current;if(!visible.current||!current?.ready||current.socket?.readyState!==WebSocket.OPEN)throw new Error('当前终端未连接或已切换，文字已保留，请返回后重试。');return current;}
  async function paste(text:string){const current=currentSession();const value=safeTerminalPaste(text,current.term.modes.bracketedPasteMode);current.term.focus();current.term.paste(value);}
  async function readText(){return currentSession().term.getSelection();}
  function sendKey(key:'backspace'|'enter'){try{const current=currentSession();current.term.focus();current.socket!.send(JSON.stringify({type:'input',data:key==='enter'?'\r':'\x7f'}));}catch{/* Disconnected controls are disabled. */}}
  return <div className="terminal-tool" ref={surface}>
    <div className="terminal-header"><span>{command === 'claude' ? <Bot size={16} /> : <TerminalSquare size={16} />} {environment.name}<span className="terminal-path">{environment.mounts[0]?.guestPath ?? '/workspace'}</span></span><span className="terminal-actions"><span className="terminal-connection" role="status"><Circle size={7} fill={status === '已连接' ? '#87c8a4' : '#8b969a'} /> {status}</span><GuestQuickTools key={environment.id+':'+command} id={environment.id} active={active} connected={status==='已连接'} dropTarget={surface} terminal onPaste={paste} onReadText={readText} onKey={sendKey} onReturn={()=>{if(visible.current)session.current?.term.focus();}}/><button className="icon-button dark" title="重新连接" aria-label="重新连接终端" onClick={() => setAttempt(n => n + 1)}><RotateCw size={15} /></button></span></div>
    <div className="terminal-container" ref={container} />
  </div>;
}
