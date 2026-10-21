import {useEffect,useRef,useState} from 'react';
import {ShieldCheck,RefreshCw} from 'lucide-react';
import {request} from '../api.ts';
import {Button,Field,Notice,SectionHeading} from '../components.tsx';
import type {WindowsRecoverySnapshot} from '../../shared/windows-recovery.ts';
import './windows.css';
export default function WindowsRecoveryWorkspace(){
 const [state,setState]=useState<WindowsRecoverySnapshot|null>(null),[id,setId]=useState(''),[confirmation,setConfirmation]=useState(''),[error,setError]=useState(''),[sending,setSending]=useState(false);
 const live=useRef(true),pending=useRef(false);
 async function refresh(){if(pending.current)return;pending.current=true;try{const value=await request<WindowsRecoverySnapshot>('/windows/recovery');if(live.current){setState(value);}}catch(e){if(live.current)setError((e as Error).message);}finally{pending.current=false;}}
 useEffect(()=>{live.current=true;void refresh();const timer=setInterval(()=>void refresh(),800);return()=>{live.current=false;clearInterval(timer);};},[]);
 async function action(name:string,body:unknown={}){setSending(true);setError('');try{const value=await request<WindowsRecoverySnapshot>('/windows/recovery/'+name,{method:'POST',body:JSON.stringify(body)});if(name!=='reopen'){setState(value);if(name==='cancel'||name==='refresh'){setId('');setConfirmation('');}}}catch(e){setError((e as Error).message);}finally{setSending(false);}}
 const busy=sending||state?.phase==='reviewing'||state?.phase==='applying',review=state?.review,selected=state?.candidates.find(value=>value.id===(review?.review.id??id));
 return <main className="windows-preview windows-recovery"><header className="page-header"><div><div className="eyebrow"><ShieldCheck size={16}/> Windows · 原环境恢复</div><h1>恢复原环境登记</h1><p>核验已停止的原虚拟机，保留原盘与管理资料。</p></div></header>
  <Notice>恢复模式不提供虚拟机启动、联网或删除操作。关闭此窗口可退出恢复模式。</Notice>
  {error&&<Notice kind="error">{error}</Notice>}
  {!state?<p role="status">正在只读检查原管理资料…</p>:<>
   {state.issue&&<Notice kind="error">{state.issue}</Notice>}
   <section className="windows-setup" aria-label="选择原环境"><SectionHeading title="选择原环境"/>
    <Field label="原环境"><select aria-label="原环境" value={id} disabled={!!busy||state.phase==='completed'||state.phase==='reviewed'} onChange={event=>{setId(event.target.value);setConfirmation('');}}><option value="">请选择需要恢复的环境</option>{state.candidates.map(value=><option key={value.id} value={value.id} disabled={!value.ready}>{value.name}{value.ready?'':' · 管理资料不完整'}</option>)}</select></Field>
    {selected&&<p>{selected.cpus} CPU · {selected.memoryGiB} GiB 内存 · {selected.diskGiB} GiB 虚拟磁盘{selected.issue?' · '+selected.issue:''}</p>}
    <div className="button-row"><Button className="primary" disabled={!!busy||!selected?.ready||state.phase==='completed'||state.phase==='reviewed'} loading={state.phase==='reviewing'} onClick={()=>void action('review',{id})}>核验原虚拟机</Button><Button icon={<RefreshCw size={15}/>} disabled={!!busy||state.phase==='completed'} onClick={()=>void action('refresh')}>重新检查原资料</Button>{state.canCancel&&<Button disabled={sending} onClick={()=>void action('cancel')}>取消核验</Button>}</div>
   </section>
   <p role="status" aria-live="polite">{state.message}</p>{state.phase!=='completed'&&<Button disabled={!!busy} onClick={()=>void action('reopen')}>返回工作区</Button>}
   {review&&state.phase!=='completed'&&<section className="windows-setup" aria-label="确认恢复登记"><SectionHeading title="审阅恢复对象" subtitle="确认后仅恢复管理登记，原磁盘保留，虚拟机继续停止。"/>
    <dl className="windows-recovery-details"><dt>原环境名称</dt><dd>{selected?.name}</dd><dt>虚拟机身份</dt><dd>{review.review.platformId}</dd><dt>资源</dt><dd>{review.review.cpus} CPU · {review.review.memoryGiB} GiB 内存 · {review.review.diskGiB} GiB 虚拟磁盘</dd><dt>状态</dt><dd>已停止，网络规则已核验</dd></dl>
    <details><summary>查看磁盘核验摘要</summary><p className="windows-recovery-digest">{review.review.diskSha256}</p></details>
    <form onSubmit={event=>{event.preventDefault();if(selected&&confirmation===selected.name)void action('adopt',{id:review.review.id,plan:review.plan,confirmation});}}><Field label="输入完整原环境名称以确认" hint={selected?.name}><input aria-label="输入完整原环境名称以确认" autoComplete="off" disabled={!!busy} value={confirmation} onChange={event=>setConfirmation(event.target.value)}/></Field><div className="button-row"><Button type="submit" className="primary" disabled={!!busy||!selected||confirmation!==selected.name} loading={state.phase==='applying'}>确认恢复登记</Button><Button disabled={!!busy} onClick={()=>void action('cancel')}>取消确认</Button></div></form>
   </section>}
   {state.phase==='completed'&&<section className="windows-setup"><Notice kind="success">原环境登记已恢复，原盘保留。恢复模式仍不允许启动虚拟机。</Notice><Button className="primary" disabled={sending} onClick={()=>void action('reopen')}>重新打开工作区</Button></section>}
  </>}
 </main>;
}
