import {fork} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import type {IPty,IWindowsPtyForkOptions} from 'node-pty';

export type TerminalPty=Pick<IPty,'write'|'resize'|'kill'|'onData'|'onExit'>;

// Own native ConPTY handles in a disposable process. Some ConPTY versions keep
// a reader worker alive after the shell exits. The controller never loads that
// binding, and both normal exit and loss of the owning IPC channel are bounded.
export function spawnWindowsTerminal(file:string,args:string[],options:IWindowsPtyForkOptions):TerminalPty&{pid:number}{
 const worker=new URL(import.meta.url.endsWith('.ts')?'./terminal-worker.ts':'./terminal-worker.js',import.meta.url);
 const child=fork(fileURLToPath(worker),[],{execArgv:[],windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}});
 child.stderr?.resume();const events=new EventEmitter();let finished=false,stopping=false,exitCode=1,force:ReturnType<typeof setTimeout>|undefined;
 const finish=(code:number)=>{if(finished)return;finished=true;clearTimeout(force);events.emit('exit',{exitCode:code});};
 const send=(message:object)=>{if(finished||!child.connected)return;try{child.send(message,()=>{});}catch{kill();}};
 const kill=()=>{if(stopping||finished)return;stopping=true;send({type:'stop'});force=setTimeout(()=>child.kill('SIGKILL'),2000);force.unref();};
 child.on('message',(raw:unknown)=>{
  if(!raw||typeof raw!=='object'||!('type' in raw))return;
  const message=raw as {type:string;data?:unknown;exitCode?:unknown};
  if(message.type==='data'&&typeof message.data==='string'&&message.data.length<=65536)events.emit('data',message.data);
  if(message.type==='exit'&&typeof message.exitCode==='number')exitCode=message.exitCode;
 });
 child.once('error',()=>{events.emit('data','\r\nWindows 终端组件启动失败，请检查安装。\r\n');finish(1);});
 child.once('exit',code=>finish(code===0?exitCode:code??1));
 send({type:'start',file,args,options});
 return {pid:child.pid??0,write:data=>send({type:'input',data}),resize:(cols,rows)=>send({type:'resize',cols,rows}),kill,
  onData:fn=>{events.on('data',fn);return{dispose:()=>{events.off('data',fn);}};},onExit:fn=>{events.on('exit',fn);return{dispose:()=>{events.off('exit',fn);}};}};
}
