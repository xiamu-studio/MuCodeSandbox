import {useEffect,useState,type ReactNode} from 'react';
import {ArrowRight,Check,Save} from 'lucide-react';
import type {Environment,NetworkConfig} from '../../shared/types.ts';
import {api,editConfig} from '../api.ts';
import {Button,Field,Modal,Notice,SectionHeading,dateLabel} from '../components.tsx';
import {IdentityEditor} from '../forms.tsx';
import {useEnvironmentNetwork} from '../EnvironmentStatus.tsx';
import {WindowsNetworkEditor} from './WindowsNetworkEditor.tsx';
import {AccessLatencyPanel} from '../AccessLatency.tsx';
import {exitVerified,freshReading,windowsGuardSummaryVerified} from '../environment-status.ts';

function WindowsNetworkWizard({environment,onClose,onSaved}:{environment:Environment;onClose:()=>void;onSaved:()=>Promise<void>}){
 const [network,setNetwork]=useState(environment.network),[step,setStep]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function save(){setBusy(true);setError('');try{await api.update(environment.id,{...editConfig(environment),network});await onSaved();setStep(2);}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
 return <Modal title="线路设置向导" subtitle={environment.name} onClose={()=>{if(!busy)onClose();}}><div className="modal-body wizard-body"><div className="wizard-progress">{['填写线路','确认配置','已保存'].map((label,index)=><span className={step===index?'active':''} key={label}>{index+1} · {label}</span>)}</div>{step===0?<><h3>使用本机或远程代理</h3><p>本机 Clash 使用 127.0.0.1 和实际监听端口；远程代理填写提供商地址。请同时填写你批准的出口 IPv4。</p><WindowsNetworkEditor value={network} onChange={setNetwork}/></>:step===1?<><h3>确认线路与访问边界</h3><dl className="facts"><div><dt>代理</dt><dd>{network.mode.toUpperCase()} · {network.host}:{network.port}</dd></div><div><dt>批准出口</dt><dd>{network.egressLock?.expectedIp||'尚未填写'}</dd></div><div><dt>联网防护</dt><dd>Linux 防火墙 · 透明代理 · 异常停机</dd></div></dl><Notice>保存配置后仍保持停止。下次启动时核验实际出口，通过后才开放联网。</Notice></>:<><h3>线路配置已保存</h3><p>启动环境后，查看防护与实际出口读数。</p></>}{error&&<Notice kind="error">{error}</Notice>}</div><footer className="modal-footer"><Button disabled={busy} onClick={step===1?()=>setStep(0):onClose}>{step===1?'上一步':'关闭'}</Button>{step===0?<Button className="primary" icon={<ArrowRight size={15}/>} disabled={!network.host||!network.egressLock?.expectedIp||network.mode==='https'&&!network.tls?.serverName} onClick={()=>setStep(1)}>确认配置</Button>:step===1?<Button className="primary" icon={<Check size={15}/>} loading={busy} onClick={()=>void save()}>保存线路</Button>:null}</footer></Modal>;
}

export function WindowsNetworkPanel({environment,refresh,disabled}:{environment:Environment;refresh:()=>Promise<void>;disabled:boolean}){
 const [network,setNetwork]=useState<NetworkConfig>(environment.network),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[wizard,setWizard]=useState(false);
 useEffect(()=>{setNetwork(environment.network);setMessage('');},[environment.id,environment.updatedAt]);
 const locked=disabled||environment.state==='running'||environment.browserRunning;const {egress,protection,egressError,protectionError}=useEnvironmentNetwork();
 const now=Date.now(),guardFresh=environment.state==='running'&&freshReading(protection?.checkedAt,now,15_000),guardVerified=windowsGuardSummaryVerified(environment,protection,true,now),exitCurrent=exitVerified(environment,egress,now);
 async function save(){setBusy(true);setError('');setMessage('');try{await api.update(environment.id,{...editConfig(environment),network});await refresh();setMessage('网络配置已保存');}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
 return <div className="panel-width network-panel"><SectionHeading title="网络出口" subtitle="先配置线路，再检查防护和实际出口" action={<div className="button-row"><Button disabled={locked||busy} onClick={()=>setWizard(true)}>线路设置向导</Button><Button className="primary" icon={<Save size={16}/>} disabled={locked} loading={busy} onClick={()=>void save()}>保存</Button></div>}/>
  <AccessLatencyPanel environment={environment} hostLabel="Windows"/>
  {locked&&<Notice>环境或浏览器运行中，停止后可修改网络</Notice>}<WindowsNetworkEditor value={network} disabled={locked||busy} passwordConfigured={environment.network.passwordConfigured} onChange={setNetwork}/>
  <section className="network-test"><SectionHeading title="出口核验状态"/><dl className="facts"><div><dt>批准出口</dt><dd className="mono">{environment.network.egressLock?.expectedIp??'--'}</dd></div><div><dt>最近检测</dt><dd>{exitCurrent?'检测一致':environment.state!=='running'?'环境未运行':'尚未确认'}</dd></div><div><dt>检测出口</dt><dd className="mono">{egress?.actualIp??'--'}</dd></div><div><dt>检测时间</dt><dd>{egress?.checkedAt?dateLabel(egress.checkedAt):'--'}</dd></div><div><dt>独立回执</dt><dd>{egress?.verification?`${egress.verification.receipts.length} 处${egress.verification.receipts.length>=2&&egress.verification.receipts.every(row=>row.ip===environment.network.egressLock?.expectedIp)?'一致':'不一致'} · ${egress.verification.receipts.map(row=>row.receiver).join(' / ')}`:'--'}</dd></div></dl>{egressError&&<Notice kind="error">{egressError}</Notice>}</section>
  <section className="network-test"><SectionHeading title="防护完整性"/><dl className="facts"><div><dt>整体状态</dt><dd>{guardVerified?'检测通过':environment.state==='running'?'尚未确认':'环境未运行'}</dd></div><div><dt>规则完整性</dt><dd>{guardFresh&&protection?.integrity==='verified'?'与已批准规则一致':'尚未核验'}</dd></div><div><dt>联网许可</dt><dd>{guardVerified?`有效 · 读取时剩余 ${Math.floor((protection?.leaseRemainingMs??0)/1000)} 秒`:guardFresh&&!protection?.leaseActive||environment.state!=='running'?'未开放':'尚未确认'}</dd></div></dl>{protectionError&&<Notice kind="error">{protectionError}</Notice>}</section>
  {error&&<Notice kind="error">{error}</Notice>}{message&&<Notice kind="success">{message}</Notice>}{wizard&&<WindowsNetworkWizard environment={environment} onClose={()=>setWizard(false)} onSaved={refresh}/>}
 </div>;
}

export function WindowsSettingsPanel({environment,refresh,disabled,children}:{environment:Environment;refresh:()=>Promise<void>;disabled:boolean;children:ReactNode}){
 const [draft,setDraft]=useState(()=>editConfig(environment)),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 useEffect(()=>{setDraft(editConfig(environment));setMessage('');},[environment.id,environment.updatedAt]);
 const locked=disabled||environment.state==='running'||environment.browserRunning;
 async function save(event:React.SubmitEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');setMessage('');try{await api.update(environment.id,draft);await refresh();setMessage('环境设置已保存');}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
 return <div className="panel-width"><form onSubmit={event=>void save(event)}><SectionHeading title="环境设置" action={<Button type="submit" className="primary" icon={<Save size={16}/>} disabled={locked} loading={busy}>保存</Button>}/>{locked&&<Notice>环境运行中或正在处理操作，停止后可修改配置</Notice>}
  <Field label="环境名称"><input required maxLength={60} value={draft.name} disabled={locked||busy} onChange={event=>setDraft(value=>({...value,name:event.target.value}))}/></Field><Field label="备注"><textarea maxLength={240} rows={3} value={draft.description} disabled={locked||busy} onChange={event=>setDraft(value=>({...value,description:event.target.value}))}/></Field>
  <div className="form-divider"><h3>地区设置</h3></div><IdentityEditor value={draft.identity} disabled={locked||busy} onChange={identity=>setDraft(value=>({...value,identity}))}/>
  <div className="form-divider"><h3>资源分配</h3></div><dl className="facts"><div><dt>CPU 核心</dt><dd>{environment.cpus}</dd></div><div><dt>内存</dt><dd>{environment.memoryGiB} GB</dd></div><div><dt>磁盘容量上限</dt><dd>{environment.diskGiB} GiB</dd></div><div><dt>文件访问</dt><dd>手动上传与下载 · 无持续共享</dd></div></dl><p className="muted">虚拟磁盘按使用情况增长，容量上限不等于当前占用；可在磁盘扩容中查看文件分配量。</p>
  {error&&<Notice kind="error">{error}</Notice>}{message&&<Notice kind="success">{message}</Notice>}</form>{children}</div>;
}
