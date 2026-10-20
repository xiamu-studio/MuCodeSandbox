import type {IPty,IWindowsPtyForkOptions} from 'node-pty';

let terminal:IPty|undefined,started=false,stopping=false,finished=false,pendingBytes=0;
const queued:unknown[]=[];let queuedBytes=0;
function finish(exitCode:number){
 if(finished)return;finished=true;
 if(!process.connected){process.exit(0);return;}
 process.send?.({type:'exit',exitCode},()=>process.exit(0));
 setTimeout(()=>process.exit(0),1500).unref();
}
function stop(){if(stopping)return;stopping=true;try{terminal?.kill();}catch{}if(!terminal)finish(130);else setTimeout(()=>finish(130),1000).unref();}
process.once('disconnect',stop);
process.on('message',(raw:unknown)=>{void handle(raw).catch(()=>{if(process.connected)process.send?.({type:'data',data:'\r\nWindows 终端组件不可用，请检查安装。\r\n'});stop();finish(1);});});
async function handle(raw:unknown){
 if(!raw||typeof raw!=='object'||!('type' in raw))return;
 const message=raw as {type:string;file:string;args:string[];options:IWindowsPtyForkOptions;data:string;cols:number;rows:number};
 if(message.type==='stop'){stop();return;}if(stopping||finished)return;
 if(message.type==='start'){
  if(started)throw Error('Terminal already started');started=true;
  const pty=process.versions.electron?await import('node-pty-electron'):await import('node-pty');if(stopping||finished)return;
  terminal=pty.spawn(message.file,message.args,message.options);
  terminal.onData(data=>{
   if(finished||!process.connected)return;const bytes=Buffer.byteLength(data);pendingBytes+=bytes;
   if(pendingBytes>2*1024*1024){stop();return;}
   try{process.send?.({type:'data',data},()=>{pendingBytes-=bytes;});}catch{stop();}
  });
  terminal.onExit(({exitCode})=>finish(exitCode));for(const deferred of queued.splice(0))await handle(deferred);queuedBytes=0;return;
 }
 if(!terminal&&started){queuedBytes+=Buffer.byteLength(JSON.stringify(message));if(queued.length>=64||queuedBytes>262144)throw Error('Terminal startup input exceeded limit');queued.push(message);return;}
 if(message.type==='input'&&typeof message.data==='string'&&Buffer.byteLength(message.data)<=49152)terminal?.write(message.data);
 else if(message.type==='resize'&&Number.isInteger(message.cols)&&message.cols>=20&&message.cols<=300&&Number.isInteger(message.rows)&&message.rows>=5&&message.rows<=100)terminal?.resize(message.cols,message.rows);
 else throw Error('Invalid terminal input');
}
