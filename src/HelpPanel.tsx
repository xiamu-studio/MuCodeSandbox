import { useState, type ReactNode } from 'react';
import { BookOpen, ArrowRight, ShieldCheck, RotateCcw, FolderOpen, Network } from 'lucide-react';
import guide from '../docs/user-guide.md?raw';
import technical from '../docs/technical-overview.md?raw';
import todo from '../docs/TODO.md?raw';
import { Button } from './components.tsx';

function text(value:string){return value.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/\*\*([^*]+)\*\*/g,'$1').replace(/`([^`]+)`/g,'$1');}
export function MarkdownDocument({body}:{body:string}){
  const lines=body.split('\n'),output:ReactNode[]=[];
  for(let i=0;i<lines.length;){
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    if(line.startsWith('```')){const code=[];i++;while(i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i++]);output.push(<pre key={i}><code>{code.join('\n')}</code></pre>);i++;continue;}
    if(/^#{1,3} /.test(line)){const title=text(line.replace(/^#+ /,''));output.push(line.startsWith('###')?<h3 key={i}>{title}</h3>:<h2 key={i}>{title}</h2>);i++;continue;}
    if(line.startsWith('|')){const rows:string[][]=[];while(i<lines.length&&lines[i].startsWith('|')){if(!/^\|[\s|:-]+\|$/.test(lines[i]))rows.push(lines[i].split('|').slice(1,-1).map(text));i++;}output.push(<div className="document-table" key={i}><table><thead><tr>{rows[0]?.map((v,j)=><th key={j}>{v}</th>)}</tr></thead><tbody>{rows.slice(1).map((r,j)=><tr key={j}>{r.map((v,k)=><td key={k}>{v}</td>)}</tr>)}</tbody></table></div>);continue;}
    if(/^(?:- |\d+\. )/.test(line)){const entries=[];while(i<lines.length&&/^(?:- |\d+\. )/.test(lines[i]))entries.push(text(lines[i++].replace(/^(?:- |\d+\. )/,'')));output.push(<ul key={i}>{entries.map((v,j)=><li key={j}>{v}</li>)}</ul>);continue;}
    const paragraph=[];while(i<lines.length&&lines[i].trim()&&!/^(#|\||```|- |\d+\. )/.test(lines[i]))paragraph.push(lines[i++]);if(paragraph.length)output.push(<p key={i}>{text(paragraph.join(' '))}</p>);else i++;
  }
  return <article className="help-document">{output}</article>;
}
export function HelpPanel({onCreate,onNetwork,onLab}:{onCreate:()=>void;onNetwork:()=>void;onLab:()=>void}){
  const [document,setDocument]=useState<'start'|'guide'|'technical'|'todo'>('start');
  return <><header className="page-header"><div><div className="eyebrow">按步骤开始</div><h1>使用指南</h1><p>环境、线路、浏览器和备份，一次看清楚。</p></div><BookOpen size={26}/></header>
    <nav className="help-tabs" aria-label="帮助文档">{[{id:'start',label:'快速上手'},{id:'guide',label:'完整指南'},{id:'technical',label:'技术方案'},{id:'todo',label:'后续待办'}].map(d=><button className={document===d.id?'active':''} key={d.id} onClick={()=>setDocument(d.id as typeof document)}>{d.label}</button>)}</nav>
    {document!=='start'?<MarkdownDocument body={document==='guide'?guide:document==='technical'?technical:todo}/>:<div className="help-start">
      <div className="help-hero"><span className="eyebrow">你的 Mac，一个独立空间</span><h2>先建环境，再确认线路。</h2><p>选择 Linux 沙箱后，网页和开发命令在虚拟机里运行。Mac 负责显示画面；项目和线路由你明确配置。</p><Button className="primary" onClick={onCreate} icon={<ArrowRight size={16}/>}>新建 Linux 沙箱</Button></div>
      <div className="guide-grid">{[{icon:Network,title:'设置你的线路',body:'填写本机代理或选择独立节点，启用透明代理和强制防护。直连环境没有这层保护。',action:onNetwork,label:'前往线路设置'},
        {icon:ShieldCheck,title:'先做无账号检测',body:'选择已运行的受保护沙箱，检查真实浏览器特征、合成登录和本地模拟任务，不调用付费模型。',action:onLab,label:'打开检测实验室'},
        {icon:RotateCcw,title:'从空白资料重新开始',body:'浏览器页可以单独重置资料。清除网站登录和历史，保留虚拟机、项目与线路；旧备份仍可能带回旧资料。',action:()=>setDocument('guide'),label:'了解重置范围'},
        {icon:FolderOpen,title:'保存重要内容',body:'停止环境后创建快照或导出加密备份。Mac 共享项目文件需要另做备份，不包含在 VM 快照里。',action:()=>setDocument('guide'),label:'查看备份步骤'}].map(item=><section className="guide-card" key={item.title}><item.icon size={24}/><h3>{item.title}</h3><p>{item.body}</p><button className="text-button" onClick={item.action}>{item.label}<ArrowRight size={14}/></button></section>)}</div>
      <details className="help-faq"><summary>本机浏览器和 Linux 沙箱有什么区别？</summary><p>本机浏览器只隔离会话资料。Linux 沙箱还提供客体网络防护和权限隔离，当前优先使用这条路线；Mac 其他程序不在其范围内。</p></details>
      <details className="help-faq"><summary>“已配置”是不是已经安全联网？</summary><p>不是。先启动环境，再看实时防护核验和实际出口。未检测或失败时不会显示已保护，也不会自动改成直连。</p></details>
    </div>}
  </>;
}
