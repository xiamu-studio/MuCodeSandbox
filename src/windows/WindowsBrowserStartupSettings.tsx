import {useEffect,useRef,useState} from 'react';
import {Button,Field,Notice,SectionHeading} from '../components.tsx';
import {editConfig,request} from '../api.ts';
import type {Environment} from '../../shared/types.ts';
import {BROWSER_HOME_URL} from '../../shared/browser-home.ts';
import {windowsBrowserStartPage,WINDOWS_BLANK_PAGE_URL} from '../../shared/windows-browser-start.ts';

function initial(url:string){try{const selected=windowsBrowserStartPage(url);return {kind:selected.kind,url:selected.kind==='url'?selected.url:''};}catch{return {kind:'url' as const,url:url??''};}}
export default function WindowsBrowserStartupSettings({environment,disabled=false,onChange}:{environment:Environment;disabled?:boolean;onChange:()=>Promise<void>}){
 const [draft,setDraft]=useState(()=>initial(environment.browserUrl)),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const live=useRef(false),latest=useRef(environment),dirty=useRef(false),composing=useRef(false),pending=useRef<AbortController|null>(null),boundId=useRef(environment.id);latest.current=environment;
 const available=!disabled&&!environment.browserRunning&&['stopped','not_created'].includes(environment.state);
 useEffect(()=>{live.current=true;return()=>{live.current=false;pending.current?.abort();};},[]);
 useEffect(()=>{if(boundId.current!==environment.id){boundId.current=environment.id;pending.current?.abort();pending.current=null;dirty.current=false;composing.current=false;setBusy(false);setError('');setMessage('');setDraft(initial(environment.browserUrl));}else if(!dirty.current&&!pending.current)setDraft(initial(environment.browserUrl));},[environment.id,environment.browserUrl]);
 function edit(next:typeof draft){dirty.current=true;setDraft(next);setError('');setMessage('');}
 async function save(event:React.SubmitEvent<HTMLFormElement>){
  event.preventDefault();if(!available||pending.current||composing.current)return;let url:string;
  try{url=windowsBrowserStartPage(draft.kind==='blank'?WINDOWS_BLANK_PAGE_URL:draft.kind==='home'?BROWSER_HOME_URL:draft.url).url;}catch(value){setError((value as Error).message);return;}
  const id=environment.id,controller=new AbortController();pending.current=controller;setBusy(true);setError('');setMessage('');
  const current=()=>live.current&&latest.current.id===id&&pending.current===controller&&!controller.signal.aborted;
  try{const saved=await request<Environment>(`/environments/${id}`,{method:'PUT',body:JSON.stringify({...editConfig(environment),browserUrl:url}),signal:controller.signal});if(!current())return;if(saved.id!==id||saved.browserUrl!==url)throw Error('保存结果与当前启动页不一致，请重新读取环境。');dirty.current=false;setDraft(initial(url));setMessage('启动页已保存，下次打开浏览器时生效。');await onChange();}
  catch(value){if(current())setError((value as Error).message);}
  finally{if(pending.current===controller){pending.current=null;if(live.current)setBusy(false);}}
 }
 return <section className="network-test" aria-label="Windows 浏览器启动页"><SectionHeading title="启动页"/>
  <form className="network-editor" onSubmit={event=>void save(event)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{if(event.key==='Enter'&&(composing.current||event.nativeEvent.isComposing||event.keyCode===229))event.preventDefault();}}>
   <div className="segmented" role="group" aria-label="启动页模式">{([{kind:'home',label:'浏览器首页'},{kind:'url',label:'指定网页'},{kind:'blank',label:'空白页'}] as const).map(choice=><button key={choice.kind} type="button" data-mode={choice.kind} aria-pressed={draft.kind===choice.kind} className={draft.kind===choice.kind?'selected':''} disabled={!available||busy} onClick={()=>edit({kind:choice.kind,url:draft.url})}>{choice.label}</button>)}</div>
   {draft.kind==='url'&&<Field label="启动页网址"><input value={draft.url} maxLength={2048} disabled={!available||busy} autoComplete="off" placeholder="https://example.org/" onChange={event=>edit({...draft,url:event.target.value})}/></Field>}
   {draft.kind==='home'&&<p>本地首页提供网址输入、出口 IP 检测和浏览器环境信息。</p>}{draft.kind==='blank'&&<p>核验完成后保持空白页，不自动打开网站。</p>}
   {!available&&<Notice>请先停止环境，再修改启动页。</Notice>}
   <div className="button-row"><Button type="submit" disabled={!available||busy} loading={busy}>保存启动页</Button></div>
  </form>{error&&<Notice kind="error">{error}</Notice>}{message&&<Notice kind="success">{message}</Notice>}
 </section>;
}
