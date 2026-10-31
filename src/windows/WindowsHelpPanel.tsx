import {useState} from 'react';
import {ArrowRight,BookOpen,FolderOpen,Network,RotateCcw,ShieldCheck} from 'lucide-react';
import {Button} from '../components.tsx';
import {MarkdownDocument} from '../HelpPanel.tsx';
import guide from '../../docs/help/windows-user-guide.md?raw';
import technical from '../../docs/help/windows-technical-overview.md?raw';
import limitations from '../../docs/help/windows-limitations.md?raw';

export default function WindowsHelpPanel({onCreate,onSystem,onNetwork,onBackup}:{onCreate:()=>void;onSystem:()=>void;onNetwork:()=>void;onBackup:()=>void}){
 const [document,setDocument]=useState<'start'|'guide'|'technical'|'todo'>('start');
 return <><header className="page-header"><div><div className="eyebrow">按步骤开始</div><h1>使用指南</h1><p>环境、线路、浏览器和备份，一次看清楚。</p></div><BookOpen size={26}/></header>
  <nav className="help-tabs" aria-label="帮助文档">{([{id:'start',label:'快速上手'},{id:'guide',label:'完整指南'},{id:'technical',label:'技术方案'},{id:'todo',label:'支持范围'}] as const).map(item=><button key={item.id} className={document===item.id?'active':''} onClick={()=>setDocument(item.id)}>{item.label}</button>)}</nav>
  {document!=='start'?<MarkdownDocument body={document==='guide'?guide:document==='technical'?technical:limitations}/>:<div className="help-start"><div className="help-hero"><span className="eyebrow">你的 Windows，一个独立空间</span><h2>先准备组件，再建环境。</h2><p>网页和开发命令在独立 Linux 中运行。Windows 负责显示画面；项目和线路由你明确配置。</p><Button className="primary" onClick={onCreate} icon={<ArrowRight size={16}/>}>新建 Linux 沙箱</Button></div>
   <div className="guide-grid">{[{icon:ShieldCheck,title:'准备运行组件',body:'检查 Hyper-V 与 OpenSSH，再准备 Linux、浏览器和网络组件。需要重启时由你确认并执行。',action:onSystem,label:'前往系统设置'},{icon:Network,title:'设置你的线路',body:'填写本机 Clash 或远程代理，以及明确批准的出口 IPv4。启动后以实际核验结果为准。',action:onNetwork,label:'前往线路设置'},{icon:FolderOpen,title:'传输和保存文件',body:'在文件传输页上传、下载和管理沙箱文件。Windows 当前不持续共享宿主目录。',action:()=>setDocument('guide'),label:'查看文件说明'},{icon:RotateCcw,title:'保存加密备份',body:'停止环境后导出加密备份。导入时先检查内容，恢复成独立环境，并保持停止。',action:onBackup,label:'打开备份与恢复'}].map(item=><section className="guide-card" key={item.title}><item.icon size={24}/><h3>{item.title}</h3><p>{item.body}</p><button className="text-button" onClick={item.action}>{item.label}<ArrowRight size={14}/></button></section>)}</div>
   <details className="help-faq"><summary>为什么启动后还要核验出口？</summary><p>保存的是线路配置。只有两处独立回执与批准出口一致、防护规则和联网许可有效时才开放业务联网。配置完成不会显示为已核验。</p></details>
   <details className="help-faq"><summary>中文输入和复制粘贴怎么用？</summary><p>使用中文输入与翻译浮窗，或画面下方的输入区；先选中沙箱目标输入框，再粘贴。Windows 使用 Ctrl 快捷键，输入法选字期间不会触发提交。</p></details>
    <details className="help-faq"><summary>为什么有些 Mac 功能还不能点击？</summary><p>Windows 的持续共享、宿主命令授权、桌面客户端和 WireGuard 仍未交付。Claude Code 的原生组件安装、状态核验及专用终端已接入源码，运行入口等待真实 Linux 与安装版验收，暂未开放。检测实验室已接入本地检测页面，运行入口默认关闭，等待真实 Linux 环境验收；本机对照已接入独立临时窗口与本地接收端，入口默认关闭，等待 Windows 桌面验收。快照与恢复仍需完成实机发布验收。支持范围页列出当前状态。</p></details>
   <details className="help-faq"><summary>备份密码忘记了怎么办？</summary><p>加密备份需要原密码才能恢复。请单独保管密码与备份文件。删除环境前先确认备份能被读取；清理构建缓存不会替你删除有效备份。</p></details>
  </div>}
 </>;
}
