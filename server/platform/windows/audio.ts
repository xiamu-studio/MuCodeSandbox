import {spawn} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {GuestAudioHost,type GuestAudioCapture,type GuestAudioSession} from '../../guest-audio.ts';
import {AppError} from '../../errors.ts';
import type {WindowsConfig} from './config.ts';
import type {HyperVRuntime} from './runtime.ts';
import type {WindowsManager} from './manager.ts';
import type {WindowsDisplayLifecycle} from './display-lifecycle.ts';

export interface WindowsAudioLaunch {file:string;args:string[];env:NodeJS.ProcessEnv;cwd:string}
interface AudioSession extends GuestAudioSession {config:WindowsConfig;sessionId:string;closed?:boolean}
export interface WindowsAudioSource {entries:Pick<ReadonlyMap<string,AudioSession>,'get'>;assertProtection(id:string):Promise<unknown>;subscribeRevoked?(listener:(id:string)=>void):()=>void}

export function windowsDisplayAudioSource(display:WindowsDisplayLifecycle):WindowsAudioSource{
 return {entries:{get:id=>display.readyEntry(id)},assertProtection:id=>display.assertProtection(id),subscribeRevoked:listener=>display.subscribeRevoked(listener)};
}

// The caller supplies audioLaunch's fixed dev/parec command. Closing stdin or
// the authenticated Hyper-V channel also terminates the guest reader.
export function createWindowsAudioCapture(launch:WindowsAudioLaunch):GuestAudioCapture {
 const child=spawn(launch.file,launch.args,{env:launch.env,cwd:launch.cwd,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
 const stream=new PassThrough({highWaterMark:64*1024});child.stdout.pipe(stream);child.stderr.resume();child.stdin.on('error',()=>{});
 let exited=false,stopping:Promise<void>|undefined,force:ReturnType<typeof setTimeout>|undefined;
 const closed=new Promise<void>(resolve=>child.once('close',code=>{exited=true;clearTimeout(force);if(code&&!stopping)stream.destroy(Error('客体音频连接已结束'));else stream.end();resolve();}));
 child.once('error',()=>stream.destroy(Error('客体音频连接无法启动')));
 const stop=()=>stopping??=(async()=>{
  child.stdout.unpipe(stream);stream.destroy();child.stdin.end();
  if(!exited){child.kill();force=setTimeout(()=>{if(!exited)child.kill('SIGKILL');},2000);force.unref();}
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([closed,new Promise<never>((_resolve,reject)=>{deadline=setTimeout(()=>reject(Error('音频采集进程退出尚未确认')),5000);deadline.unref();})]);}
  finally{clearTimeout(deadline);}
 })();
 stream.once('close',()=>{void stop().catch(()=>{});});
 return {stream,stop};
}

export class WindowsGuestAudio {
 readonly host:GuestAudioHost;
 private readonly prepared=new WeakMap<GuestAudioSession,WindowsAudioLaunch>();
 private readonly unsubscribeRevoked?:()=>void;
 readonly manager:Pick<WindowsManager,'assertAccess'|'sessions'>;readonly browser:WindowsAudioSource;readonly runtime:Pick<HyperVRuntime,'audioLaunch'>;
 constructor(manager:Pick<WindowsManager,'assertAccess'|'sessions'>,browser:WindowsAudioSource,runtime:Pick<HyperVRuntime,'audioLaunch'>){
  this.manager=manager;this.browser=browser;this.runtime=runtime;
  this.host=new GuestAudioHost({getSession:id=>this.current(id),authorize:async session=>{await manager.assertAccess(session.environment.id,true);await browser.assertProtection(session.environment.id);},capture:session=>{const launch=this.prepared.get(session);if(!launch)throw new AppError('音频会话已变化，请重新开启声音',409,'AUDIO_SESSION_CHANGED');return createWindowsAudioCapture(launch);}});
  this.unsubscribeRevoked=browser.subscribeRevoked?.(id=>this.revoke(id));
 }
 private current(id:string){const entry=this.browser.entries.get(id),protection=this.manager.sessions.get(id);return entry?.ready&&!entry.closed&&protection?.id===entry.sessionId&&protection.state==='active'?entry:undefined;}
 async issue(id:string){
  const session=this.current(id);if(this.host.disposed||!session)throw new AppError('请先连接 Linux 浏览器',409,'BROWSER_NOT_READY');
  if(this.host.peers.get(id)?.size||this.host.pending.has(session))throw new AppError('浏览器音频已在播放，请先关闭原播放连接',409,'AUDIO_BUSY');
  // Preparing arguments creates no capture. Full guard/sandbox checks remain
  // at ticket issuance and again at the WebSocket upgrade boundary.
  const launch=await this.runtime.audioLaunch(session.config);
  if(this.host.disposed||this.current(id)!==session)throw new AppError('音频会话已变化，请重新开启声音',409,'AUDIO_SESSION_CHANGED');
  this.prepared.set(session,launch);return this.host.issue(id);
 }
 revoke(id:string){this.host.revoke(id);}
 dispose(){this.unsubscribeRevoked?.();return this.host.dispose();}
}
