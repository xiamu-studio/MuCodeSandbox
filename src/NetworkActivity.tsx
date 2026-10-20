import { useEffect, useRef,useState } from 'react';
import { ArrowDownToLine, ChevronDown, History, RefreshCw, Network,Pause,Play } from 'lucide-react';
import type { NetworkObservations } from '../shared/network-observations.ts';
import { api } from './api.ts';
import { Button, Notice, SectionHeading } from './components.tsx';

const labels={waiting:'等待检测结果',unchanged:'检测到的 IP 未变化',changed:'检测到不同出口 IP',failed:'最近一次检测失败',stale:'检测结果较旧，等待刷新'};
const time=(at:string|null)=>at?new Date(at).toLocaleTimeString('zh-CN',{hour12:false}):'—';
function duration(first:string|null,last:string|null){if(!first||!last)return '—';const seconds=Math.max(0,Math.round((Date.parse(last)-Date.parse(first))/1000));return seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;}
export function NetworkActivity({environmentId}:{environmentId:string}) {return <NetworkActivityContent key={environmentId} environmentId={environmentId}/>;}
function NetworkActivityContent({environmentId}:{environmentId:string}) {
  const [data,setData]=useState<NetworkObservations|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [search,setSearch]=useState(''),[failuresOnly,setFailuresOnly]=useState(false),[history,setHistory]=useState(false);
  const [query,setQuery]=useState(''),[scope,setScope]=useState<'traffic'|'checks'|'all'>('traffic'),[before,setBefore]=useState<number|undefined>(),[pages,setPages]=useState<(number|undefined)[]>([]),[updating,setUpdating]=useState(false);
  const [paused,setPaused]=useState(false),[view,setView]=useState<'list'|'table'>('list'),pausedRef=useRef(false);pausedRef.current=paused;
  const currentQuery=JSON.stringify([environmentId,query,scope,failuresOnly,before]),queryRef=useRef(currentQuery);queryRef.current=currentQuery;
  useEffect(()=>{const timer=setTimeout(()=>setQuery(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{
    let live=true,pending=false;
    const update=async(manual=false)=>{if(pending||(!manual&&pausedRef.current))return;pending=true;setUpdating(true);try{const next=await api.networkObservations(environmentId,{q:query,scope,failures:failuresOnly,before});if(live&&(manual||!pausedRef.current)){setData(next);setError('');}}catch(e){if(live&&(manual||!pausedRef.current))setError((e as Error).message);}finally{pending=false;if(live)setUpdating(false);}};
    void update(true);const timer=setInterval(()=>void update(),5000);return()=>{live=false;clearInterval(timer);};
  },[environmentId,query,scope,failuresOnly,before]);
  async function sample(){const stamp=currentQuery;setBusy(true);setError('');try{await api.sampleNetwork(environmentId);if(queryRef.current!==stamp)return;const next=await api.networkObservations(environmentId,{q:query,scope,failures:failuresOnly,before});if(queryRef.current===stamp)setData(next);}catch(e){if(queryRef.current===stamp)setError((e as Error).message);}finally{setBusy(false);}}
  function resetPage(){setBefore(undefined);setPages([]);}
  function download(){if(!data)return;const blob=new Blob([JSON.stringify({scope:'当前页的 Linux 透明代理连接与 DNS 元数据，附当时最近的出口核验回执；不是浏览历史或每条连接的真实公网来源证明',...data},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='MuCodeSandbox-network.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const summary=data?.summary;
  const shown=data?.connections.filter(c=>(!failuresOnly||c.status==='failed')&&`${c.target}:${c.port} ${c.domain??''} ${c.domainCandidates?.join(' ')??''} ${c.exitIp??''}`.toLowerCase().includes(search.trim().toLowerCase()))??[];
  return <div className="network-activity">
    <SectionHeading title="出口 IP 检测记录" action={<div className="button-row"><Button icon={<RefreshCw size={16}/>} onClick={()=>void sample()} loading={busy} disabled={!data?.enabled}>立即检测</Button><Button icon={<ArrowDownToLine size={16}/>} onClick={download} disabled={!data}>下载网络记录</Button></div>}/>
    {error&&<Notice kind="error">{error}</Notice>}
    <div className={`exit-observation exit-${data?.enabled===false?'stopped':summary?.state??'waiting'}`}>
      <div className="exit-observation-main"><span className="exit-observation-label">上次检测到的出口 IP</span><strong className="mono">{summary?.lastIp??'尚未检测到 IP'}</strong><span className="exit-observation-state">{data?.enabled===false?'沙箱已停止，暂停检测':labels[summary?.state??'waiting']}</span><small>上次检测 {time(summary?.lastCheckedAt??null)}{data?.enabled?' · 运行时约每 30 秒检测一次':''}</small></div>
      <div className="exit-observation-metrics"><div><span>记录时间跨度</span><strong>{duration(summary?.firstCheckedAt??null,summary?.lastCheckedAt??null)}</strong></div><div><span>检测成功 / 失败</span><strong>{summary?.successes??0} / {summary?.failures??0}</strong></div><div><span title="1 表示记录中只有一个 IP，不是新增了一个 IP">记录过的 IP 数量</span><strong>{summary?.distinctIps??0}</strong></div><div><span>IP 变化次数</span><strong>{summary?.changes??0}</strong></div></div>
    </div>
    <p className="network-observation-note">{data?.lockIp?`固定出口 IP：${data.lockIp}`:'未锁定出口 IP'}。这里保留过去的检测结果。</p>
    <details className="network-observation-note"><summary>检测说明</summary><p>“回执”就是检测网站返回的 IP 结果。完整的联网检查请看网络页“出口核验状态”。单个检测网站失败不等于整个出口检查失败；记录也不能证明所有网站都看到同一 IP。时间按本机时区显示。</p></details>
    <Button className="observation-history-toggle" icon={<History size={16}/>} onClick={()=>setHistory(!history)} aria-expanded={history}><span>{history?'收起':'查看'}检测历史</span><span className="observation-history-count">最近 {data?.samples.length??0} 条结果</span><ChevronDown size={15} className="observation-history-chevron" aria-hidden="true"/></Button>
    {history&&<div className="network-table-wrap"><table className="network-table"><thead><tr><th>检测时间</th><th>接收端</th><th>出口回执</th><th>结果</th><th>耗时</th></tr></thead><tbody>{[...(data?.samples??[])].reverse().map(s=><tr key={s.id}><td>{time(s.at)}</td><td>{s.provider==='ipwho'?'IPwho':'ipify'}</td><td className="mono">{s.ip??'未获得 IP'}</td><td><span className={`connection-result ${s.status==='failed'?'failed':''}`}>{s.status==='success'?'收到回执':'检测失败'}</span></td><td>{s.latencyMs!==undefined?`${s.latencyMs} ms`:'—'}</td></tr>)}</tbody></table></div>}
    <div className="network-connections-heading"><SectionHeading title="网络连接与 DNS" action={<div className="button-row"><span className={`capture-state ${data?.capture==='error'?'failed':''}`}><Network size={14}/>{paused?'已暂停自动刷新':data?.enabled===false?'沙箱已停止，暂停采集':data?.capture==='ready'?'连接采集运行中':data?.capture==='error'?'采集出现中断':data?.capture==='unsupported'?'此模式暂无连接明细':'等待采集'}</span><Button aria-pressed={paused} icon={paused?<Play size={14}/>:<Pause size={14}/>} onClick={()=>setPaused(value=>!value)}>{paused?'恢复自动刷新':'暂停自动刷新'}</Button></div>}/></div>
    {data?.captureIssue&&<Notice kind="error">{data.captureIssue}</Notice>}
    {!!data?.captureGaps&&<Notice>保留的观察窗口中有 {data.captureGaps} 次采集缺口，请勿把这份记录视为完整抓包。</Notice>}
    <p className="network-observation-note">检测流量已单独归类。这里不是浏览历史；网页复用旧连接时，可能没有新记录。</p>
    <div className="network-connection-controls"><input className="input" placeholder="搜索已保留的域名、服务器或出口 IP" aria-label="搜索网络连接" value={search} onChange={e=>{setSearch(e.target.value);resetPage();}}/><select aria-label="连接类型" value={scope} onChange={e=>{setScope(e.target.value as typeof scope);resetPage();}}><option value="traffic">网站与其他连接</option><option value="checks">出口检测</option><option value="all">全部连接</option></select><label className="check-label"><input type="checkbox" checked={failuresOnly} onChange={e=>{setFailuresOnly(e.target.checked);resetPage();}}/>只看失败</label><select aria-label="连接展示方式" value={view} onChange={e=>setView(e.target.value as typeof view)}><option value="list">简洁列表</option><option value="table">明细表格</option></select><span>{updating||query!==search.trim()?'正在读取…':`本页 ${shown.length} 条${data?.connectionPage?` · 匹配共 ${data.connectionPage.total} 条`:''}`} · 最近采集 {time(data?.collectedAt??null)}</span></div>
    {view==='list'&&<div className="network-connection-list" role="list" aria-label="网络连接记录">{[...shown].reverse().map(c=>{
      const ipTarget=/^(?:\d{1,3}\.){3}\d{1,3}$/.test(c.target)||c.target.includes(':'),domain=c.domain??(!ipTarget?c.target:null);
      return <article role="listitem" className="network-connection-row" key={c.id}>
        <div className="network-connection-content">
          <div className="network-connection-meta"><time dateTime={c.at}>{new Date(c.at).toLocaleString('zh-CN',{hour12:false})}</time><span className={`connection-result ${c.status==='failed'?'failed':''}`}>{c.status==='failed'?'连接失败':c.status==='dns-cached'?'DNS 缓存':c.status==='dns-result'?'DNS 结果':'发起连接'}</span></div>
          <div className="network-connection-main"><span>[{c.protocol}]</span><strong className="mono">{domain??c.target}{c.protocol==='DNS'?'':`:${c.port}`}</strong><span>→ {c.route==='proxy-dns'?'受控 DNS':'沙箱代理'}</span></div>
          <div className="network-connection-secondary">{ipTarget&&<span className="mono">网站服务器 IP {c.target}</span>}{c.domainSource==='dns'&&<span>域名来自 DNS 对照</span>}{!domain&&ipTarget&&<span>{c.domainCandidates?.length?`可能域名：${c.domainCandidates.join('、')}（不能确认）`:'域名未识别'}</span>}<details><summary>详情</summary><p>{c.exitIp?`出口来自这条记录发生前最近一次有效的${c.exitSource==='verification'?'核验':'检测'}，不是目的网站确认的出口。`:'当时没有留下有效出口检测结果。'}{c.origin==='exit-check'?' 来源：出口检测入口。':c.origin==='traffic'?' 来源：沙箱连接。':''}</p></details></div>
        </div>
        <div className="network-connection-exit" aria-label="当时检测出口">
          <span>当时检测出口</span>
          {c.exitIp?<><strong className="mono">{c.exitIp}</strong><time dateTime={c.exitCheckedAt??undefined}>检测 {time(c.exitCheckedAt??null)}</time></>:<><strong className="network-cell-muted">未记录</strong><small>不以当前 IP 补填</small></>}
        </div>
      </article>;
    })}</div>}
    {view==='table'&&<div className="network-table-wrap"><table className="network-table network-connections-table"><thead><tr><th>时间</th><th>目标网址<span className="network-column-note">网站域名 · 服务器 IP</span></th><th>类型 / 端口</th><th>沙箱出口 IP<span className="network-column-note">当时最近核验回执</span></th><th>事件</th></tr></thead><tbody>{[...shown].reverse().map(c=>{
      const ipTarget=/^(?:\d{1,3}\.){3}\d{1,3}$/.test(c.target)||c.target.includes(':');
      const domain=c.domain??(!ipTarget?c.target:null);
      return <tr key={c.id}><td title={c.at}>{new Date(c.at).toLocaleString('zh-CN',{hour12:false})}</td><td className="network-target"><strong className="mono">{domain??(c.domainCandidates?.length?'域名不确定':'域名未识别')}</strong>
        {ipTarget&&<span className="network-cell-note mono">网站服务器 IP {c.target}</span>}
        {c.domainSource==='dns'&&<span className="network-cell-note" title="域名来自未过期的 DNS 对照，不能确认这条连接的具体网站请求">DNS 对照</span>}
        {!!c.domainCandidates?.length&&<span className="network-cell-note" title={c.domainCandidates.join('、')}>可能域名：{c.domainCandidates.join('、')}（共享 IP，不能确认）</span>}
        {c.protocol==='DNS'&&<span className="network-cell-note">域名解析事件</span>}
      </td><td>{c.protocol==='DNS'?'DNS 解析':`${c.port} / ${c.protocol}`}</td><td className="network-exit-cell">{c.exitIp?<><strong className="mono">{c.exitIp}</strong><span className="network-cell-note" title={`回执时间 ${c.exitCheckedAt}；此 IP 来自检测接收端，并非这条连接目的网站的确认`}>{c.exitSource==='verification'?'核验':'检测'} {time(c.exitCheckedAt??null)}</span></>:<><span className="network-cell-muted">未留有效回执</span><span className="network-cell-note">不以当前 IP 补填历史</span></>}</td><td><span className={`connection-result ${c.status==='failed'?'failed':''}`}>{c.status==='failed'?'连接失败':c.status==='dns-cached'?'命中 DNS 缓存':c.status==='dns-result'?'获得 DNS 结果':'发起代理连接'}</span></td></tr>;
    })}</tbody></table></div>}
    {!shown.length&&<div className="network-records-empty">{updating?'正在搜索已保留的记录…':data?.capture==='ready'?'没有匹配记录，可切换“全部连接”再查；不能据此判断没有访问。':'连接明细尚不可用，不能据此判断没有访问'}</div>}
    {data?.connectionPage&&<div className="button-row network-connection-pages"><Button disabled={updating||query!==search.trim()||!pages.length} onClick={()=>{setBefore(pages.at(-1));setPages(value=>value.slice(0,-1));}}>上一页</Button><span>第 {pages.length+1} 页</span><Button disabled={updating||query!==search.trim()||!data.connectionPage.nextBefore} onClick={()=>{setPages(value=>[...value,before]);setBefore(data.connectionPage!.nextBefore!);}}>下一页</Button>{before!==undefined&&<Button disabled={updating} onClick={resetPage}>回到最新</Button>}</div>}
    <details className="network-observation-note"><summary>连接记录说明</summary><p>搜索覆盖当前环境、当前线路配置下仍保留的连接，每页最多300条；可翻页查看。历史有7天期限和总数量上限，超限旧记录会被清理，下载只含当前页。出口检测优先按实际检测入口识别；老记录只将明确指向检测域名的事件归类，不凭共享IP的DNS对照隐藏连接。缓存、连接复用、未识别域名或采集缺口都可能影响显示，无法代替浏览历史。目标只显示域名，服务器IP与沙箱出口IP分开；DNS对照和候选域名不是具体网站访问的确认。出口列保存当时有效的检测回执，不表示目的网站已确认该IP。不解密HTTPS，不保存网址路径、Cookie或正文。管理SSH/DHCP、内核先阻断的请求和Mac其他应用不在明细中。</p></details>
  </div>;
}
