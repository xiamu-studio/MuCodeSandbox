'use strict';
const {fork}=require('node:child_process');
const {EventEmitter}=require('node:events');
const {launchOrigin,workerEnvironment}=require('./policy.cjs');
function createController(options){
 const events=new EventEmitter(),child=fork(options.entry,[],{execPath:options.node,execArgv:[],cwd:options.rootDir,windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:workerEnvironment(process.env,options.environment||{})});
 let settled=false,closed=false,closing,resolveReady,rejectReady,stopResolve,stopReject,readySeen=false,stopConfirmed=false;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const startup=setTimeout(()=>{if(!settled){settled=true;rejectReady(Error('Windows 管理服务启动超时'));void close().catch(()=>{});}},240000);startup.unref();
 let errors='';child.stderr.on('data',chunk=>{errors=(errors+chunk.toString()).slice(-4096);});
 child.on('message',value=>{
  if(!value||typeof value!=='object'||value.version!==1)return;
  if(value.type==='status'&&typeof value.phase==='string')events.emit('status',value.phase);
  if(value.type==='ready'&&!settled){try{if(value.pid!==child.pid)throw Error('Windows worker identity changed');const origin=launchOrigin(value.url);settled=true;readySeen=true;clearTimeout(startup);resolveReady({url:value.url,origin,pid:child.pid});}catch(error){settled=true;clearTimeout(startup);rejectReady(error);}}
  if(value.type==='error'&&!settled){settled=true;clearTimeout(startup);rejectReady(Error(typeof value.message==='string'?value.message:'Windows 服务启动失败'));}
  if(value.type==='stopped'){stopConfirmed=true;stopResolve?.();}
  if(value.type==='stop-error')stopReject?.(Error(value.message||'无法确认环境已停止'));
 });
 child.once('error',error=>{if(!settled){settled=true;clearTimeout(startup);rejectReady(error);}stopReject?.(error);events.emit('failure',error);});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{closed=true;clearTimeout(startup);if(!settled){settled=true;const detail=errors.match(/Error(?: \[[^\]]+\])?:[^\r\n]*/)?.[0];rejectReady(Error('Windows 管理进程在就绪前退出'+(detail?'；'+detail.slice(0,600).replace(/https?:\/\/\S+/g,'[URL]'):'')));}if(closing&&!stopConfirmed&&readySeen)stopReject?.(Error('管理进程退出，尚未收到环境停机确认'));events.emit('exit',{code,signal});resolve();}));
 function send(value){if(child.connected)child.send({version:1,...value},()=>{});}
 function close(){if(closing)return closing;if(closed)return !readySeen||stopConfirmed?Promise.resolve():Promise.reject(Error('管理进程已退出，尚未确认环境停机'));let deadline;const stopped=new Promise((resolve,reject)=>{stopResolve=resolve;stopReject=reject;exited.then(()=>{if(!readySeen)resolve();});});closing=Promise.race([(async()=>{send({type:'shutdown'});await stopped;await exited;})(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('停止环境超时，尚未确认关闭')),90000);deadline.unref();})]).finally(()=>{clearTimeout(deadline);stopResolve=undefined;stopReject=undefined;}).catch(error=>{closing=undefined;throw error;});return closing;}
 send({type:'start',rootDir:options.rootDir});
 return {events,ready,close,exited,get pid(){return child.pid;},terminate(){if(!closed)child.kill('SIGKILL');}};
}
module.exports={createController};
