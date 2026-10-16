import { useEffect, useState } from 'react';
import { ArrowRight, Check, Compass, RefreshCw } from 'lucide-react';
import type { Environment, NetworkConfig } from '../shared/types.ts';
import { api, editConfig } from './api.ts';
import { Button, Field, Modal, Notice } from './components.tsx';

export function NetworkWizard({environment,onClose,onSaved}:{environment:Environment;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [local,setLocal]=useState<Awaited<ReturnType<typeof api.localProxy>>|null>(null);
  const [mode,setMode]=useState<'local'|'remote'>('local');const [node,setNode]=useState('');
  const [host,setHost]=useState(environment.network.host||'127.0.0.1');const [port,setPort]=useState(environment.network.port||7897);
  const [protocol,setProtocol]=useState<'http'|'socks5'>('http');const [username,setUsername]=useState('');const [password,setPassword]=useState('');
  const [step,setStep]=useState(0);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  useEffect(()=>{let live=true;void api.localProxy().then(value=>{if(live){setLocal(value);setNode(value.nodes.find(n=>/Vietnam|越南|🇻🇳/i.test(n.name))?.name??value.nodes[0]?.name??'');const ready=value.ports.find(p=>p.ready);if(ready)setPort(ready.port);}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[]);
  async function save(){
    setBusy(true);setError('');
    try{
      let targetHost=mode==='local'?'127.0.0.1':host.trim(),targetPort=port;
      if(mode==='local'&&node){const line=await api.startLocalLine(node);targetPort=line.port;}
      const network:NetworkConfig={mode:protocol,host:targetHost,port:targetPort,username:mode==='remote'?username:'',
        password:mode==='remote'?password:'',noProxy:'localhost,127.0.0.1,::1',strict:true,transparent:true,
        dns:{address:'1.1.1.1',serverName:'cloudflare-dns.com',port:443,path:'/dns-query'}};
      await api.update(environment.id,{...editConfig(environment),network});await onSaved();setStep(2);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <Modal title="线路设置向导" subtitle={`${environment.name} · Linux 沙箱`} onClose={busy?()=>{}:onClose}>
    <div className="modal-body wizard-body"><div className="wizard-progress">{['选择线路','确认配置','保存完成'].map((name,i)=><span key={name} className={step===i?'active':step>i?'done':''}><b>{step>i?<Check size={13}/>:i+1}</b>{name}</span>)}</div>
      {step===0?<><h3>这次用哪条线路？</h3><div className="segmented"><button className={mode==='local'?'selected':''} onClick={()=>setMode('local')}>本机代理</button><button className={mode==='remote'?'selected':''} onClick={()=>setMode('remote')}>远程代理</button></div>
        {mode==='local'?<><Notice>使用独立节点时，本应用启动专用回环端口，所有目的地都走该节点，不更改 Clash 原有全局选择。</Notice>
          {local===null?<p className="muted">正在检测本机代理…</p>:local.available?<Field label="独立线路节点"><select value={node} onChange={e=>setNode(e.target.value)}><option value="">沿用本机代理当前规则</option>{local.nodes.map(n=><option key={n.name} value={n.name}>{n.name}</option>)}</select></Field>:<p className="muted">未找到可读取的 Clash 节点，也可以手动填写本机代理端口。</p>}
          {!node&&<Field label="本机代理端口"><input type="number" min={1} max={65535} value={port} onChange={e=>setPort(Number(e.target.value))}/></Field>}
          <p className="wizard-note">节点名称不证明真实位置。保存后到“实际出口”检查国家与 IP。</p>
        </>:<><Field label="代理地址"><input value={host} onChange={e=>setHost(e.target.value)} autoComplete="off"/></Field><Field label="代理端口"><input type="number" min={1} max={65535} value={port} onChange={e=>setPort(Number(e.target.value))}/></Field><div className="form-grid"><Field label="用户名"><input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="off"/></Field><Field label="密码"><input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password" placeholder="只在本机应用中填写"/></Field></div></>}
        <Field label="代理协议"><select value={protocol} onChange={e=>setProtocol(e.target.value as typeof protocol)}><option value="http">HTTP</option><option value="socks5">SOCKS5</option></select></Field>
      </>:step===1?<><span className="wizard-symbol"><Compass size={32}/></span><h3>强制防护将随线路一起配置</h3><dl className="facts"><div><dt>线路</dt><dd>{mode==='local'?node||`本机端口 ${port}`:`${host}:${port}`}</dd></div><div><dt>接管方式</dt><dd>Linux 防火墙 + 透明代理</dd></div><div><dt>DNS</dt><dd>经代理的加密 DNS</dd></div><div><dt>失败处理</dt><dd>拒绝访问，不降级直连</dd></div></dl><Notice>这一步只保存配置。启动后仍需要核验防护和实际出口；默认不设置固定 IP 锁定，避免把动态出口误判为故障。</Notice></>:<><span className="wizard-symbol"><Check size={32}/></span><h3>线路配置已保存</h3><p>下一步启动环境，点击“检测防护”和“检测出口”。两项结果都确认后，再打开浏览器。</p></>}
      {error&&<Notice kind="error">{error}</Notice>}
    </div><footer className="modal-footer">{step===1&&<Button disabled={busy} onClick={()=>setStep(0)}>上一步</Button>}{step===0?<Button className="primary" icon={<ArrowRight size={15}/>} disabled={!Number.isInteger(port)||port<1||port>65535||mode==='remote'&&!host.trim()} onClick={()=>setStep(1)}>下一步</Button>:step===1?<Button className="primary" loading={busy} onClick={()=>void save()}>保存线路配置</Button>:<Button className="primary" onClick={onClose}>完成</Button>}</footer>
  </Modal>;
}
