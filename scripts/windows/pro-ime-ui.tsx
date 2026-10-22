import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import WindowsBrowserView from '../../src/windows/WindowsBrowserView.tsx';
import TerminalPanel from '../../src/TerminalPanel.tsx';
import {environmentSchema} from '../../server/validation.ts';
import '../../src/styles.css';import '../../src/windows/windows.css';
window.__MU_CONFIG__={token:'fixture',platform:'win32',capabilities:{browser:true,files:true,terminal:true}};
const environment={...environmentSchema.parse({name:'输入法本地验收'}),id:'12345678-1234-4234-8234-123456789abc',instanceName:'synthetic',state:'running' as const,browserRunning:true,createdAt:'',updatedAt:'',lastError:null};let sequence=0;
for(const type of ['compositionstart','compositionupdate','compositionend','keydown','input'])document.addEventListener(type,event=>{
 const field=event.target;if(!(field instanceof HTMLTextAreaElement)||!field.getAttribute('aria-label')?.includes('待粘贴文字'))return;
 const key=event as KeyboardEvent,composition=event as CompositionEvent;
 void fetch('/telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sequence:++sequence,time:performance.now(),type,trusted:event.isTrusted,label:field.getAttribute('aria-label'),value:field.value,key:key.key,ctrl:key.ctrlKey,composing:key.isComposing,keyCode:key.keyCode,data:composition.data})});
},true);
function Fixture(){const [terminal,setTerminal]=useState(false),[state,setState]=useState('本地合成接收端；无真实 shell、剪贴板或外网。');useEffect(()=>{const timer=setInterval(()=>void fetch('/state').then(r=>r.json()).then(value=>setState(JSON.stringify(value))),500);return()=>clearInterval(timer);},[]);
 return <><header><button onClick={()=>setTerminal(false)}>浏览器输入验收</button><button onClick={()=>setTerminal(true)}>终端输入验收</button></header><pre style={{height:60,overflow:'auto',whiteSpace:'pre-wrap',fontSize:12}}>{state}</pre>{terminal?<TerminalPanel environment={environment} quickTools="text"/>:<WindowsBrowserView environment={environment}/>}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
