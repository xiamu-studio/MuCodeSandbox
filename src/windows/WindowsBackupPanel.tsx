import {useEffect,useRef,useState} from 'react';
import {Button,Field,Modal,Notice,SectionHeading} from '../components.tsx';
import {request} from '../api.ts';
import type {Environment} from '../../shared/types.ts';
import type {WindowsBackupStatus,WindowsSnapshotBackupSelection} from '../../shared/windows-backup.ts';
import {FolderOpen} from 'lucide-react';

function backupError(error:unknown):string{
 if(error instanceof DOMException&&error.name==='TimeoutError')return '读取备份任务状态超时，请稍后重试；操作结果未确认时请先核对任务状态。';
 if(error instanceof TypeError&&/^(?:failed to fetch|load failed|network request failed|networkerror when attempting to fetch resource\.?|networkerror)$/i.test(error.message.trim()))
  return '无法连接本机服务，请稍后重试；操作结果未确认时请先核对任务状态。';
 return error instanceof Error?error.message:'备份操作未完成，请检查状态后重试。';
}

export default function WindowsBackupPanel({environments,onChange,requestOpen=0,defaultMode='export',preferredEnvironmentId,showHeading=true,historicalSnapshot}:{environments:Environment[];onChange:()=>Promise<void>;requestOpen?:number;defaultMode?:'export'|'restore';preferredEnvironmentId?:string|null;showHeading?:boolean;historicalSnapshot?:WindowsSnapshotBackupSelection|null}){
 const [history,setHistory]=useState<WindowsSnapshotBackupSelection|null>(null);
 const [restoreName,setRestoreName]=useState('');
 // A collapsed job may finish without updating this panel. Resolve the new
 // open intent against the first fresh service snapshot, not cached status.
 const requestedOpen=useRef<{mode:'export'|'restore';history:WindowsSnapshotBackupSelection|null}|null>(null);
 const [opened,setOpened]=useState(false),[mode,setMode]=useState<'export'|'restore'>('export'),[id,setId]=useState(''),[file,setFile]=useState(''),[password,setPassword]=useState(''),[repeat,setRepeat]=useState(''),[confirmation,setConfirmation]=useState(''),[status,setStatus]=useState<WindowsBackupStatus>({phase:'idle',bytes:0,total:0,message:''}),[error,setError]=useState(''),[posting,setPosting]=useState(false);
 const composing=useRef(false),poll=useRef(false),locked=useRef(false),revision=useRef(0),alive=useRef(true),visible=useRef(false),currentStatus=useRef(status),needsStatus=useRef(true),picker=useRef(false);
 const [synchronizing,setSynchronizing]=useState(true),[readError,setReadError]=useState(''),[cancelRequested,setCancelRequested]=useState<string|null>(null);
 currentStatus.current=status;
 const environment=environments.find(value=>value.id===id),running=status.phase==='running',review=status.review,busy=posting||synchronizing;
 useEffect(()=>{setRestoreName(review?.resumeName??review?.name??'');},[review?.token]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;revision.current++;};},[]);
 function accept(value:WindowsBackupStatus){const intent=requestedOpen.current;requestedOpen.current=null;if(intent&&value.phase!=='running'&&!value.review){setMode(intent.mode);setHistory(intent.history);setFile('');setPassword('');setRepeat('');setConfirmation('');}currentStatus.current=value;setStatus(value);needsStatus.current=false;setSynchronizing(false);setReadError('');if(value.review)setMode('restore');else if(value.phase==='running'&&value.operation!=='cleanup')setMode(value.operation==='export'?'export':'restore');if(value.phase==='running'){setHistory(value.source??null);if(value.source)setId(value.source.environmentId);}if(value.phase!=='running')setCancelRequested(null);}
 async function read(ticket:number){const value=await request<WindowsBackupStatus>('/windows/backups',{signal:AbortSignal.timeout(10000)});if(!alive.current||!visible.current||ticket!==revision.current)return;accept(value);if(value.phase!=='running')await onChange();}
 function open(){if(locked.current)return;revision.current++;visible.current=true;needsStatus.current=true;setSynchronizing(true);setOpened(true);setError('');setReadError('');composing.current=false;}
 function hide(){revision.current++;visible.current=false;setOpened(false);setPassword('');setRepeat('');setConfirmation('');composing.current=false;}
 function begin(){if(locked.current||!alive.current||!visible.current)return null;locked.current=true;setPosting(true);setError('');return ++revision.current;}
 function finish(){locked.current=false;if(alive.current)setPosting(false);}
 function failed(e:unknown){if(alive.current){setError(backupError(e));needsStatus.current=true;setSynchronizing(true);}}
 const openRequest=useRef(0);
 useEffect(()=>{if(requestOpen<=openRequest.current||locked.current)return;openRequest.current=requestOpen;requestedOpen.current={mode:defaultMode,history:historicalSnapshot??null};open();if(!running&&!review){setMode(defaultMode);setHistory(historicalSnapshot??null);setFile('');setPassword('');setRepeat('');setConfirmation('');}setId(historicalSnapshot?.environmentId??environments.find(e=>e.id===preferredEnvironmentId&&e.state==='stopped')?.id??environments.find(e=>e.state==='stopped')?.id??'');},[requestOpen,defaultMode,preferredEnvironmentId,historicalSnapshot,environments,running,review,posting]);
 useEffect(()=>{let active=true;const refresh=async()=>{if(poll.current||locked.current)return;poll.current=true;const ticket=revision.current;try{const value=await request<WindowsBackupStatus>('/windows/backups',{signal:AbortSignal.timeout(10000)});if(active&&alive.current&&visible.current&&ticket===revision.current&&!locked.current){accept(value);if(value.phase!=='running')await onChange();}}catch(e){if(active&&alive.current&&visible.current&&ticket===revision.current&&!locked.current){needsStatus.current=true;setSynchronizing(true);setReadError(backupError(e));}}finally{poll.current=false;}};if(opened){void refresh();const timer=setInterval(()=>void refresh(),1500);return()=>{active=false;clearInterval(timer);};}return()=>{active=false;};},[opened,onChange]);
 async function choose(){if(locked.current||picker.current||needsStatus.current)return;const desktop=window.muWindowsDesktop;if(!desktop?.chooseBackupFile)return;picker.current=true;const ticket=revision.current;try{const value=await desktop.chooseBackupFile(mode);if(value&&alive.current&&visible.current&&ticket===revision.current&&!locked.current)setFile(value);}catch(e){if(alive.current&&visible.current&&ticket===revision.current)setError((e as Error).message);}finally{picker.current=false;}}
 async function submit(){if(needsStatus.current||currentStatus.current.phase==='running'||composing.current||!valid)return;const ticket=begin();if(ticket===null)return;try{
  const action=mode==='export'?'export':review?'restore':'review';
  await request(action==='export'&&history?`/environments/${id}/windows-snapshots/export`:'/windows/backups/'+action,{method:'POST',body:JSON.stringify(action==='export'?(history?{snapshotId:history.snapshotId,name:history.name,createdAt:history.createdAt,path:file,password,passwordConfirmation:repeat,confirmation}:{id,path:file,password,passwordConfirmation:repeat,confirmation}):action==='review'?{path:file,password}:{token:review!.token,confirmation,restoreName:restoreName.trim()})});
  if(!alive.current)return;setPassword('');setRepeat('');setConfirmation('');composing.current=false;await read(ticket);
 }catch(e){failed(e);}finally{finish();}}
 async function discard(closeAfter=false){if((needsStatus.current&&!closeAfter)||currentStatus.current.phase==='running')return;const ticket=begin();if(ticket===null)return;try{await request('/windows/backups/discard',{method:'POST',body:'{}'});if(!alive.current)return;setConfirmation('');composing.current=false;if(closeAfter){currentStatus.current={...currentStatus.current,review:undefined};setStatus(currentStatus.current);hide();}else await read(ticket);}catch(e){failed(e);}finally{finish();}}
 async function close(){if(locked.current)return;if(currentStatus.current.phase==='running'){hide();return;}await discard(true);}
 async function cancel(){const job=currentStatus.current.jobId;if(currentStatus.current.phase!=='running'||!job||cancelRequested===job)return;const ticket=begin();if(ticket===null)return;try{await request('/jobs/'+job+'/cancel',{method:'POST',body:'{}'});if(!alive.current)return;setCancelRequested(job);await read(ticket);}catch(e){failed(e);}finally{finish();}}
 async function retryCleanup(cleanupId:string){
  if(needsStatus.current||currentStatus.current.phase==='running'||currentStatus.current.cleanupIndexIssue||!currentStatus.current.cleanupIssues?.some(issue=>issue.id===cleanupId&&issue.retryable===true))return;
  const ticket=begin();if(ticket===null)return;
  try{await request('/windows/backups/cleanup',{method:'POST',body:JSON.stringify({id:cleanupId})});if(!alive.current)return;await read(ticket);}catch(e){failed(e);}finally{finish();}
 }
 async function retryOutputCleanup(outputId:string){
  if(needsStatus.current||currentStatus.current.phase==='running'||currentStatus.current.outputIndexIssue||!currentStatus.current.outputIssues?.some(issue=>issue.id===outputId&&issue.retryable===true))return;
  const ticket=begin();if(ticket===null)return;
  try{await request('/windows/backups/output-cleanup',{method:'POST',body:JSON.stringify({id:outputId})});if(!alive.current)return;await read(ticket);}catch(e){failed(e);}finally{finish();}
 }
 const valid=mode==='export'?!!environment&&(history?history.environmentId===id&&['running','stopped','error'].includes(environment.state):environment.state==='stopped')&&confirmation===environment.name&&password.length>=12&&password===repeat&&!!file:review?confirmation===review.name&&restoreName.trim().length>0&&restoreName.trim().length<=60:!!file&&password.length>=12;
 return <>{showHeading&&<SectionHeading title="加密备份与恢复" action={<Button onClick={()=>{open();setId(environments.find(e=>e.state==='stopped')?.id??'');}}>打开备份</Button>}/ >}{opened&&<Modal narrow={!showHeading} title={showHeading?'Windows 加密备份与恢复':mode==='export'?'导出加密备份':'导入加密备份'} subtitle="备份包含环境磁盘和连接凭据，请妥善保管文件与密码。" onClose={()=>void close()}><div className="modal-body" onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}>
  {error&&<Notice kind="error">{error}</Notice>}
  {readError&&<Notice kind="error">{readError}</Notice>}
  {synchronizing&&<Notice>正在核对备份任务状态，请稍候。</Notice>}
  {history&&mode==='export'?<Notice><strong>导出历史快照：{history.name}</strong><p>{new Date(history.createdAt).toLocaleString()} · {environment?.name}</p><p>保存此快照当时的 Linux 磁盘、浏览器资料、环境配置与连接凭据。当前环境可以继续运行；本次不会备份当前磁盘。</p><p>忘记密码将无法恢复。</p></Notice>:<Notice>操作前请停止所有环境。恢复保留备份中的身份，拒绝覆盖已有环境，完成后保持停止。忘记密码将无法恢复。</Notice>}
  {!running&&!review&&<>{showHeading&&!history&&<Field label="操作"><select value={mode} disabled={busy} onChange={e=>{revision.current++;setMode(e.target.value as 'export'|'restore');setFile('');setPassword('');setRepeat('');setConfirmation('');composing.current=false;}}><option value="export">保存加密备份</option><option value="restore">从备份恢复</option></select></Field>}
   {mode==='export'&&!history&&<Field label="已停止的环境"><select value={id} disabled={busy} onChange={e=>{setId(e.target.value);setConfirmation('');}}><option value="">选择环境</option>{environments.filter(e=>e.state==='stopped').map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>}
   <Field label={showHeading?mode==='export'?'保存为新的 .mucwin 文件':'选择 .mucwin 备份':'备份文件'} hint="使用本地磁盘的完整路径，例如 D:\Backups\environment.mucwin。"><div className="input-action"><input aria-label={showHeading?undefined:'备份文件路径'} placeholder="D:\Backups\environment.mucwin" value={file} disabled={busy} autoComplete="off" onChange={e=>setFile(e.target.value)}/>{!showHeading&&window.muWindowsDesktop?.chooseBackupFile&&<Button aria-label={mode==='export'?'选择保存位置':'选择备份文件'} disabled={busy} icon={<FolderOpen size={18}/>} onClick={()=>void choose()}/>}</div></Field>{showHeading&&window.muWindowsDesktop?.chooseBackupFile&&<Button disabled={busy} onClick={()=>void choose()}>选择文件位置…</Button>}
   <Field label="备份密码（12–256 个字符）"><input type="password" minLength={12} maxLength={256} autoComplete="new-password" disabled={busy} value={password} onChange={e=>setPassword(e.target.value)}/></Field>
   {mode==='export'&&<Field label="再次输入备份密码"><input type="password" maxLength={256} autoComplete="new-password" disabled={busy} value={repeat} onChange={e=>setRepeat(e.target.value)}/></Field>}
  </>}
  {review&&!running&&<><h3>恢复审阅：{review.name}</h3><p>{review.cpus} 核心 · {review.memoryGiB} GiB 内存 · {review.diskGiB} GiB 虚拟磁盘</p><p>代理：{review.proxy}。批准出口：{review.expectedIp}。</p><p>时区：{review.timezone}。</p><p>磁盘文件 {(review.diskBytes/2**30).toFixed(2)} GiB。审阅在 {new Date(review.expiresAt).toLocaleTimeString()} 过期。</p><Field label="恢复后的环境名称"><input value={restoreName} maxLength={60} disabled={busy||!!review.resumeName} onChange={event=>setRestoreName(event.target.value)}/></Field>{review.resumeName&&<Notice>已找到这份备份的未完成恢复，继续时沿用原恢复名称。</Notice>}<Notice>恢复保留备份中的环境身份；如果原环境仍存在，不能作为新副本导入，也不会覆盖原环境。中断后继续恢复时，请使用相同的恢复名称。</Notice><Notice>恢复需要额外的本地临时空间；开始后可以取消，已登记的部分恢复需使用原备份继续。</Notice></>}
  {review&&!running&&environments.some(value=>value.id===review.id)&&<Notice>工作区中已有相同身份的环境。正常情况下恢复会拒绝覆盖；如果这是上次中断的恢复，可以继续使用同一份备份，最终以恢复核验结果为准。</Notice>}
  {!running&&(mode==='export'||review)&&<Field label={'输入完整环境名称以确认：'+(review?.name??environment?.name??'')}><input autoComplete="off" value={confirmation} disabled={busy} onChange={e=>setConfirmation(e.target.value)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}/></Field>}
  {status.message&&<Notice kind={status.phase==='failed'?'error':status.phase==='succeeded'?'success':'info'}>{status.message}</Notice>}
  {status.operation==='export'&&status.phase==='succeeded'&&status.savedPath&&<p>备份保存位置：<span className="path-text">{status.savedPath}</span></p>}
  {status.lastSaved&&status.lastSaved.path!==status.savedPath&&<p>上次记录的备份位置：<span className="path-text">{status.lastSaved.path}</span>（{new Date(status.lastSaved.savedAt).toLocaleString('zh-CN')}；不确认文件当前是否存在）</p>}
  {status.lastSavedIssue&&<Notice kind="error">{status.lastSavedIssue}</Notice>}
  {status.cleanupIndexIssue&&<Notice kind="error">{status.cleanupIndexIssue}</Notice>}
  {status.outputIndexIssue&&<Notice kind="error">{status.outputIndexIssue}</Notice>}
  {status.releaseIssues?.map(issue=><div role="alert" className="windows-backup-release" key={issue.environmentId}><Notice kind="error"><strong>{history?'历史快照读取释放未确认':'原盘备份读取释放未确认'}</strong><br/><span>{issue.message}</span><br/><span className="path-text">环境：{environments.find(environment=>environment.id===issue.environmentId)?.name??issue.environmentId}</span><p>请保留原环境并检查权限代理，释放状态由本机服务核验更新。</p></Notice></div>)}
  {status.cleanupIssues?.map(issue=><div role="alert" className="windows-backup-cleanup" key={issue.id??issue.directory}><Notice kind="error"><strong>临时资料清理未完成</strong><br/><span>{issue.message}</span><br/><span className="path-text">{issue.directory}</span><br/>此目录可能仍有明文磁盘或管理资料。{status.operation==='restore'&&<>恢复已完成时请勿重复恢复，</>}请保留目录记录以便处理。{issue.retryable===true&&issue.id&&!status.cleanupIndexIssue&&<><p>将核对原归属记录，只清理此条记录对应的暂存目录；清理结果与备份、恢复结果分别记录。</p><Button disabled={busy||running} onClick={()=>void retryCleanup(issue.id!)}>重试清理临时资料</Button></>}</Notice></div>)}
  {status.outputIssues?.map(issue=><div role="alert" className="windows-backup-output" key={issue.id??issue.path}><Notice kind="error"><strong>加密临时文件清理未完成</strong><br/><span>{issue.message}</span><br/><span className="path-text">{issue.path}</span><p>此项只涉及加密临时文件。若目标备份已保存，其内容会保留。</p>{issue.retryable===true&&issue.id&&!status.outputIndexIssue&&<><p>将核对原归属记录，只清理此条记录对应的加密临时文件。</p><Button disabled={busy||running} onClick={()=>void retryOutputCleanup(issue.id)}>重试清理加密临时文件</Button></>}</Notice></div>)}
  {running&&(status.operation==='cleanup'?<p>正在核对原归属记录并清理临时资料；清理结果与备份、恢复结果分别记录。</p>:<><p>{status.operation==='export'?'已写入加密文件':'已处理'} {(status.bytes/2**30).toFixed(2)} GiB{status.total>0?' / '+(status.total/2**30).toFixed(2)+' GiB':''}</p>{status.total>0&&<progress value={status.bytes} max={status.total}/>}<p>{history?'历史快照完整校验阶段可能暂时没有字节进度。':'原盘核验和虚拟机登记阶段可能暂时没有字节进度。'}</p></>)}
  {running&&cancelRequested===status.jobId&&<Notice>已请求取消，正在等待任务结束。</Notice>}
 </div><footer className="modal-footer"><Button disabled={posting} onClick={()=>void close()}>{running?'收起':'关闭'}</Button>{running?<Button disabled={busy||cancelRequested===status.jobId} onClick={()=>void cancel()}>取消任务</Button>:<>{review&&<Button disabled={busy} onClick={()=>void discard()}>重新选择</Button>}<Button className="primary" disabled={busy||!valid} loading={posting} onClick={()=>void submit()}>{mode==='export'?'保存备份':review?'确认恢复':'核验并审阅'}</Button></>}</footer></Modal>}</>;
}
