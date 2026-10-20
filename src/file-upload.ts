import {ApiError} from './api.ts';
import type {SavedTransferFile} from '../shared/guest-exchange.ts';

export function uploadGuestFile(id:string,file:File,onProgress:(sent:number,total:number)=>void,signal:AbortSignal):Promise<SavedTransferFile>{
 return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();let settled=false;
  const finish=(error?:Error,value?:SavedTransferFile)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);if(error)reject(error);else resolve(value!);};
  const abort=()=>{xhr.abort();finish(new ApiError('传输已中断；请刷新下载目录确认文件，再决定是否重试。',409,'TRANSFER_CANCELLED'));};
  if(signal.aborted){abort();return;}
  xhr.open('POST',`/api/environments/${encodeURIComponent(id)}/transfer-files?name=${encodeURIComponent(file.name)}`);
  xhr.setRequestHeader('Authorization',`Bearer ${window.__MU_CONFIG__.token}`);xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.timeout=180000;
  xhr.upload.onprogress=event=>onProgress(Math.min(event.loaded,file.size),event.lengthComputable?event.total:file.size);
  xhr.upload.onload=()=>onProgress(file.size,file.size);
  xhr.onload=()=>{let result:any;try{result=JSON.parse(xhr.responseText);}catch{finish(new ApiError('未收到文件保存确认，请刷新下载目录后重试。',502,'TRANSFER_RESPONSE_INVALID'));return;}if(xhr.status<200||xhr.status>=300){finish(new ApiError(result.error??'文件传输失败',xhr.status,result.code??'TRANSFER_FAILED'));return;}if(typeof result.name!=='string'||typeof result.path!=='string'||result.bytes!==file.size||result.zone!=='downloads'){finish(new ApiError('文件保存结果无法确认，请刷新下载目录。',502,'TRANSFER_RESPONSE_INVALID'));return;}finish(undefined,result);};
  xhr.onerror=()=>finish(new ApiError('连接已中断；请刷新下载目录确认文件后再重试。',502,'TRANSFER_CONNECTION_CLOSED'));
  xhr.ontimeout=()=>finish(new ApiError('传输等待超时；请刷新下载目录确认文件后再重试。',504,'TRANSFER_TIMEOUT'));
  xhr.onabort=()=>finish(new ApiError('传输已中断；请刷新下载目录确认文件后再重试。',409,'TRANSFER_CANCELLED'));
  signal.addEventListener('abort',abort,{once:true});xhr.send(file);
 });
}
