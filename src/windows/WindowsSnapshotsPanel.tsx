import {useCallback,useEffect,useRef,useState} from 'react';
import {Camera,Download,History,RefreshCw,Trash2} from 'lucide-react';
import type {Environment,Job} from '../../shared/types.ts';
import type {WindowsSnapshotProductStatus,WindowsSnapshotSummary,WindowsSnapshotDeletion,WindowsSnapshotStaging,WindowsSnapshotStagingReview,WindowsSnapshotStagingReviewState} from '../../shared/windows-snapshots.ts';
import {request} from '../api.ts';
import {Button,Field,IconButton,Modal,Notice,SectionHeading,dateLabel} from '../components.tsx';

export default function WindowsSnapshotsPanel({environment,jobs,disabled,refresh,onRecovery,onCleanup,onExport}:{environment:Environment;jobs:Job[];disabled:boolean;refresh:()=>Promise<void>;onRecovery:()=>void;onCleanup?:()=>void;onExport?:(record:WindowsSnapshotSummary)=>void}){
 const [deletions,setDeletions]=useState<WindowsSnapshotDeletion[]>([]),[deleting,setDeleting]=useState<{id:string;name:string;resumeOnly:boolean}|null>(null);
 const [staging,setStaging]=useState<WindowsSnapshotStaging>({entries:[],truncated:false});
 const [stagingReview,setStagingReview]=useState<WindowsSnapshotStagingReview|null>(null),[stagingAction,setStagingAction]=useState<'review'|'cleanup'|null>(null);
 const approval=useRef<WindowsSnapshotStagingReview|null>(null),reviewTarget=useRef<{id:string;operation:'create'|'restore'}|null>(null),settling=useRef<string|null>(null);
 const [records,setRecords]=useState<WindowsSnapshotSummary[]>([]),[status,setStatus]=useState<WindowsSnapshotProductStatus|null>(null),[loading,setLoading]=useState(true),[name,setName]=useState(''),[error,setError]=useState(''),[catalogError,setCatalogError]=useState(''),[message,setMessage]=useState('');
 const [submitting,setSubmitting]=useState(false),[submitted,setSubmitted]=useState<string|null>(null),[restore,setRestore]=useState<WindowsSnapshotSummary|null>(null),[confirmation,setConfirmation]=useState('');
 const live=useRef(false),reading=useRef(false),posting=useRef(false),revision=useRef(0),composition=useRef(false);
 const id=environment.id;
 const read=useCallback(async()=>{
  if(reading.current||posting.current)return;reading.current=true;const stamp=revision.current;
  let checkedStatus:WindowsSnapshotProductStatus|null=null;
  try{
   const next=await request<WindowsSnapshotProductStatus>('/windows/snapshots');
   checkedStatus=next;
   if(next.activeIds.includes(id)){if(live.current&&stamp===revision.current){setStatus(next);setLoading(false);}return;}
   const [rows,pendingDeletes,unpublished]=next.recoveryAvailable?await Promise.all([request<WindowsSnapshotSummary[]>(`/environments/${id}/windows-snapshots`),request<WindowsSnapshotDeletion[]>(`/environments/${id}/windows-snapshots/deletions`),request<WindowsSnapshotStaging>(`/environments/${id}/windows-snapshots/staging`)]):[[],[],{entries:[],truncated:false}];
   if(live.current&&stamp===revision.current){setStatus(next);setRecords(rows);setDeletions(pendingDeletes);setStaging(unpublished);setCatalogError('');setLoading(false);}
   const approved=approval.current;
   if(approved){const state=await request<WindowsSnapshotStagingReviewState>(`/environments/${id}/windows-snapshots/staging/review`);if(live.current&&stamp===revision.current&&approval.current===approved&&(state.phase!=='ready'||state.review?.token!==approved.token)){approval.current=null;setStagingReview(null);setConfirmation('');setError('清理核验已失效，请重新核验选定条目');}}
  }catch(error){if(live.current&&stamp===revision.current){setCatalogError((error as Error).message);setStatus(checkedStatus);setLoading(false);}}
  finally{reading.current=false;}
 },[id]);
 useEffect(()=>{live.current=true;void read();const timer=setInterval(()=>void read(),3000);return()=>{live.current=false;revision.current++;clearInterval(timer);};},[read]);
 useEffect(()=>{
  const job=jobs.find(value=>value.id===submitted);
  if(!job||job.status==='running'||settling.current===job.id)return;
  const stamp=revision.current;settling.current=job.id;
  void(async()=>{try{
   if(job.action==='snapshot-staging-review'&&job.status==='succeeded'){
    const state=await request<WindowsSnapshotStagingReviewState>(`/environments/${id}/windows-snapshots/staging/review`),target=reviewTarget.current;
    if(live.current&&stamp===revision.current){if(state.phase==='ready'&&state.jobId===job.id&&state.review&&state.review.id===target?.id&&state.review.operation===target.operation){approval.current=state.review;setStagingReview(state.review);setConfirmation('');composition.current=false;}else setError('清理核验已失效，请重新核验选定条目');}
   }
   if(live.current&&stamp===revision.current){setSubmitted(null);setStagingAction(null);setMessage(job.status==='succeeded'?(['snapshot-staging-review','snapshot-staging-cleanup'].includes(job.action)?job.message||'遗留副本任务已完成':job.action==='snapshot-delete-live'?job.message||'旧快照副本已删除；请核对当前环境状态':environment.state==='stopped'?'快照任务已完成；环境保持停止':'快照任务已完成；请核对环境状态'):`快照任务未完成：${job.message||job.status}。请查看操作记录和恢复状态。`);}
  }catch(error){if(live.current&&stamp===revision.current){approval.current=null;setStagingReview(null);setSubmitted(null);setStagingAction(null);setError((error as Error).message);}}
  finally{settling.current=null;void read();}})();
 },[jobs,submitted,read,id,environment.state]);
 const busy=submitting||!!submitted||jobs.some(job=>job.environmentId===id&&job.status==='running')||!!status?.activeIds.includes(id);
 const pending=!!status&&(!status.initialized||status.pendingIds.includes(id)||status.issues.some(issue=>issue.id===null||issue.id===id));
 const operationBusy=disabled||busy||loading||!!catalogError||!status?.recoveryAvailable||pending;
 const exportLocked=operationBusy||!status?.exportAvailable||!onExport||!['running','stopped','error'].includes(environment.state);
 const liveDeletion=environment.state==='running'&&status?.liveDeletionAvailable===true;
 const baseLocked=operationBusy||environment.browserRunning||environment.state!=='stopped';
 const deletionBaseLocked=operationBusy||(!liveDeletion&&(environment.browserRunning||environment.state!=='stopped'));
 const retryDeletionLocked=operationBusy||(!liveDeletion&&(environment.browserRunning||!['stopped','error'].includes(environment.state)));
 const locked=baseLocked||!status?.enabled||!status.available||!!status?.cleanupIndexIssue||!!staging.entries.length,deleteLocked=(deleting?.resumeOnly?retryDeletionLocked:deletionBaseLocked)||!deleting?.resumeOnly&&!status?.enabled;
 const stagingLocked=operationBusy||environment.browserRunning||!['stopped','error'].includes(environment.state),stagingCleanupLocked=stagingLocked||!stagingReview||approval.current!==stagingReview||stagingReview.phase==='copy'&&!status?.stagingCleanupAvailable;
 function stagingIdentity(entry:WindowsSnapshotStaging['entries'][number]){const match=entry.name.match(/^(create|restore)-next-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/);return match&&match[1]===entry.operation&&match[2]!=='00000000-0000-0000-0000-000000000000'?{id:match[2],operation:entry.operation}:null;}
 async function inspectStaging(entry:WindowsSnapshotStaging['entries'][number]){
  const target=stagingIdentity(entry);if(!target||posting.current||stagingLocked)return;
  posting.current=true;const stamp=++revision.current;setSubmitting(true);setError('');setMessage('');setStagingAction('review');approval.current=null;setStagingReview(null);reviewTarget.current=target;
  try{const job=await request<Job>(`/environments/${id}/windows-snapshots/staging/review`,{method:'POST',body:JSON.stringify({copyId:target.id,operation:target.operation})});if(live.current&&stamp===revision.current){setSubmitted(job.id);await refresh();}}
  catch(error){if(live.current&&stamp===revision.current){setError((error as Error).message);setStagingAction(null);}}
  finally{posting.current=false;if(live.current&&stamp===revision.current)setSubmitting(false);}
 }
 async function cleanupStaging(){
  if(posting.current||stagingCleanupLocked||!stagingReview||confirmation!==environment.name||composition.current)return;
  const approved=stagingReview;posting.current=true;const stamp=++revision.current;setSubmitting(true);setError('');setMessage('');setStagingAction('cleanup');
  try{const job=await request<Job>(`/environments/${id}/windows-snapshots/staging/cleanup`,{method:'POST',body:JSON.stringify({copyId:approved.id,operation:approved.operation,token:approved.token,confirmation,resumeOnly:approved.phase!=='copy'})});if(live.current&&stamp===revision.current){setSubmitted(job.id);approval.current=null;setStagingReview(null);setConfirmation('');await refresh();}}
  catch(error){if(live.current&&stamp===revision.current){approval.current=null;setStagingReview(null);setError((error as Error).message);setStagingAction(null);}}
  finally{posting.current=false;if(live.current&&stamp===revision.current)setSubmitting(false);}
 }
 async function perform(action:'create'|'restore'|'delete'){
  if(posting.current||(action==='delete'?deleteLocked:locked)||composition.current)return;
  if(action==='restore'&&(!restore||confirmation!==environment.name))return;if(action==='delete'&&(!deleting||confirmation!==environment.name))return;
  const label=name.trim();if(action==='create'&&(!label||/[\x00-\x1f\x7f]/.test(label)))return;
  posting.current=true;const stamp=++revision.current;setSubmitting(true);setError('');setMessage('');
  try{
   const job=await request<Job>(`/environments/${id}/windows-snapshots${action==='restore'?'/restore':action==='delete'?'/delete':''}`,{method:'POST',body:JSON.stringify(action==='create'?{name:label}:action==='delete'?{snapshotId:deleting!.id,name:deleting!.name,confirmation,resumeOnly:deleting!.resumeOnly}:{snapshotId:restore!.id,confirmation})});
   if(live.current&&stamp===revision.current){setSubmitted(job.id);if(action==='create')setName('');setRestore(null);setDeleting(null);setConfirmation('');await refresh();}
  }catch(error){if(live.current&&stamp===revision.current)setError((error as Error).message);}
  finally{posting.current=false;if(live.current&&stamp===revision.current)setSubmitting(false);}
 }
 return <div className="panel-width windows-snapshots"><SectionHeading title="Linux 快照" action={<IconButton title="刷新快照" disabled={submitting} onClick={()=>void read()}><RefreshCw size={17}/></IconButton>}/>
  {status?.cleanupIndexIssue&&<Notice kind="error">{status.cleanupIndexIssue}</Notice>}
  {!!staging.entries.length&&<Notice kind="error"><strong>发现未发布快照副本</strong><p>中断的复制可能仍占用磁盘空间。创建和恢复快照已暂停；请先核验归属和清理凭据。当前环境和已有快照保持原样。</p><details><summary style={{cursor:'pointer'}}>查看遗留条目（{staging.entries.length}{staging.truncated?'+':''}）</summary><ul style={{maxHeight:220,overflowY:'auto',paddingRight:8}}>{staging.entries.map(entry=><li key={entry.name}><code style={{overflowWrap:'anywhere'}}>{entry.name}</code> · {entry.operation==='create'?'创建时遗留':'恢复准备时遗留'}{status?.stagingCleanupAvailable!==undefined&&stagingIdentity(entry)&&<Button disabled={stagingLocked} onClick={()=>void inspectStaging(entry)}>核验清理</Button>}</li>)}</ul></details>{staging.truncated&&<p>仅显示前 32 个条目，仍有其他遗留项。</p>}<p>请逐项核验原始凭据。已有删除记录按原记录接续，缺少凭据的旧文件保留。</p></Notice>}
  {!!status?.cleanupIssues?.length&&<Notice kind="error"><strong>快照身份临时资料尚未清理</strong><p>可能仍有本次校验的明文管理密钥。原清理凭据已保留；请打开临时清理记录核对，勿重复恢复快照。</p><Button disabled={disabled||!onCleanup} onClick={onCleanup}>查看临时清理记录</Button></Notice>}
  <form onSubmit={event=>{event.preventDefault();void perform('create');}}><Field label="快照名称"><div className="input-action"><input aria-label="快照名称" value={name} maxLength={60} disabled={locked} onChange={event=>setName(event.target.value)} onCompositionStart={()=>{composition.current=true;}} onCompositionEnd={()=>{composition.current=false;}}/><Button type="submit" icon={<Camera size={16}/>} className="primary" loading={submitting&&!restore} disabled={locked||!name.trim()}>创建快照</Button></div></Field></form>
  <dl className="facts"><div><dt>保存范围</dt><dd>Linux 磁盘与环境配置</dd></div><div><dt>Windows 本机文件</dt><dd>保持当前内容；无持续共享目录</dd></div><div><dt>Linux 浏览器资料</dt><dd>随磁盘保存</dd></div><div><dt>Windows 浏览器资料</dt><dd>不包含</dd></div></dl>
  {status&&!status.enabled&&<Notice>{status.exportAvailable?'Windows 快照创建和恢复尚未开放，现有快照可查看和导出。':'Windows 快照操作尚未开放，现有快照仍可查看。'}</Notice>}
  {status&&!status.recoveryAvailable&&<Notice>请先完成运行组件准备并重新打开软件，再读取快照。</Notice>}
  {pending&&<Notice kind="error">快照恢复状态需要核验。原磁盘和配置已保留。<Button onClick={onRecovery}>查看恢复状态</Button></Notice>}
  {status?.enabled&&environment.state!=='stopped'&&<Notice>停止环境并等待操作完成后，可以创建或恢复快照。</Notice>}
  {liveDeletion&&<Notice>可以删除旧快照副本；当前浏览器、终端与网络防护会话继续运行。</Notice>}
  {busy&&<Notice>{stagingAction==='review'?'正在核验遗留副本的原始凭据；文件保持保留。':stagingAction==='cleanup'?'正在清理已确认的遗留副本，可在操作记录中取消。':'快照任务处理中，请查看操作记录。复制磁盘可能需要数分钟。'}</Notice>}
  <section className="network-test" aria-label="快照列表">{loading?<div className="log-empty">读取快照…</div>:catalogError?<div className="log-empty">快照列表未能读取</div>:records.length?records.map(record=><div className="job-row" key={record.id}><Camera size={18}/><div className="job-main"><strong>{record.name}</strong><small>{dateLabel(record.createdAt)} · {(record.bytes/2**30).toFixed(1)} GB 逻辑大小</small></div><IconButton title={status?.exportAvailable?`导出 ${record.name}`:`导出 ${record.name}（尚未提供）`} disabled={exportLocked} onClick={()=>onExport?.(record)}><Download size={17}/></IconButton><IconButton title={`恢复 ${record.name}`} disabled={locked} onClick={()=>{setRestore(record);setConfirmation('');setError('');composition.current=false;}}><History size={17}/></IconButton><IconButton title={`删除快照 ${record.name}`} disabled={deletionBaseLocked||!status?.enabled} onClick={()=>{setDeleting({id:record.id,name:record.name,resumeOnly:false});setConfirmation('');setError('');composition.current=false;}}><Trash2 size={16}/></IconButton></div>):<div className="log-empty">{status?.recoveryAvailable?'暂无快照':'运行组件尚未激活'}</div>}</section>
  {!!deletions.length&&<section aria-label="待清理快照"><SectionHeading title="待清理快照"/><Notice>此前的快照删除尚未确认完成。确认后只接续原删除记录；当前环境磁盘不属于清理范围。</Notice>{deletions.map(record=><div className="job-row" key={record.id}><Trash2 size={18}/><div className="job-main"><strong>{record.name}</strong><small>{dateLabel(record.createdAt)} · {(record.bytes/2**30).toFixed(1)} GB 原逻辑大小</small></div><Button disabled={retryDeletionLocked} onClick={()=>{setDeleting({id:record.id,name:record.name,resumeOnly:true});setConfirmation('');setError('');composition.current=false;}}>继续清理</Button></div>)}</section>}
  <p className="muted">快照保存在本机；完整磁盘副本需要额外空间。{status?.exportAvailable?'导出保存所选快照当时的内容，当前环境可以继续运行。':'历史快照导出尚未开放。'}</p>
  {message&&<Notice>{message}</Notice>}{catalogError&&<Notice kind="error">{catalogError}</Notice>}{error&&!restore&&!deleting&&<Notice kind="error">{error}</Notice>}
  {restore&&<Modal title={`恢复「${restore.name}」？`} narrow onClose={()=>{if(!submitting)setRestore(null);}}><form onSubmit={event=>{event.preventDefault();void perform('restore');}}><div className="modal-body"><Notice>Linux 磁盘和环境配置将恢复到此快照，之后保持停止。Windows 本机文件保持当前内容。</Notice><Field label="输入完整环境名称以确认"><input autoFocus autoComplete="off" value={confirmation} disabled={submitting} onChange={event=>setConfirmation(event.target.value)} onCompositionStart={()=>{composition.current=true;}} onCompositionEnd={()=>{composition.current=false;}}/></Field>{error&&<Notice kind="error">{error}</Notice>}{locked&&!submitting&&<Notice>当前状态不允许恢复，请关闭窗口后核对环境及恢复状态。</Notice>}</div><footer className="modal-footer"><Button disabled={submitting} onClick={()=>setRestore(null)}>取消</Button><Button type="submit" icon={<History size={16}/>} className="primary" loading={submitting} disabled={locked||confirmation!==environment.name}>恢复</Button></footer></form></Modal>}
  {deleting&&<Modal title={deleting.resumeOnly?'继续清理快照？':'删除快照？'} subtitle={deleting.name} narrow onClose={()=>{if(!submitting)setDeleting(null);}}><form onSubmit={event=>{event.preventDefault();void perform('delete');}}><div className="modal-body"><Notice>将永久移除此快照的本机副本，之后无法从该快照恢复。当前环境磁盘、Windows 本机文件和已单独导出的备份保持当前内容。{liveDeletion&&'当前环境继续运行；仍可随时停止环境。'}</Notice><Field label="输入完整环境名称以确认"><input autoFocus autoComplete="off" value={confirmation} disabled={submitting} onChange={event=>setConfirmation(event.target.value)} onCompositionStart={()=>{composition.current=true;}} onCompositionEnd={()=>{composition.current=false;}}/></Field>{error&&<Notice kind="error">{error}</Notice>}{deleteLocked&&!submitting&&<Notice>请核对环境、运行组件与快照状态，并等待当前操作完成。</Notice>}</div><footer className="modal-footer"><Button disabled={submitting} onClick={()=>setDeleting(null)}>取消</Button><Button type="submit" className="danger" loading={submitting} disabled={deleteLocked||confirmation!==environment.name}>{deleting.resumeOnly?'确认继续清理':'确认删除快照'}</Button></footer></form></Modal>}
  {stagingReview&&<Modal title={stagingReview.phase==='copy'?'清理未发布副本？':'接续遗留副本清理？'} narrow onClose={()=>{if(!submitting){approval.current=null;setStagingReview(null);setConfirmation('');}}}><form onSubmit={event=>{event.preventDefault();void cleanupStaging();}}><div className="modal-body"><Notice>将删除选定失败复制生成的临时副本。当前环境磁盘、已有快照和恢复回滚文件保持保留。</Notice><p style={{overflowWrap:'anywhere'}}><code>{stagingReview.operation}-next-{stagingReview.id}</code></p><dl className="facts"><div><dt>已核验文件</dt><dd>{stagingReview.files} 项</dd></div><div><dt>剩余文件长度</dt><dd>{(stagingReview.bytes/2**20).toFixed(1)} MiB</dd></div><div><dt>处理方式</dt><dd>{stagingReview.phase==='copy'?'新建清理记录':stagingReview.phase==='deleting'?'接续原删除记录':'已完成，核对结果'}</dd></div></dl>{stagingReview.partialReceipt&&<Notice>上次写入凭据时中断，当前条目已按完整记录核验；确认后接续处理。</Notice>}{stagingReview.phase==='copy'&&!status?.stagingCleanupAvailable&&<Notice>新的遗留副本清理尚未开放，现有清理记录仍可接续。</Notice>}<Field label="输入完整环境名称以确认"><input autoFocus autoComplete="off" value={confirmation} disabled={submitting} onChange={event=>setConfirmation(event.target.value)} onCompositionStart={()=>{composition.current=true;}} onCompositionEnd={()=>{composition.current=false;}}/></Field>{error&&<Notice kind="error">{error}</Notice>}{stagingLocked&&!submitting&&<Notice>请先停止环境、关闭浏览器，并等待当前操作完成。</Notice>}</div><footer className="modal-footer"><Button disabled={submitting} onClick={()=>{approval.current=null;setStagingReview(null);setConfirmation('');}}>取消</Button><Button type="submit" className="danger" loading={submitting} disabled={stagingCleanupLocked||confirmation!==environment.name}>确认清理遗留副本</Button></footer></form></Modal>}
 </div>;
}
