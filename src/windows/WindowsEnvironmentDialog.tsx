import {useState} from 'react';
import {Box,Globe,Plus,ShieldCheck} from 'lucide-react';
import type {Environment,Snapshot} from '../../shared/types.ts';
import {api,editConfig} from '../api.ts';
import {Button,Field,Modal,Notice} from '../components.tsx';
import {IdentityEditor} from '../forms.tsx';
import {BROWSER_HOME_URL} from '../../shared/browser-home.ts';
import {WindowsNetworkEditor} from './WindowsNetworkEditor.tsx';
type Draft=Omit<Environment,'id'|'instanceName'|'state'|'browserRunning'|'lastError'|'createdAt'|'updatedAt'>;
export default function WindowsEnvironmentDialog({environment,system,onClose,onSave}:{environment?:Environment;system:Snapshot['system'];onClose:()=>void;onSave:(id:string)=>Promise<void>}){
 const [draft,setDraft]=useState<Draft>(()=>environment?editConfig(environment):{name:'',description:'',kind:'vm',color:'green',cpus:Math.min(4,system.cpus),memoryGiB:Math.min(4,Math.floor(system.memoryGiB*.5)),diskGiB:32,mounts:[],ports:[],identity:{timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:'en-US'},network:{mode:'http',host:'127.0.0.1',port:7897,username:'',strict:true,transparent:true,noProxy:'localhost,127.0.0.1',egressLock:{expectedIp:''}},browserUrl:BROWSER_HOME_URL});
 const [busy,setBusy]=useState(false),[error,setError]=useState('');const resourcesLocked=!!environment&&environment.state!=='not_created';
 async function save(event:React.SubmitEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');try{const body={...draft,network:{...draft.network,tls:draft.network.mode==='https'?draft.network.tls:undefined}};const saved=environment?await api.update(environment.id,body):await api.create(body);await onSave(saved.id);}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
 return <Modal title={environment?'编辑环境':'新建环境'} subtitle="MuCodeSandbox" onClose={()=>{if(!busy)onClose();}}><form onSubmit={event=>void save(event)}><div className="modal-body">
  {!environment&&<div className="kind-picker"><button type="button" className="selected"><Box size={22}/><span>Linux 沙箱<small>Windows Hyper-V · 独立 Linux</small></span><ShieldCheck size={16}/></button><button type="button" disabled title="Windows 本机浏览器环境尚未提供"><Globe size={22}/><span>本机浏览器<small>Windows · 尚未提供</small></span></button></div>}
  <Field label="环境名称"><input autoFocus required maxLength={60} placeholder="例如：我的开发环境" disabled={busy} value={draft.name} onChange={event=>setDraft(value=>({...value,name:event.target.value}))}/></Field>
  <Field label="备注"><input maxLength={240} placeholder="可选" disabled={busy} value={draft.description} onChange={event=>setDraft(value=>({...value,description:event.target.value}))}/></Field>
  <div className="color-picker"><span>环境标记</span>{(['green','blue','amber','rose'] as const).map(color=><button type="button" key={color} disabled={busy} aria-label={`${color}标记`} className={`swatch swatch-${color} ${draft.color===color?'selected':''}`} onClick={()=>setDraft(value=>({...value,color}))}/>)}</div>
  <div className="form-grid"><Field label="CPU 核心"><input required type="number" min={1} max={Math.min(16,system.cpus)} disabled={resourcesLocked||busy} value={draft.cpus} onChange={event=>setDraft(value=>({...value,cpus:Number(event.target.value)}))}/></Field><Field label="内存 / GB"><input required type="number" min={2} max={Math.min(32,Math.floor(system.memoryGiB*.8))} disabled={resourcesLocked||busy} value={draft.memoryGiB} onChange={event=>setDraft(value=>({...value,memoryGiB:Number(event.target.value)}))}/></Field><Field label="磁盘容量 / GiB"><input required type="number" min={32} max={256} disabled={resourcesLocked||busy} value={draft.diskGiB} onChange={event=>setDraft(value=>({...value,diskGiB:Number(event.target.value)}))}/></Field></div>
  <p className="muted">磁盘容量是上限，不会立即占满；虚拟磁盘会随使用增长，删除文件后可在环境设置中回收空间。</p>
  <div className="form-divider"><h3>项目目录</h3><span className="muted">手动传输</span></div><p className="muted">Windows 持续共享目录尚未提供。启动后在“文件传输”页上传、下载和管理沙箱内的文件。</p>
  <div className="form-divider"><h3>地区设置</h3></div><IdentityEditor value={draft.identity} disabled={busy} onChange={identity=>setDraft(value=>({...value,identity}))}/>
  <div className="form-divider"><h3>网络出口</h3></div><WindowsNetworkEditor value={draft.network} disabled={busy} passwordConfigured={environment?.network.passwordConfigured} onChange={network=>setDraft(value=>({...value,network}))}/>
  {error&&<Notice kind="error">{error}</Notice>}
 </div><footer className="modal-footer"><Button disabled={busy} onClick={onClose}>取消</Button><Button type="submit" className="primary" icon={environment?undefined:<Plus size={16}/>} loading={busy}>{environment?'保存配置':'创建环境'}</Button></footer></form></Modal>;
}
