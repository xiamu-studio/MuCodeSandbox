import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {AppError,SshProcessError} from '../../errors.ts';
import type {Runner} from '../../process.ts';

// SSH stdout carries JSON, base64 and exact guest bytes. Windows OpenSSH can
// emit a socket-close diagnostic on stderr even when the remote command exits
// successfully. Keep diagnostics observable without adding them to that data.
export const runWindowsSsh:Runner=(file,args,options={})=>new Promise((resolve,reject)=>{
 if(options.signal?.aborted){reject(new AppError('操作已取消',409,'CANCELLED'));return;}
 const timeoutMs=options.timeoutMs??30000,maxBytes=options.maxBytes??4_000_000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>86400000||!Number.isSafeInteger(maxBytes)||maxBytes<0){reject(new AppError('SSH 任务限制无效',400,'INVALID_SSH_LIMIT'));return;}
 const child=spawn(file,args,{env:options.env,cwd:options.cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']}),stdout=new StringDecoder('utf8'),stderr=new StringDecoder('utf8');
 let data='',diagnostics='',bytes=0,reason:Error|undefined,settled=false,force:ReturnType<typeof setTimeout>|undefined;
 const finish=(error?:Error,code?:number|null)=>{
  if(settled)return;settled=true;clearTimeout(deadline);clearTimeout(force);options.signal?.removeEventListener('abort',abort);
  const tail=stdout.end();data+=tail;diagnostics=(diagnostics+stderr.end()).slice(-65536);
  if(error)reject(error);else if(code!==0)reject(new SshProcessError((diagnostics||data).trim().slice(-4000)||`SSH 任务失败（${code}）`,code??null));else resolve(data);
 };
 const stop=(error:Error)=>{
  if(settled||reason)return;reason=error;child.kill('SIGTERM');
  // Closing inherited pipes is bounded; completion still waits for the real
  // child close event rather than inferring process exit from this deadline.
  force=setTimeout(()=>{if(settled)return;child.kill('SIGKILL');child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();},2500);force.unref();
 };
 const abort=()=>stop(new AppError('操作已取消',409,'CANCELLED'));
 const deadline=setTimeout(()=>stop(new AppError('SSH 操作超时，请检查日志和网络连接',504,'TIMEOUT')),timeoutMs);
 options.signal?.addEventListener('abort',abort,{once:true});
 const report=(text:string)=>{if(!text||!options.onOutput||reason)return;try{options.onOutput(text);}catch{stop(new AppError('处理 SSH 运行输出失败，请查看任务状态后重试',500,'PROCESS_OUTPUT_HANDLER_FAILED'));}};
 child.stdout.on('data',(part:Buffer)=>{bytes+=part.length;if(bytes>maxBytes){stop(new AppError('SSH 返回数据超过限制',413,'PROCESS_OUTPUT_TOO_LARGE'));return;}const text=stdout.write(part);data+=text;report(text);});
 child.stderr.on('data',(part:Buffer)=>{const text=stderr.write(part);diagnostics=(diagnostics+text).slice(-65536);report(text);});
 child.stdin.on('error',()=>stop(new AppError('传入数据时 SSH 连接已关闭，请刷新确认保存结果',502,'PROCESS_INPUT_CLOSED')));
 child.on('error',error=>{if(!settled)reason??=error;});child.once('close',code=>finish(reason,code));
 child.stdin.end(options.inputBytes??options.input);
});
