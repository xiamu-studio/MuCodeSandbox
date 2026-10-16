import {useEffect,useState} from 'react';
import {ArrowDownToLine,ArrowRight,RefreshCw,ShieldAlert} from 'lucide-react';
import type {Environment} from '../shared/types.ts';
import {checkLabels,protectionLabels,protectionDisplayKind,probeProgress,recoverySteps,protectionExplanation,type ProtectionEvent} from '../shared/protection-events.ts';
import {api} from './api.ts';
import {Button,Notice} from './components.tsx';

export default function ProtectionEvents({environmentId,environment,compact=false,active=false,onConfigure,onRetry}:{environmentId:string;environment?:Environment;compact?:boolean;active?:boolean;onConfigure?:()=>void;onRetry?:()=>Promise<void>}){
 const [readError,setReadError]=useState(''),[loading,setLoading]=useState(true);
 const [events,setEvents]=useState<ProtectionEvent[]>([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retryEvent,setRetryEvent]=useState('');
 useEffect(()=>{
  let live=true,pending=false;const update=async()=>{if(pending)return;pending=true;try{const rows=await api.protectionEvents(environmentId);if(live){setEvents(rows);setReadError('');}}catch(e){if(live)setReadError((e as Error).message);}finally{pending=false;if(live)setLoading(false);}};
  setEvents([]);setReadError('');setLoading(true);setSelected('');setError('');setNotice('');void update();const timer=setInterval(()=>void update(),4000);return()=>{live=false;clearInterval(timer);};
 },[environmentId]);
 const unresolved=events[0]&&!events[0].resolvedAt?events[0]:undefined,candidate=compact?unresolved:events.find(e=>e.id===selected)??events[0];
 const readNotice=readError?<Notice kind="error">防护记录读取失败：{readError}。{events.length?'现有记录可能不是最新，稍后会自动重试。':'暂时无法确认是否有停机记录，稍后会自动重试。'}</Notice>:null;
 if(!candidate)return readNotice??(compact?null:<p className="muted">{loading?'正在读取防护记录…':'尚无防护停机记录。'}</p>);
 if(compact&&(!unresolved||environment?.state==='running'))return readNotice;
 const event=candidate;
 const kind=protectionDisplayKind(event),explanation=protectionExplanation(event);
 const reason=kind==='lease'?'应用未能及时确认沙箱防护状态，触发断网保护。':explanation.reason;
 const historyLabel=(row:ProtectionEvent)=>{const value=protectionDisplayKind(row);return value==='lease'?'防护状态未能及时确认':value==='exit-unavailable'?'出口 IP 没有确认成功':protectionLabels[value];};
 const canRetry=!!environment&&['error','stopped'].includes(environment.state)&&!active;
 const starting=busy||environment?.state==='starting';
 const at=(time:string)=>new Date(time).toLocaleString('zh-CN',{hour12:false});
 async function retry(){setRetryEvent(event.id);setBusy(true);setError('');setNotice('');try{if(onRetry)await onRetry();else await api.retryProtection(environmentId);setNotice('已启动正常恢复检查。通过核验后才会联网；失败会继续关闭访问并保留记录。');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 function download(){const data={scope:'本机保护性停机证据与恢复结果；不是全网络抓包或账号安全认证',exportedAt:new Date().toISOString(),event,displayKind:kind,repairSteps:recoverySteps(kind)};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='MuCodeSandbox-protection-'+event.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return <section className={`protection-event-card ${compact?'compact':''} ${event.resolvedAt?'resolved':'unresolved'}`}>
  <div className="protection-event-heading"><ShieldAlert size={22}/><div><h3>{compact?(environment?.state==='starting'?'正在重新核验':'断网保护'):'断网保护记录'}</h3><p className="protection-event-meta"><strong>{at(event.at)}</strong> · <span className="protection-event-summary">{reason}</span>{event.resolvedAt?' · 后来已恢复联网':''}</p></div><div className="button-row">
   {onConfigure&&<Button icon={<ArrowRight size={15}/>} onClick={onConfigure}>网络设置</Button>}
   {compact&&<Button className="primary" icon={<RefreshCw size={15}/>} disabled={!canRetry||busy} onClick={()=>void retry()}>{starting?'启动中':'启动环境'}</Button>}
  </div></div>
  {event.persisted===false&&<Notice kind="error">记录尚未成功保存。请下载诊断并检查磁盘空间。</Notice>}
  {event.resolution&&<p className="protection-event-recovered"><strong>{at(event.resolvedAt!)}</strong> 重新检查通过。</p>}
  {!compact&&<label className="field protection-history-picker"><span>过去的记录（最近100条）</span><select aria-label="选择防护事件" value={event.id} onChange={e=>setSelected(e.target.value)}>{events.map(row=><option key={row.id} value={row.id}>{at(row.at)} · {historyLabel(row)} · {row.resolvedAt?'已恢复联网':'待重新检查'}</option>)}</select></label>}
  <details className="protection-technical" key={event.id}><summary>技术详情</summary><div className="protection-event-details">
   <dl className="facts"><div><dt>{event.source==='legacy'?'当前线路参考':'当时线路'}</dt><dd>{event.route.mode.toUpperCase()} · {event.route.host}:{event.route.port}</dd></div><div><dt>{event.source==='legacy'?'当前批准 IP 参考':'批准出口 IP'}</dt><dd className="mono">{event.expectedIp??'未配置'}</dd></div><div><dt>当时检测到的 IP</dt><dd className="mono">{event.observedIps.join('、')||'当时没有保存 IP 检测结果'}</dd></div><div><dt>停止结果</dt><dd>{event.stopResult==='confirmed'?'已断网并停止沙箱':event.stopResult==='failed'?(/超时/.test(event.stopIssue??'')?'关闭操作超时，未收到完成确认':'未收到关闭完成确认'):event.stopResult==='requested'?'已请求停机':'旧版未留结构化结果'}</dd></div></dl>
   {event.source==='legacy'&&<Notice>这是旧版错误摘要。旧版没有保存各端结果和当时线路快照；上方线路是当前配置参考，没有补造历史回执。</Notice>}
   {event.checks.length>0?<div className="network-table-wrap"><table className="network-table"><thead><tr><th>检测端</th><th>结果 / 连接阶段</th><th>回执 IP</th><th>命令耗时</th></tr></thead><tbody>{event.checks.map(check=><tr key={check.receiver}><td>{check.receiver}</td><td>{checkLabels[check.status]}{check.ip&&event.expectedIp&&check.ip!==event.expectedIp?' · 不匹配':''}{check.diagnostics&&<div className="muted egress-probe-progress" title={`TCP ${check.diagnostics.tcpConnectMs} ms；TLS ${check.diagnostics.tlsHandshakeMs} ms；首字节 ${check.diagnostics.firstByteMs} ms；请求总耗时 ${check.diagnostics.totalMs} ms。阶段时间从请求开始计；通过代理时TCP连接不代表已连接目的站。`}>{probeProgress(check)} · curl {check.diagnostics.curlExitCode}</div>}</td><td className="mono">{check.ip??'未获得'}</td><td>{check.latencyMs===undefined?'—':check.latencyMs+' ms'}</td></tr>)}</tbody></table></div>:null}
   {!['host','lease'].includes(kind)&&<div className="protection-repair-steps"><h4>如何修复</h4><ol>{recoverySteps(kind).map(step=><li key={step}>{step}</li>)}</ol></div>}
   <div className="button-row"><Button icon={<ArrowDownToLine size={15}/>} onClick={download}>下载这次诊断</Button>{!compact&&environment&&<Button className="primary" icon={<RefreshCw size={15}/>} disabled={!canRetry||busy} onClick={()=>void retry()}>{starting?'启动中':'启动环境'}</Button>}</div>
  </div></details>
  {readNotice}{error&&<Notice kind="error">{error}</Notice>}{notice&&retryEvent===event.id&&environment?.state==='starting'&&<Notice>{notice}</Notice>}
 </section>;
}
