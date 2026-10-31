// Fixed stage names and durations only: no URLs, page contents or credentials.
export class BrowserStartupTiming {
 private last:number;
 private readonly spans:number[]=[];
 private browserStart:number|undefined;
 private readonly browserPhases:number[]=[];
 private readonly homeSpans=new Map<'prepare'|'guard'|'install'|'navigate',number[]>();
 private readonly now:()=>number;
 constructor(now:()=>number=()=>performance.now()){this.now=now;this.last=now();}
 mark(){const current=this.now();this.spans.push(Math.min(3600000,Math.max(0,Math.round(current-this.last))));this.last=current;}
 browserPhase(){const current=this.now();if(this.browserStart!==undefined)this.browserPhases.push(Math.min(3600000,Math.max(0,Math.round(current-this.browserStart))));this.browserStart=current;}
 browserDetails(){if(this.browserPhases.length!==3)return undefined;const [launch,sandbox,home]=this.browserPhases;return `浏览器启动细分：启动与连接 ${launch} ms；隔离检查 ${sandbox} ms；启动页及保护检查 ${home} ms。`;}
 async homeStep<T>(step:'prepare'|'guard'|'install'|'navigate',action:()=>Promise<T>):Promise<T>{
  const start=this.now();
  try{return await action();}finally{const spans=this.homeSpans.get(step)??[];spans.push(Math.min(3600000,Math.max(0,Math.round(this.now()-start))));this.homeSpans.set(step,spans);}
 }
 homeDetails(){
  const prepare=this.homeSpans.get('prepare'),guard=this.homeSpans.get('guard'),install=this.homeSpans.get('install'),navigate=this.homeSpans.get('navigate');
  if(prepare?.length!==1||guard?.length!==3||install?.length!==1||navigate?.length!==1)return undefined;
  return `本地首页启动耗时：准备 ${prepare[0]} ms；三次保护核验 ${guard[0]}/${guard[1]}/${guard[2]} ms；写入 ${install[0]} ms；打开 ${navigate[0]} ms。`;
 }
 message(){
  if(this.spans.length!==4)return undefined;
  const [access,checks,display,browser]=this.spans;
  return `浏览器启动耗时：会话准备 ${access} ms；组件与资料检查 ${checks} ms；图形服务 ${display} ms；浏览器与隔离核验 ${browser} ms。`;
 }
}
