import { useCallback, useEffect, useState } from 'react';
import { Copy, FolderOpen, Link2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { HOST_COMMANDS, type BridgeGrant, type Environment, type HostCommand } from '../shared/types.ts';
import { api } from './api.ts';
import { Button, Field, IconButton, Notice, SectionHeading } from './components.tsx';
export function BridgePanel({environment,active,refresh}:{environment:Environment;active:boolean;refresh:()=>Promise<void>}) {
  const commandLabels:Record<HostCommand,string>={'git-status':'Git 状态','git-diff':'Git 文件差异','git-log':'Git 最近提交'};
  const [grants,setGrants]=useState<BridgeGrant[]>([]),[root,setRoot]=useState(''),[writable,setWritable]=useState(false),[minutes,setMinutes]=useState(60);
  const [commands,setCommands]=useState<HostCommand[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState('');
  const update=useCallback(async()=>setGrants(await api.bridgeGrants(environment.id)),[environment.id]);
  useEffect(()=>{let live=true;const poll=()=>update().catch(e=>{if(live)setError(e.message)});void poll();const timer=setInterval(()=>void poll(),3000);return()=>{live=false;clearInterval(timer)};},[update]);
  const disabled=busy||active;
  async function pick(){try{const result=await api.pickDirectory();if(result.path)setRoot(result.path);}catch(e){setError((e as Error).message);}}
  async function grant(){setBusy(true);setError('');try{await api.grantBridge(environment.id,root.trim(),writable,minutes,commands);setRoot('');setCommands([]);await refresh();await update();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function revoke(id:string){setBusy(true);setError('');try{await api.revokeBridge(environment.id,id);await refresh();await update();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function copy(grant:BridgeGrant){try{await navigator.clipboard.writeText(`mu-host ${grant.id} list`);setCopied(grant.id);}catch(e){setError((e as Error).message);}}
  return <div className="panel-width"><SectionHeading title="宿主目录授权" action={<IconButton title="刷新授权" onClick={()=>void update().catch(e=>setError(e.message))}><RefreshCw size={17}/></IconButton>}/>
    <Field label="本机目录"><div className="input-action"><input aria-label="授权的本机目录" value={root} disabled={disabled} onChange={e=>setRoot(e.target.value)}/><IconButton title="选择授权目录" disabled={disabled} onClick={()=>void pick()}><FolderOpen size={17}/></IconButton></div></Field>
    <div className="form-grid"><Field label="目录权限"><div className="segmented"><button className={!writable?'selected':''} disabled={disabled} onClick={()=>setWritable(false)}>只读</button><button className={writable?'selected':''} disabled={disabled} onClick={()=>setWritable(true)}>读写</button></div></Field><Field label="有效时间"><select aria-label="授权有效时间" value={minutes} disabled={disabled} onChange={e=>setMinutes(Number(e.target.value))}>{[15,60,240,480].map(value=><option key={value} value={value}>{value<60?`${value} 分钟`:`${value/60} 小时`}</option>)}</select></Field></div>
    <fieldset className="field host-command-field"><legend>本机命令授权</legend><div className="host-command-options">{HOST_COMMANDS.map(command=><label className="check-label" key={command}><input type="checkbox" checked={commands.includes(command)} disabled={disabled} onChange={e=>setCommands(previous=>e.target.checked?[...previous,command]:previous.filter(item=>item!==command))}/>{commandLabels[command]}</label>)}</div></fieldset>
    <div className="button-row"><Button icon={<Link2 size={16}/>} className="primary" loading={busy} disabled={disabled||environment.state!=='running'||!root.trim()} onClick={()=>void grant()}>授权目录</Button></div>
    <dl className="facts"><div><dt>访问范围</dt><dd>列目录、读取、校验{writable?'、写入':''}</dd></div><div><dt>单文件上限</dt><dd>1 MB</dd></div><div><dt>命令权限</dt><dd>{commands.length?'所选 Git 操作 · 只读 · 禁止联网':'关闭'}</dd></div><div><dt>环境停止后</dt><dd>自动撤销</dd></div></dl>
    <section className="network-test">{grants.length?grants.map(grant=><div className="job-row" key={grant.id}><ShieldCheck size={18}/><div className="job-main"><strong className="path-text">{grant.root}</strong><small>{grant.writable?'读写':'只读'} · {new Date(grant.expiresAt).toLocaleTimeString()} 到期 · {grant.guestReady?'已连接':'连接中'}</small>{!!grant.commands?.length&&<small>{grant.commands.map(command=>commandLabels[command]).join(' · ')}</small>}</div><IconButton title={copied===grant.id?'已复制':'复制终端访问命令'} onClick={()=>void copy(grant)}><Copy size={16}/></IconButton><IconButton title="撤销目录授权" disabled={disabled} onClick={()=>void revoke(grant.id)}><Trash2 size={16}/></IconButton></div>):<div className="log-empty">暂无宿主授权</div>}</section>
    {error&&<Notice kind="error">{error}</Notice>}
  </div>;
}
