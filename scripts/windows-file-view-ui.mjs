// Local real-component fixture for CLI browser inspection; no guest or account.
import {build} from 'vite';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..'),directory=path.join(root,'.mu-data/windows-run/file-view-ui');await mkdir(directory,{recursive:true});
const entry=path.join(directory,'entry.tsx');
await writeFile(entry,`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Files from '../../../src/windows/WindowsFilesPanel.tsx';import '../../../src/styles.css';import '../../../src/liquid.css';import '../../../src/status.css';import '../../../src/windows/windows.css';
window.__MU_CONFIG__={token:'local-synthetic',platform:'win32',capabilities:{files:true,independentFileView:true,audio:false,translation:false,imageClipboard:false}};
const environment={id:'dba2d4c9-94d0-4fc8-a0ee-68fae047690d',state:'running',browserRunning:false,identity:{timezone:'Asia/Taipei',locale:'zh-CN'}};
function Fixture(){const [visible,show]=useState(true),[legacy,setLegacy]=useState(false);return <><h1>独立文件画面 · 本地合成验收</h1><p>未运行浏览器，未连接真实 Linux；显示连接为明确适配。</p><button onClick={()=>show(value=>!value)}>{visible?'离开文件页':'返回文件页'}</button><button onClick={()=>setLegacy(value=>!value)}>{legacy?'切换独立入口':'切换旧入口'}</button><button onClick={()=>fetch('/fixture/hold',{method:'POST'})}>延迟下一次打开</button><button onClick={()=>fetch('/fixture/release',{method:'POST'})}>释放延迟打开</button><button onClick={()=>fetch('/fixture/fail-close',{method:'POST'})}>模拟关闭未确认</button>{visible&&<Files key={String(legacy)} id={environment.id} environment={environment} independentView={!legacy} canOpenFolder viewerReady={false}/>}</>};createRoot(document.getElementById('root')).render(<Fixture/>);`);
const bundle=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},build:{write:false,emptyOutDir:false,minify:false,lib:{entry,formats:['iife'],name:'MuFilesFixture'},rollupOptions:{output:{inlineDynamicImports:true}}},plugins:[{name:'explicit-rfb-adapter',enforce:'pre',resolveId(id){if(id==='@novnc/novnc')return '\0rfb-adapter';},load(id){if(id==='\0rfb-adapter')return `export default class RFB extends EventTarget{constructor(container){super();this.node=document.createElement('p');this.node.textContent='合成文件画面，未连接实际 Linux';container.append(this.node);this.timer=setTimeout(()=>this.dispatchEvent(new Event('connect')),20)}focus(){}sendKey(){}disconnect(){clearTimeout(this.timer);this.node.remove();}}`;}}]});
const output=(Array.isArray(bundle)?bundle[0]:bundle).output,script=output.find(value=>value.type==='chunk').code,css=output.filter(value=>value.type==='asset'&&value.fileName.endsWith('.css')).map(value=>value.source).join('\n');
const sources=['scripts/windows-file-view-ui.mjs','src/windows/WindowsFilesPanel.tsx','src/windows/WindowsBrowserView.tsx','src/windows/WindowsWorkspace.tsx','src/api.ts'];
const hashes=Object.fromEntries(await Promise.all(sources.map(async file=>[file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex')])));
const calls=[];let current=null,hold=false,release,failClose=false,holdList=false,releaseList,failList=false,holdUpload=false,releaseUpload,holdDownload=false,releaseDownload,withFile=false;
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Cache-Control','no-store');
 if(url.pathname==='/favicon.ico'){res.statusCode=204;res.end();return;}
 if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(script);return;}
 if(url.pathname==='/fixture.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><title>文件画面本地合成验收</title><link rel="stylesheet" href="/fixture.css"><style>body{font:16px system-ui;background:#f6f7f8;color:#222;padding:20px}button{margin:6px;padding:8px}section{margin-top:16px}.windows-browser-canvas{min-height:240px;background:#e8ecf2}</style><div id="root"></div><script src="/bundle.js"></script>');return;}
 let raw='',rawBytes=0;for await(const chunk of req){raw+=chunk;rawBytes+=chunk.length;}res.setHeader('Content-Type','application/json');
 if(req.method==='POST'&&url.pathname.endsWith('/transfer-files')){const name=url.searchParams.get('name');calls.push({method:req.method,path:url.pathname,body:{name,bytes:rawBytes}});if(holdUpload)await new Promise(resolve=>releaseUpload=resolve);res.end(JSON.stringify({name,path:'/home/dev/Downloads/'+name,bytes:rawBytes,zone:'downloads'}));return;}
 const body=raw?JSON.parse(raw):{};
 if(url.pathname==='/fixture/stats'){res.end(JSON.stringify({calls,current,hold,hashes,actualGuest:false}));return;}
 if(url.pathname==='/fixture/hold'){hold=true;res.end('{}');return;}
 if(url.pathname==='/fixture/hold-list'){holdList=true;res.end('{}');return;}
 if(url.pathname==='/fixture/with-file'){withFile=true;res.end('{}');return;}
 if(url.pathname==='/fixture/hold-download'){holdDownload=true;res.end('{}');return;}
 if(url.pathname==='/fixture/release-download'){holdDownload=false;releaseDownload?.();releaseDownload=undefined;res.end('{}');return;}
 if(url.pathname==='/fixture/hold-upload'){holdUpload=true;res.end('{}');return;}
 if(url.pathname==='/fixture/release-upload'){holdUpload=false;releaseUpload?.();releaseUpload=undefined;res.end('{}');return;}
 if(url.pathname==='/fixture/release-list'){holdList=false;releaseList?.();releaseList=undefined;res.end('{}');return;}
 if(url.pathname==='/fixture/fail-list'){failList=true;res.end('{}');return;}
 if(url.pathname==='/fixture/release'){release?.();release=undefined;hold=false;res.end('{}');return;}
 if(url.pathname==='/fixture/fail-close'){failClose=true;res.end('{}');return;}
 calls.push({method:req.method,path:url.pathname,body});
 if(url.pathname.endsWith('/transfer-folder/open')){if(hold)await new Promise(resolve=>release=resolve);current=randomUUID();res.end(JSON.stringify({ok:true,path:'/home/dev/Downloads',viewId:current}));return;}
 if(url.pathname.endsWith('/transfer-folder/close')){if(failClose){failClose=false;res.statusCode=409;res.end(JSON.stringify({error:'合成关闭尚未确认，请重试',code:'FILE_DISPLAY_STOP_UNCONFIRMED'}));return;}if(current===body.viewId)current=null;res.end('{"closed":true}');return;}
 if(url.pathname.endsWith('/transfer-files')){if(holdList)await new Promise(resolve=>{releaseList=resolve;res.once('close',()=>{if(!res.writableFinished)calls.push({event:'list-disconnected'});resolve();});});if(res.destroyed)return;if(failList){failList=false;res.statusCode=503;res.end('{"error":"合成文件读取失败，请重试","code":"FIXTURE_READ_FAILED"}');return;}res.end(JSON.stringify({files:withFile?[{zone:'downloads',name:'合成取消检查.txt',path:'/home/dev/Downloads/合成取消检查.txt',bytes:6,modifiedAt:'2026-10-30T00:00:00.000Z',kind:'file',revision:'a'.repeat(64)}]:[],total:withFile?1:0,nextCursor:null}));return;}
 if(url.pathname.endsWith('/transfer-download')){if(holdDownload)await new Promise(resolve=>{releaseDownload=resolve;res.once('close',()=>{if(!res.writableFinished)calls.push({event:'download-disconnected'});resolve();});});if(res.destroyed)return;res.setHeader('Content-Type','application/octet-stream');res.end('local\n');return;}
 if(url.pathname.endsWith('/guest-browser-ticket')){res.end('{"ticket":"synthetic-only","password":"fixture8"}');return;}
 if(url.pathname.endsWith('/guest-browser')){res.end('{"ready":true,"browserRunning":false}');return;}
 if(url.pathname.endsWith('/guest-browser/display')){res.end(JSON.stringify({...body,width:body.cssWidth*body.scaleFactor,height:body.cssHeight*body.scaleFactor,browserScaleFactor:0,densitySource:'xsettings',nativeScaleFactor:body.scaleFactor,matched:true}));return;}
 res.statusCode=404;res.end('{"error":"Fixture route missing"}');
 }catch{res.statusCode=500;res.end('{"error":"Fixture failed"}');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
const report={url,pid:process.pid,hashes,actualGuest:false};console.log(JSON.stringify(report));
if(process.env.MU_FILE_VIEW_FIXTURE_STATE)await writeFile(process.env.MU_FILE_VIEW_FIXTURE_STATE,JSON.stringify(report,null,2),{flag:'wx'});
for(const name of ['SIGTERM','SIGINT'])process.on(name,()=>{release?.();releaseList?.();releaseUpload?.();releaseDownload?.();server.closeAllConnections();server.close(()=>process.exit(0));});
