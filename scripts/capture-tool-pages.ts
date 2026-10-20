import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';
import {createServer} from 'vite';import {chromium,expect} from '@playwright/test';
import {fixturePng} from './clipboard-image-fixture.ts';

// Isolated display fixture. Never connects to the user's service, VM, clipboard or accounts.
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'artifacts/tool-pages-2026-10-19');
await mkdir(path.join(out,'pages'),{recursive:true});const cache=await mkdtemp(path.join(tmpdir(),'mu-tool-captures-'));
const id='00000000-0000-4000-8000-000000000001',at='2026-10-19T10:30:00Z',ip='203.0.113.10',png=fixturePng();
const env:any={id,instanceName:'mu-demo',name:'独立开发环境',description:'示例工作区',kind:'vm',color:'blue',cpus:6,memoryGiB:6,diskGiB:30,mounts:[{id:'demo-mount',hostPath:'/Users/demo/Projects/sample',guestPath:'/workspace/sample',writable:false}],ports:[],network:{mode:'socks5',host:'127.0.0.1',port:24898,username:'',noProxy:'',strict:true,transparent:true,egressLock:{expectedIp:ip}},identity:{timezone:'America/Los_Angeles',locale:'en-US'},browserUrl:'https://home.mucodesandbox.invalid/',state:'running',lastError:null,createdAt:at,updatedAt:at,browserRunning:true};
const jobs=[{id:'demo-job-1',environmentId:id,action:'start',status:'succeeded',message:'操作已完成',createdAt:at,finishedAt:at},{id:'demo-job-2',environmentId:id,action:'open-browser',status:'succeeded',message:'操作已完成',createdAt:at,finishedAt:at}];
const snapshot={environments:[env],jobs,system:{platform:'darwin',arch:'arm64',hostname:'demo-mac.local',cpus:10,memoryGiB:16,freeMemoryGiB:8,dataDir:'/Users/demo/.mucodesandbox',version:'0.4.61',runtime:{available:true,path:'/Users/demo/.mucodesandbox/runtime/limactl',version:'2.0',error:null},browser:{available:true,engine:'Chromium',native:false},application:{channel:'desktop-test',buildId:'demo-preview',builtAt:at},hostNetwork:{state:'ready',issue:null}}};
const fixedNow=()=>new Date().toISOString();
const protection=()=>({active:env.state==='running',prepared:true,bootArmed:true,firewallActive:true,transparentReady:true,transparentActive:true,integrity:env.state==='running'?'verified':'inactive',leaseActive:env.state==='running',leaseRemainingMs:40000,routingReady:true,dnsGuardActive:true,checkedAt:fixedNow(),issues:[],proxyEndpoints:['127.0.0.1:24898'],blockedPackets:0});
const egress=()=>({status:'verified',expectedIp:ip,actualIp:ip,checkedAt:fixedNow(),verification:{requiredReceivers:2,timedOutReceivers:[],receipts:['ipwho','ipify'].map(receiver=>({receiver,ip,latencyMs:180}))}});
const snap={id:'demo-snapshot',environmentId:id,name:'工作前备份',createdAt:at,bytes:6*2**30};
const entry=(name:string,zone:string,parent='',kind='file')=>({name,zone,kind,bytes:kind==='directory'?0:24*1024,modifiedAt:at,revision:kind==='file'?'a'.repeat(64):undefined,relativePath:parent?parent+'/'+name:name,path:'/home/dev/'+(zone==='downloads'?'Downloads':zone==='incoming'?'Transfers/Incoming':'Transfers/Outgoing')+'/'+(parent?parent+'/':'')+name});
const reply='项目进展\n\n1. 文件传输已完成。\n2. 请检查输出目录中的报告。\n\n下一步\n保留原有换行与列表格式，确认内容后再粘贴使用。';
const original='Project update\n\n1. File transfer is complete.\n2. Please review the report in the output folder.\n\nNext steps\nKeep the original paragraphs and list formatting. Review the result before pasting.';
const preview=`import React,{useRef}from'react';import GuestQuickTools from '/src/GuestQuickTools.tsx';import{Monitor,RefreshCw,Maximize2}from'lucide-react';export default function Preview({id,name,active=true,environment,command}){const surface=useRef(null);const terminal=!!environment;return <section ref={surface} className="guest-browser" style={{position:'relative',height:610,border:'1px solid #d9e6e6',borderRadius:12,overflow:'hidden',background:'#fff'}}><header className={terminal?'terminal-header':'guest-browser-toolbar'} style={{height:62,padding:'10px 16px',display:'flex',gap:12,alignItems:'center',background:'#f1f7f6',borderBottom:'1px solid #dbe6e4'}}><Monitor size={18}/><strong style={{marginRight:'auto'}}>独立开发环境 · {terminal?'终端':'Linux'}</strong><small>示例画面</small><GuestQuickTools id={id??environment.id} connected active={active} dropTarget={surface} terminal={terminal} onPaste={async()=>{}} onReadText={terminal?async()=>${JSON.stringify(original)}:undefined} onKey={()=>{}}/><RefreshCw size={17}/><Maximize2 size={17}/></header>{terminal?<div style={{background:'#192d32',color:'#c9e5da',height:'calc(100% - 62px)',padding:24,fontFamily:'monospace',fontSize:15,lineHeight:1.8}}><div>dev@linux:~/workspace $ ls</div><div style={{color:'#8fc9d8'}}>documents  reports  sample</div><div>dev@linux:~/workspace $ </div><div style={{marginTop:30,color:'#88aaa8'}}>文件与中文输入工具位于右上角</div></div>:<div style={{padding:'75px 60px',textAlign:'center'}}><div style={{fontSize:13,letterSpacing:3,color:'#557c78'}}>LOCAL WORKSPACE</div><h2 style={{fontSize:32,margin:'16px 0',color:'#24464b'}}>你的独立工作空间</h2><p style={{fontSize:15,color:'#68817f'}}>在沙箱中浏览、处理文件与运行开发工具</p><div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16,maxWidth:620,margin:'42px auto'}}>{['项目文件','工作记录','常用工具'].map(x=><div key={x} style={{border:'1px solid #dae7e3',borderRadius:12,padding:22,background:'#f8fbfa',fontSize:14}}>{x}</div>)}</div></div>}</section>}`;
const vite=await createServer({root,cacheDir:cache,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[{name:'isolated-screenshot-fixture',enforce:'pre',transform(_code,file){if(/\/src\/(?:GuestBrowserView|TerminalPanel)\.tsx$/.test(file))return {code:preview,map:null};},configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url?.split('?')[0]!=='/capture.html')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/capture.html','<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>工具界面示例</title></head><body><div id="root"></div><script>window.__MU_CONFIG__={token:"demo-fixture"}</script><script type="module" src="/src/main.tsx"></script></body></html>'));});}}]});
await vite.listen();const address=vite.httpServer!.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1600,height:1050},deviceScaleFactor:2,timezoneId:'Asia/Taipei',reducedMotion:'reduce'});page.setDefaultTimeout(10000);
const errors:string[]=[],requests:{method:string;path:string}[]=[],shots:{file:string;title:string}[]=[];
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(({original,png})=>{
 Object.defineProperty(navigator,'clipboard',{value:{readText:async()=>original,writeText:async()=>{}}});
 (window as any).muDesktop={readClipboardImage:async()=>({data:new Uint8Array(png),width:2,height:2})};
 // Screenshot-only replacement. Product strings, identifiers and source files remain unchanged.
 const clean=(s:string)=>s.replace(/(?:https?:\/\/)?(?:[\w.-]+\.)?(?:claude\.com|claude\.ai|anthropic\.com)[^\s"<>)]*/gi,'service.example').replace(/Claude\s*Code/gi,'AI 编程').replace(/Claude\s*Desktop/gi,'AI Desktop').replace(/Claude/gi,'AI 助手').replace(/Anthropic/gi,'AI 服务商').replace(/克劳德/g,'AI 助手').replace(/166\.88\.36\.199/g,'203.0.113.10').replace(/166-88-36-199/g,'203-0-113-10').replace(/\/Users\/staff/g,'/Users/demo').replace(/xiamu-studio/g,'demo-studio');
 const sanitize=()=>{const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);for(let n=walker.nextNode();n;n=walker.nextNode()){if(n.parentElement?.closest('script,style'))continue;const value=clean(n.nodeValue??'');if(value!==n.nodeValue)n.nodeValue=value;}for(const el of document.querySelectorAll('*'))for(const key of ['aria-label','title','placeholder','alt','href']){const value=el.getAttribute(key);if(value&&clean(value)!==value)el.setAttribute(key,clean(value));}};
 addEventListener('DOMContentLoaded',()=>{sanitize();new MutationObserver(sanitize).observe(document.body,{subtree:true,childList:true,characterData:true});});(window as any).sanitizeCapture=sanitize;
},{original,png:[...png]});
await page.route('**/*',async route=>{
 const req=route.request(),url=new URL(req.url()),p=url.pathname;requests.push({method:req.method(),path:p});if(url.origin!==base){errors.push('External request blocked: '+url.origin);return route.abort();}if(!p.startsWith('/api/'))return route.continue();
 let data:any;
 if(p==='/api/snapshot')data=snapshot;
 else if(p.endsWith('/network/protection'))data=protection();
 else if(p.endsWith('/network/egress'))data=egress();
 else if(p.endsWith('/network/latency'))data={target:'google',status:'success',medianMs:165,minMs:160,maxMs:171,successfulSamples:3,samples:[160,165,171].map(lineDelayMs=>({ok:true,lineDelayMs,httpStatus:204})),checkedAt:fixedNow(),source:'guest'};
 else if(p.endsWith('/metrics'))data={cpuPercent:8,memoryUsedMiB:1856,memoryTotalMiB:6144,diskUsedGiB:7.2,diskTotalGiB:30,uptimeSeconds:5040};
 else if(p.endsWith('/browser/version'))data={installedVersion:'155.0.8059.39',availableVersion:'155.0.8059.39',installedChannel:'stable',availableChannel:'stable',updateAvailable:false,recoveryRequired:false};
 else if(p.endsWith('/browser/inspect'))data={timezone:'America/Los_Angeles',language:'en-US',locale:'en-US',languages:['en-US'],matchesConfiguration:true,checkedAt:fixedNow()};
 else if(p.endsWith('/protection-events'))data=[];
 else if(p==='/api/logs')data=[{id:1,environmentId:id,jobId:null,level:'info',message:'环境启动完成，示例工作区已就绪。',createdAt:at}];
 else if(p.endsWith('/agent'))data={installed:true,version:'2.1.0',nodeVersion:'24.15.0'};
 else if(p.endsWith('/desktop-apps'))data={supported:true,displaySharedWithBrowser:true,accountTested:false,apps:['grok-bot','claude-desktop'].map(id=>({id,installed:true,installedVersion:'2.0.0',running:false,pid:0,profile:'/home/dev/.local/share/app'}))};
 else if(p.endsWith('/guest-focus'))data={ok:true};
 else if(p.endsWith('/bridge'))data=[];
 else if(p.endsWith('/snapshots'))data=[snap];
 else if(p.endsWith('/disk'))data={pending:false,targetGiB:null};
 else if(p==='/api/lab')data={running:false,eventCount:0,modelCalls:0};
 else if(p==='/api/lab/receipts')data={receipts:[],events:[]};
 else if(p==='/api/lab/checks')data=[{id:'demo-check',environmentId:id,environmentName:env.name,state:'passed',checkedAt:at,checks:[{name:'受保护网络',passed:true,detail:'示例检测结果'},{name:'浏览器上下文',passed:true,detail:'示例语言、时区与配置一致'},{name:'本地模拟任务',passed:true,detail:'示例任务完成，无付费请求'}],scope:'展示示例 · 非真实环境检测结果'}];
 else if(p==='/api/local-proxy')data={available:false,nodes:[],ports:[],line:null};
 else if(p==='/api/translation-settings')data={configured:true,provider:'DeepSeek',model:'deepseek-flash'};
 else if(p.endsWith('/translate-text'))data={text:reply,provider:'DeepSeek',model:'deepseek-flash',target:'zh'};
 else if(p.endsWith('/clipboard/read'))data={text:original};
 else if(p.endsWith('/clipboard/write')||p.endsWith('/clipboard/image'))data={ok:true,width:2,height:2};
 else if(p.endsWith('/transfer-files')){if(req.method()==='POST')data={name:url.searchParams.get('name'),zone:'downloads',path:'/home/dev/Downloads/'+url.searchParams.get('name'),bytes:req.postDataBuffer()?.length??0};else{const zone=url.searchParams.get('zone')??'downloads',parent=url.searchParams.get('path')??'';data={files:parent?[entry('项目计划.md',zone,parent),entry('界面说明.pdf',zone,parent)]:[entry('项目资料',zone,'','directory'),entry('工作报告.pdf',zone),entry('项目计划.md',zone)],total:3,nextCursor:null};}}
 else if(p.endsWith('/network/observations')){data={enabled:true,capture:'ready',captureGaps:0,collectedAt:fixedNow(),startedAt:at,sampleIntervalSeconds:30,lockIp:ip,summary:{state:'unchanged',lastIp:ip,lastCheckedAt:fixedNow(),firstCheckedAt:at,distinctIps:1,changes:0,failures:0,successes:36},samples:[{id:1,provider:'ipify',status:'success',ip,at,latencyMs:180}],connections:['docs.example','assets.example','api.example'].map((domain,i)=>({id:i+1,at,target:'203.0.113.'+(20+i),port:443,protocol:'TCP',status:'attempt',route:'proxy',origin:'traffic',domain,domainSource:'connection',exitIp:ip,exitCheckedAt:at,exitSource:'verification'})),connectionPage:{total:3,retained:3}};}
 else {errors.push(`Unprovided fixture endpoint ${req.method()} ${p}`);return route.fulfill({status:404,json:{error:'示例接口未提供'}});}
 return route.fulfill({json:data});
});
async function capture(file:string,title:string,full=false){
 assert.deepEqual(errors,[],file+' fixture errors');await page.evaluate(()=>{(window as any).sanitizeCapture();});await page.evaluate(()=>document.fonts.ready);
 assert.ok(!/claude|anthropic|克劳德/i.test(await page.locator('body').innerText()),file+' contains forbidden branding');assert.ok(!/166\.88\.36\.199|\/Users\/staff|xiamu-studio/.test(await page.locator('body').innerText()),file+' contains real environment details');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,file+' overflow');
 if(full)await page.addStyleTag({content:'.application,.main{height:auto!important;overflow:visible!important;min-height:100vh!important}.main-content{overflow:visible!important;flex:none!important}.topbar{position:relative!important}'});
 await page.screenshot({path:path.join(out,'pages',file+'.png'),fullPage:full});
 if(full)await page.evaluate(()=>{for(const el of document.querySelectorAll('style'))if(el.textContent?.startsWith('.application,.main{height:auto!important'))el.remove();});
 shots.push({file:'pages/'+file+'.png',title});
 const focused=await page.getByRole('dialog').count();
 if(focused){await page.getByRole('dialog').screenshot({path:path.join(out,'pages',file+'-detail.png')});shots.push({file:'pages/'+file+'-detail.png',title:title+' · 窗口特写'});}
 else if(['23-translation-input','24-translation-result','26-translation-settings'].includes(file)){const focusStyle=await page.addStyleTag({content:'.guest-input-container:not([hidden]){position:fixed!important;top:24px!important;right:24px!important;max-height:none!important;overflow:visible!important;z-index:99999!important}'});await page.locator('.guest-input-container:not([hidden])').screenshot({path:path.join(out,'pages',file+'-detail.png')});await focusStyle.evaluate(el=>{el.parentNode?.removeChild(el);});shots.push({file:'pages/'+file+'-detail.png',title:title+' · 小窗特写'});}
 console.log('Captured '+file);
}
async function click(name:string){await page.getByRole('button',{name,exact:true}).first().click();}
async function closeModal(){await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();}
async function envTab(name:string){await page.getByRole('button',{name:env.name+' Linux 沙箱',exact:true}).click();await page.getByRole('navigation',{name:'环境页面'}).getByRole('button',{name,exact:true}).click();}
try{
 await page.goto(base+'/capture.html');await expect(page.getByRole('heading',{name:'MuCodeSandbox',exact:true})).toBeVisible();await capture('01-workspace','工作区');
 await click('新建环境');await capture('02-create-environment','新建环境');await closeModal();
 await click('导入备份');await capture('03-import-backup','导入加密备份');await closeModal();
 await envTab('总览');await expect(page.getByRole('region',{name:'环境状态总览'}).getByText('已核验',{exact:true}).first()).toBeVisible();await capture('04-overview','环境总览',true);
 await envTab('项目目录');await capture('05-project-folders','项目目录',true);
 await envTab('网络');await capture('06-network','线路与防护',true);
 await envTab('宿主授权');await capture('07-host-permissions','宿主授权',true);
 await envTab('日志');await expect(page.getByRole('list',{name:'网络连接记录'}).getByRole('listitem')).toHaveCount(3);await capture('08-network-logs','连接与运行日志',true);
 await envTab('设置');await capture('09-environment-settings','环境设置',true);await click('彻底重建环境');await capture('10-rebuild-confirm','重建环境确认');await click('取消');await click('删除环境');await capture('11-delete-confirm','删除环境确认');await click('取消');
 await envTab('桌面应用');await expect(page.getByRole('button',{name:'打开客户端',exact:true}).first()).toBeEnabled();await capture('12-desktop-apps','桌面应用');
 await envTab('AI 编程');await capture('13-code-tools','编程工具',true);
 await envTab('浏览器');await expect(page.getByText('你的独立工作空间',{exact:true})).toBeVisible();await page.locator('.guest-browser').scrollIntoViewIfNeeded();await capture('14-browser-tools','浏览器工具');
 await click('文件与粘贴');await capture('15-files-home','文件传输');await click('刷新文件');await expect(page.getByText('工作报告.pdf',{exact:true})).toBeVisible();await capture('16-file-list','文件列表');await page.getByRole('button',{name:'项目资料',exact:true}).click();await expect(page.getByText('界面说明.pdf',{exact:true})).toBeVisible();await capture('17-file-folder','子文件夹');
 await page.locator('.guest-transfer-more>summary').click();await capture('18-file-help','文件上传与路径说明');await page.locator('.guest-transfer-more>summary').click();
 await page.getByLabel('选择 Mac 文件上传',{exact:true}).setInputFiles({name:'示例资料.txt',mimeType:'text/plain',buffer:Buffer.from('Local screenshot example\n')});await expect(page.getByRole('region',{name:'本次传入的文件'})).toBeVisible();await capture('19-file-uploaded','文件传入完成');
 await click('图片粘贴');await capture('20-image-clipboard','图片剪贴板');await click('粘贴图片到沙箱');await expect(page.getByText('图片已放入沙箱剪贴板。',{exact:false})).toBeVisible();await capture('21-image-ready','图片传入完成');
 await click('文字复制粘贴');await page.getByRole('textbox',{name:'要发送到沙箱的文字'}).fill('示例文字\n\n在确认后传入沙箱。');await click('取回沙箱文字');await capture('22-text-clipboard','文字复制粘贴');await click('返回沙箱');
 await click('中文与快捷输入');await capture('23-translation-input','中文输入与翻译');await click('取回并翻译');await expect(page.getByRole('textbox',{name:'译文',exact:true})).toHaveValue(reply);await capture('24-translation-result','翻译结果');
 const actions=page.locator('.guest-translation-actions'),directionBox=await actions.getByRole('combobox').boundingBox(),pasteBox=await actions.getByRole('button',{name:'粘贴原文',exact:true}).boundingBox(),translateBox=await actions.getByRole('button',{name:'翻译成中文',exact:true}).boundingBox();assert.ok(directionBox&&pasteBox&&translateBox&&directionBox.x<translateBox.x&&translateBox.x<pasteBox.x,'Direction left, primary paste right');
 await click('放大查看');await capture('25-translation-expanded','翻译放大阅读');await click('返回小窗');await page.locator('.guest-input-more>summary').click();await page.locator('.guest-translation-settings>summary').click();await capture('26-translation-settings','翻译设置与帮助');await click('收起中文输入');
 await envTab('终端');await expect(page.getByText('dev@linux:~/workspace $ ls',{exact:true})).toBeVisible();await capture('27-terminal','终端与快捷工具');
 await page.getByRole('button',{name:'操作记录',exact:true}).click();await capture('28-activity','操作记录',true);
 await page.getByRole('button',{name:'检测实验室',exact:true}).click();await expect(page.getByText('本地分项通过',{exact:true})).toBeVisible();await capture('29-lab','检测实验室',true);
 await click('使用指南');await capture('30-help-start','使用指南 · 快速上手',true);
 for(const [name,file]of [['完整指南','31-help-guide'],['技术方案','32-help-technical'],['后续待办','33-help-todo']]){await click(name);await capture(file,'使用指南 · '+name,true);}
 await click('系统设置');await capture('34-system-settings','系统设置',true);
 env.state='stopped';env.browserRunning=false;env.updatedAt=fixedNow();await page.reload();await envTab('快照');await expect(page.getByText('工作前备份',{exact:true})).toBeVisible();await capture('35-snapshots','快照与备份');await click('导出 工作前备份');await capture('36-export-backup','导出加密备份');await click('取消');await click('恢复 工作前备份');await capture('37-restore-confirm','快照恢复确认');await click('取消');
 await envTab('网络');await click('线路设置向导');await capture('38-network-wizard','线路设置向导');await closeModal();
 env.state='running';env.browserRunning=false;env.updatedAt=fixedNow();await page.reload();await envTab('浏览器');await click('重置浏览器资料');await capture('39-browser-reset','浏览器资料重置确认');await click('取消');
 assert.deepEqual(errors,[]);await writeFile(path.join(out,'manifest.json'),JSON.stringify({scope:'Isolated production UI demonstration. Synthetic data and local display fixtures; no real accounts, files, IP tests or model requests. Branding replaced only in screenshots.',shots,requests:requests.filter(r=>r.path.startsWith('/api/')),errors},null,2));
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MuCodeSandbox 工具页面截图</title><style>body{font:15px system-ui;margin:0;background:#eef3f2;color:#24464b}header{padding:32px 40px;background:#fff}h1{margin:0 0 10px;font-size:28px}p{color:#607b7b}main{padding:24px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}article{background:#fff;border:1px solid #d6e4e0;border-radius:12px;overflow:hidden}a{color:inherit;text-decoration:none}img{width:100%;height:260px;object-fit:contain;background:#f8fbfa;display:block}h2{font-size:16px;padding:0 18px;margin:16px 0}small{display:block;margin:0 18px 16px;color:#718a88}@media(max-width:800px){main{grid-template-columns:1fr}}</style><header><h1>MuCodeSandbox · 工具页面</h1><p>'+shots.length+' 张独立截图 · 点击查看原图</p><p>示例展示：使用生产组件、合成数据与中性本地画面。页面不含真实账号、文件或 Key；示例检测结果不代表实际防护验收。相关服务品牌仅在截图中替换。</p></header><main>'+shots.map((s,i)=>'<article><a href="'+s.file+'"><img src="'+s.file+'" loading="eager"><h2>'+String(i+1).padStart(2,'0')+' · '+s.title+'</h2><small>PNG · 点击原图查看完整内容</small></a></article>').join('')+'</main></html>';
 await writeFile(path.join(out,'index.html'),html);await writeFile(path.join(out,'README.txt'),'工具页面截图集\n\n打开 index.html 浏览全部截图，pages/ 为独立PNG。示例展示不是实际运行、防护或模型验收。浏览器和终端区域为中性本地示例画面，其余工具界面使用生产组件。页面中的示例出口为文档地址，不是用户真实IP。\n');
 console.log(JSON.stringify({passed:true,count:shots.length,directory:out}));
}finally{await browser.close();await vite.close();await rm(cache,{recursive:true,force:true});}
