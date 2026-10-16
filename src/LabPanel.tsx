import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, Check, FlaskConical, Globe, LoaderCircle, Play, RefreshCw, ShieldCheck, Square, X } from 'lucide-react';
import type { LabInfo, LocalCheckReport, Snapshot } from '../shared/types.ts';
import { api } from './api.ts';
import { Button, IconButton, Notice, SectionHeading, dateLabel } from './components.tsx';

export function LabPanel({snapshot,refresh,onConfigure}:{snapshot:Snapshot;refresh:()=>Promise<void>;onConfigure:(id:string)=>void}){
  const [lab,setLab]=useState<LabInfo>({running:false}),[receipts,setReceipts]=useState<{id:string;result:unknown}[]>([]);
  const [reports,setReports]=useState<LocalCheckReport[]>([]),[selected,setSelected]=useState(()=>snapshot.environments.find(e=>e.kind==='vm')?.id??'');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const update=useCallback(async()=>{const [info,records,checks]=await Promise.all([api.lab(),api.labReceipts(),api.localChecks()]);setLab(info);setReceipts(records.receipts);setReports(checks);},[]);
  useEffect(()=>{let live=true;const poll=()=>update().catch(e=>{if(live)setError(e.message);});void poll();const timer=setInterval(()=>void poll(),3000);return()=>{live=false;clearInterval(timer);};},[update]);
  const environment=snapshot.environments.find(e=>e.id===selected),active=snapshot.jobs.find(j=>j.environmentId===selected&&j.status==='running');
  const canRun=!!environment&&environment.state==='running'&&environment.network.strict&&environment.network.transparent&&!active;
  const report=reports.find(r=>r.environmentId===selected);
  async function check(){setBusy(true);setError('');try{await api.checkEnvironment(selected);await refresh();await update();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function toggle(){setBusy(true);setError('');try{await(lab.running?api.stopLab():api.startLab());await update();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function openControl(){setBusy(true);setError('');try{const e=await api.create({name:'本机检测对照',kind:'browser',color:'blue',browserUrl:lab.url,identity:{locale:'en-US',timezone:'America/New_York'}});await api.browser(e.id,'open');await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  function download(){const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='MuCodeSandbox-local-check.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return <><header className="page-header"><div><div className="eyebrow">不用真实账号</div><h1>检测实验室</h1><p>确认环境，再检查本地浏览器与模拟任务。</p></div><span className="account-free-badge"><ShieldCheck size={15}/>付费请求 0</span></header>
    <section className="lab-run-card"><div className="lab-run-heading"><span className="setup-compass"><FlaskConical size={24}/></span><div><h2>沙箱无账号检测</h2><p>所选 Linux 环境 · 不登录 Claude · 不调用付费模型</p></div></div>
      <div className="lab-run-controls"><label className="field"><span>检测环境</span><select value={selected} onChange={e=>setSelected(e.target.value)}>{!selected&&<option value="">选择 Linux 沙箱</option>}{snapshot.environments.filter(e=>e.kind==='vm').map(e=><option key={e.id} value={e.id}>{e.name}{e.state!=='running'?' · 已停止':!e.network.strict?' · 未启用防护':''}</option>)}</select></label><Button className="primary" icon={<Play size={15}/>} loading={busy||active?.action==='lab-check'} disabled={!canRun} onClick={()=>void check()}>运行无账号检测</Button></div>
      {!canRun&&!active&&<div className="lab-prerequisite"><span>{!environment?'先创建 Linux 沙箱':environment.state!=='running'?'需要先配置线路并启动环境':'需要强制防护与透明代理'}</span>{environment&&<button className="text-button" onClick={()=>onConfigure(environment.id)}>前往线路设置</button>}</div>}
      <p className="scope-caption">范围：实时防护、浏览器上下文、合成登录和本地模拟模型。公网出口、实际 DNS / WebRTC 泄漏须另验。</p>
    </section>
    {report&&<section className="lab-report-card"><SectionHeading title="本次检测结果" subtitle={`${report.environmentName} · ${dateLabel(report.checkedAt)}`} action={<div className="button-row"><span className={`report-state ${report.state}`}>{report.state==='running'?'检测中':report.state==='passed'?'本地分项通过':'需要检查'}</span><IconButton title="下载检测报告" disabled={report.state==='running'} onClick={download}><ArrowDownToLine size={17}/></IconButton></div>}/><div className="check-results">{report.checks.map(c=><div className={c.passed?'passed':'failed'} key={c.name}>{c.passed?<Check size={17}/>:<X size={17}/>}<div><strong>{c.name}</strong><p>{c.detail}</p></div><span>{c.passed?'通过':'未通过'}</span></div>)}</div>{report.state==='running'&&<p className="checking-caption"><LoaderCircle size={15} className="spin"/>正在读取实际结果…</p>}{report.error&&<Notice kind="error">{report.error}</Notice>}<p className="scope-caption">{report.scope}</p></section>}
    {error&&<Notice kind="error">{error}</Notice>}
    <details className="lab-advanced"><summary>本机对照与原始接收端</summary><p>此入口打开 Mac 本机浏览器，用于对照，不受 Linux 防火墙保护。</p><div className="button-row"><Button icon={lab.running?<Square size={15}/>:<Play size={15}/>} loading={busy} onClick={()=>void toggle()}>{lab.running?'停止':'启动'}</Button><Button icon={<Globe size={16}/>} disabled={!lab.running||busy} onClick={()=>void openControl()}>打开本机对照浏览器</Button></div><dl className="facts"><div><dt>本机页面</dt><dd className="mono path-text">{lab.url??'--'}</dd></div><div><dt>DNS / STUN</dt><dd>{lab.dnsPort??'--'} / {lab.stunPort??'--'}</dd></div><div><dt>事件 / 模拟调用</dt><dd>{lab.eventCount??0} / {lab.modelCalls??0}</dd></div></dl><SectionHeading title="原始报告" action={<IconButton title="刷新报告" onClick={()=>void update()}><RefreshCw size={16}/></IconButton>}/>{receipts.length?receipts.map(r=><details className="lab-record" key={r.id}><summary>{r.id}</summary><pre>{JSON.stringify(r.result,null,2)}</pre></details>):<p className="muted">暂无原始报告</p>}</details>
  </>;
}
