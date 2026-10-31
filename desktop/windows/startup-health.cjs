'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const names=new Set(['navigation-start','navigation-failed','navigation-superseded','load-event-failed','dom-ready','load-finished','ui-dom-content','ui-content-pending','renderer-gone','preload-error','unresponsive','responsive','renderer-console','worker-phase','window-state']);
const phases=new Set(['checking','building','installing','authorizing','connecting','initializing']);
const triggers=new Set(['ready-to-show','show','hide','focus','blur','minimize','restore','dom-followup']);
function createStartupHealth({write,windowState=()=>({}),clock=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout}){
 const started=clock();let sequence=0,kind='status',timer,windowTimer,reported=false,count=0;
 function note(name,fields={}){
  if(!names.has(name)||count>=256)return;
  const value={version:1,event:name,navigation:sequence,kind,elapsedMs:Math.max(0,Math.round(clock()-started))};
  if(Number.isInteger(fields.code)&&Math.abs(fields.code)<=2147483647)value.code=fields.code;
  if(Number.isSafeInteger(fields.requestNavigation)&&fields.requestNavigation>0)value.requestNavigation=fields.requestNavigation;
  if(typeof fields.mainFrame==='boolean')value.mainFrame=fields.mainFrame;
  if(['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure'].includes(fields.reason))value.reason=fields.reason;
  if(['TypeError','ReferenceError','SyntaxError','RangeError','Error','module-load','csp','other'].includes(fields.category))value.category=fields.category;
  if(phases.has(fields.phase))value.phase=fields.phase;
  if(triggers.has(fields.trigger))value.trigger=fields.trigger;
  // Native window facts help investigate DOM-ready but blank startup. They do
  // not attest that any pixels were painted. Never retain text, URLs or pixels.
  try{const state=windowState();for(const key of ['visible','focused','minimized','loadingMainFrame','backgroundThrottling'])if(typeof state?.[key]==='boolean')value[key]=state[key];for(const key of ['contentWidth','contentHeight'])if(Number.isInteger(state?.[key])&&state[key]>=0&&state[key]<=65535)value[key]=state[key];}catch{/* Window teardown or diagnostic failure cannot affect the application. */}
  count++;try{write(value);}catch{/* Diagnostics cannot obstruct startup or shutdown. */}
 }
 function begin(next){
  if(!['status','workspace'].includes(next))throw Error('Unknown startup navigation');
  cancel(timer);cancel(windowTimer);kind=next;reported=false;sequence++;note('navigation-start');
  if(kind==='workspace'){const current=sequence;timer=schedule(()=>{if(current===sequence&&!reported)note('ui-content-pending');},15000);timer?.unref?.();}
  return sequence;
 }
 function loadFailed(navigation,error){note(navigation===sequence?'navigation-failed':'navigation-superseded',{code:Number.isInteger(error?.errno)?error.errno:undefined,requestNavigation:navigation});}
 function rendered(event,window,origin){
  if(reported||kind!=='workspace'||!window||window.isDestroyed()||!origin)return false;
  const web=window.webContents;
  try{const url=new URL(event.senderFrame?.url);if(event.sender!==web||event.senderFrame!==web.mainFrame||url.origin!==origin||url.pathname!=='/')return false;}catch{return false;}
  reported=true;cancel(timer);note('ui-dom-content');const current=sequence;
  windowTimer=schedule(()=>{if(current===sequence)note('window-state',{trigger:'dom-followup'});},5000);windowTimer?.unref?.();return true;
 }
 function consoleCategory(message){return ['TypeError','ReferenceError','SyntaxError','RangeError'].find(value=>String(message).includes(value))||(/Content Security Policy|script-src/i.test(String(message))?'csp':/module script|dynamically imported module/i.test(String(message))?'module-load':'other');}
 return {begin,note,loadFailed,rendered,consoleCategory,dispose(){cancel(timer);cancel(windowTimer);}};
}
function startupFileWriter(directory){
 let file;
 return value=>{
  if(!file){fs.mkdirSync(directory,{recursive:true});file=path.join(directory,'startup-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.jsonl');fs.writeFileSync(file,'',{flag:'wx',mode:0o600});}
  fs.appendFileSync(file,JSON.stringify(value)+'\n');
 };
}
module.exports={createStartupHealth,startupFileWriter};
