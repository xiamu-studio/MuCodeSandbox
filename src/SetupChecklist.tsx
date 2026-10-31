import { ArrowRight, Check, Circle, Compass } from 'lucide-react';
import type { Snapshot } from '../shared/types.ts';
export function SetupChecklist({snapshot,onCreate,onSystem,onNetwork,onBrowser,onHelp,requireSandboxStart=false}:{requireSandboxStart?:boolean;snapshot:Snapshot;onCreate:()=>void;onSystem:()=>void;onNetwork:(id:string)=>void;onBrowser:(id:string)=>void;onHelp:()=>void}){
  const e=snapshot.environments.find(e=>e.kind==='vm');
  const configured=!!e&&e.network.strict&&!!e.network.transparent;
  const started=!requireSandboxStart||e?.state==='running';
  const steps=[{name:'运行组件',done:snapshot.system.runtime.available,action:onSystem},
    {name:'Linux 沙箱',done:!!e,action:onCreate},
    {name:'代理与防护',done:configured&&started,action:()=>e?onNetwork(e.id):onCreate()},
    {name:'打开浏览器',done:!!e?.browserRunning&&started,action:()=>e?onBrowser(e.id):onCreate()}];
  const next=steps.find(s=>!s.done);
  return <section className="setup-checklist"><div className="setup-intro"><span className="setup-compass"><Compass size={22}/></span><div><h2>{next?'开始使用你的沙箱':'工作环境已准备'}</h2><p>{next?requireSandboxStart&&configured&&!started&&next.name==='代理与防护'?'下一步：启动环境并核验出口。通过后再打开浏览器。':`下一步：${next.name}。全程可以先不登录真实账号。`:'防护结果以环境内实时核验为准。'}</p></div><button className="text-button" onClick={onHelp}>查看指南<ArrowRight size={14}/></button></div>
    <div className="setup-steps">{steps.map((s,i)=><button key={s.name} onClick={s.action} className={s.done?'done':''}><span>{s.done?<Check size={14}/>:i+1}</span><strong>{s.name}</strong>{!s.done&&<Circle size={7}/>}</button>)}</div>
  </section>;
}
