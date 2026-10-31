import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AppError} from '../../errors.ts';
import type {RunOptions} from '../../process.ts';
import {transferZone,transferPath} from '../../guest-exchange.ts';
import {ENSURE_FILE_MANAGER} from '../../guest-file-manager.ts';
import type {WindowsBrowserRuntime} from './browser.ts';
import {WindowsDisplayLifecycle,type WindowsDisplayLease,type WindowsPreparedDisplay,type WindowsDisplayManagerPort} from './display-lifecycle.ts';

export const windowsFileViewRequest=z.object({zone:transferZone,path:transferPath.default('')}).strict();
export const windowsFileViewClose=z.object({viewId:z.uuid()}).strict();
type Folder=z.infer<typeof windowsFileViewRequest>;
type Manager=WindowsDisplayManagerPort&{failProtection(id:string,reason:string):Promise<void>};
type Session=NonNullable<ReturnType<Manager['sessions']['get']>>;
type Options=RunOptions&{assertCurrent():void};
export interface WindowsFileDisplayDriver {
 prepare(entry:WindowsPreparedDisplay,options:Options):Promise<void>;
 open(id:string,input:Folder,unit:string,options:Options):Promise<{ok:boolean;path:string}>;
 stop(entry:WindowsPreparedDisplay,unit:string):Promise<void>;
}
interface View {id:string;viewId:string;unit:string;session:Session;controller:AbortController;entry?:WindowsPreparedDisplay;lease?:WindowsDisplayLease;attempted:boolean;ready:boolean;closing?:Promise<void>}

// One file viewer per environment. Only the returned view capability can close
// it; delayed cleanup from an earlier UI cannot close a replacement viewer.
export class WindowsFileDisplay {
 readonly manager:Manager;readonly display:WindowsDisplayLifecycle;readonly driver:WindowsFileDisplayDriver;
 private views=new Map<string,View>();private pending=new Map<string,{controller:AbortController;promise:Promise<unknown>}>();private disposed=false;private unsubscribe:()=>void;
 constructor(manager:Manager,display:WindowsDisplayLifecycle,driver:WindowsFileDisplayDriver){this.manager=manager;this.display=display;this.driver=driver;this.unsubscribe=display.subscribeRevoked(id=>{const view=this.views.get(id);if(view?.entry&&!view.closing){view.ready=false;view.controller.abort();}});}
 private same(view:View){return this.manager.sessions.get(view.id)===view.session&&view.session.state==='active';}
 private assert(view:View,signal?:AbortSignal){signal?.throwIfAborted();if(this.disposed||!this.same(view)||this.views.get(view.id)!==view||this.manager.store.get(view.id).state!=='running'||view.entry&&this.display.readyEntry(view.id)!==view.entry)throw new AppError('文件画面会话已变化，请重新打开',409,'FILE_DISPLAY_CHANGED');}
 private cleanup(view:View):Promise<void>{
  if(view.closing)return view.closing;view.ready=false;view.controller.abort();
  return view.closing=Promise.resolve().then(async()=>{
   try{
    if(!this.disposed&&view.attempted&&view.entry&&this.same(view))await this.driver.stop(view.entry,view.unit);
    if(view.lease)await this.display.release(view.lease);
   }catch(error){
    if(this.same(view))try{await this.manager.failProtection(view.id,'文件管理器停止尚未确认');}catch{/* Preserve the stop failure. */}
    const failure=new AppError('文件画面关闭尚未确认，环境访问已撤销',409,'FILE_DISPLAY_STOP_UNCONFIRMED');failure.cause=error;throw failure;
   }finally{if(this.views.get(view.id)===view)this.views.delete(view.id);}
  });
 }
 open(id:string,input:unknown,options:RunOptions={}){
  const folder=windowsFileViewRequest.parse(input);options.signal?.throwIfAborted();
  if(this.disposed)throw new AppError('文件画面正在退出',409,'CLOSING');if(this.pending.has(id))throw new AppError('文件画面正在处理中',409,'FILE_DISPLAY_BUSY');
  const session=this.manager.sessions.get(id);if(!session||session.state!=='active')throw new AppError('请先启动并核验环境',409,'FILE_DISPLAY_CHANGED');
  const controller=new AbortController(),signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
  let view:View|undefined;
  const promise=Promise.resolve().then(async()=>{
   const previous=this.views.get(id);if(previous)await this.cleanup(previous);
   signal.throwIfAborted();if(this.disposed||this.manager.sessions.get(id)!==session||session.state!=='active')throw new AppError('文件画面会话已变化',409,'FILE_DISPLAY_CHANGED');
   view={id,viewId:randomUUID(),unit:'mucodesandbox-file-manager-'+randomUUID(),session,controller,attempted:false,ready:false};this.views.set(id,view);
   const assertCurrent=()=>this.assert(view!,signal),run={...options,signal,onOutput:undefined,assertCurrent};
   await this.manager.assertAccess(id);assertCurrent();
   view.lease=await this.display.acquire(id,'files',run);view.entry=this.display.readyEntry(id);assertCurrent();if(!view.entry)throw new AppError('文件画面尚未准备',409,'DISPLAY_NOT_READY');
   await this.driver.prepare(view.entry,run);assertCurrent();
   await this.manager.assertAccess(id);await this.display.assertProtection(id);assertCurrent();view.attempted=true;
   const result=await this.driver.open(id,folder,view.unit,run);assertCurrent();view.ready=true;
   return {ok:true as const,path:result.path,viewId:view.viewId};
  }).catch(async error=>{if(view)await this.cleanup(view);throw error;}).finally(()=>{if(this.pending.get(id)?.controller===controller)this.pending.delete(id);});
  this.pending.set(id,{controller,promise});return promise;
 }
 async close(id:string,viewId:string){
  windowsFileViewClose.parse({viewId});const view=this.views.get(id);if(!view||view.viewId!==viewId)return {closed:true as const};
  const operation=this.pending.get(id),pending=operation?.controller===view.controller?operation.promise:undefined;if(pending)operation!.controller.abort();
  if(pending)try{await pending;}catch(error){if(error instanceof AppError&&['FILE_DISPLAY_STOP_UNCONFIRMED','DISPLAY_STOP_UNCONFIRMED'].includes(error.code??''))throw error;}
  await this.cleanup(view);return {closed:true as const};
 }
 info(id:string){const view=this.views.get(id);return {ready:!!view?.ready&&this.same(view)&&this.display.readyEntry(id)===view.entry,viewId:view?.viewId};}
 revoke(id:string){this.pending.get(id)?.controller.abort();const view=this.views.get(id);if(view){view.ready=false;view.controller.abort();}}
 dispose(){if(this.disposed)return;this.disposed=true;this.unsubscribe();for(const id of this.pending.keys())this.revoke(id);for(const view of this.views.values()){view.ready=false;view.controller.abort();}this.views.clear();}
}

export function windowsFileDisplayStopProgram(unit:string){
 if(!/^mucodesandbox-file-manager-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(unit))throw new AppError('文件画面凭据无效',400,'FILE_DISPLAY_INVALID');
 return `import json,subprocess
unit=${JSON.stringify(unit)}
keys=['LoadState','ActiveState','MainPID','User','Group','BindsTo']
def inspect():
 result=subprocess.run(['systemctl','show',unit,'--no-pager']+['--property='+key for key in keys],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=5)
 if len(result.stdout)>4096:raise RuntimeError('Invalid file service receipt')
 values={}
 for line in result.stdout.decode('ascii').splitlines():
  key,sep,value=line.partition('=')
  if not sep or key not in keys or key in values:raise RuntimeError('Invalid file service properties')
  values[key]=value
 if set(values)!=set(keys):raise RuntimeError('Missing file service properties')
 if values['LoadState']=='not-found':
  if values['ActiveState']!='inactive' or values['MainPID']!='0':raise RuntimeError('Unexpected missing file service')
 elif result.returncode or values['User']!='dev' or values['Group']!='dev' or 'mucodesandbox-display.service' not in values['BindsTo'].split():raise RuntimeError('File service ownership changed')
 return values
before=inspect()
if before['LoadState']!='not-found':subprocess.run(['systemctl','stop',unit],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20,check=True)
after=inspect()
if after['ActiveState'] not in ('inactive','failed') or after['MainPID']!='0':raise RuntimeError('File service stop unconfirmed')
print(json.dumps({'version':1,'state':'stopped'}))
`;
}
export function createWindowsFileDisplayDriver(runtime:Pick<WindowsBrowserRuntime,'management'>,open:WindowsFileDisplayDriver['open']):WindowsFileDisplayDriver{
 return {prepare:async(entry,options)=>{options.assertCurrent();await runtime.management(entry.config,['bash','-s'],{...options,input:ENSURE_FILE_MANAGER,timeoutMs:120000,maxBytes:4096});options.assertCurrent();},open,
  stop:async(entry,unit)=>{const raw=await runtime.management(entry.config,['sudo','-n','/usr/bin/python3','-I','-c',windowsFileDisplayStopProgram(unit)],{timeoutMs:30000,maxBytes:2048,onOutput:undefined});try{if(Buffer.byteLength(raw)>2048)throw Error();z.object({version:z.literal(1),state:z.literal('stopped')}).strict().parse(JSON.parse(raw));}catch{throw new AppError('文件管理器停止回执无法核对',409,'FILE_DISPLAY_STOP_UNCONFIRMED');}}
 };
}
