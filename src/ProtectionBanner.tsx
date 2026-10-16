import { ArrowRight, ShieldCheck, ShieldAlert, LoaderCircle } from 'lucide-react';
import type { Environment } from '../shared/types.ts';
import { useEnvironmentNetwork } from './EnvironmentStatus.tsx';
import { protectionVerified } from './environment-status.ts';

export function ProtectionBanner({environment,onConfigure}:{environment:Environment;onConfigure:()=>void}){
  const { protection, protectionError: issue } = useEnvironmentNetwork();
  if(environment.state!=='running')return null;
  const strict=environment.kind==='vm'&&environment.network.strict;
  const verified=protectionVerified(environment,protection);
  const title=environment.kind!=='vm'?'本机浏览器 · 独立资料':!strict?'直连环境 · 未启用强制防护':verified?'沙箱防护已核验':issue||protection?'防护尚未通过':'正在核验防护';
  const detail=environment.kind!=='vm'?'不受 Linux 沙箱防火墙保护':!strict?'先设置代理线路，再启用强制防护':verified?'':issue||protection?.issues?.[0]||'';
  const checking=strict&&environment.state==='running'&&!issue&&!protection;
  const compact=verified;
  return <div className={`protection-banner ${verified?'verified':!strict?'unprotected':'pending'} ${compact?'compact':''}`}>
    <span className="protection-icon">{checking?<LoaderCircle size={20} className="spin"/>:verified?<ShieldCheck size={22}/>:<ShieldAlert size={22}/>}</span>
    <div><strong>{title}</strong>{detail&&<p>{detail}</p>}</div>
    <button onClick={onConfigure}>线路与防护<ArrowRight size={15}/></button>
  </div>;
}
