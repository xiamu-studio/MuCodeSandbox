import type {Store} from '../../store.ts';
import type {WindowsStorage} from './storage.ts';
import {AppError} from '../../errors.ts';
import type {WindowsCacheScheduleStatus,WindowsCacheScheduleResult} from '../../../shared/windows-storage.ts';

const DAY=24*60*60*1000, RETRY=60*60*1000;
type Result=WindowsCacheScheduleResult;
type RecordValue={enabled:number;nextAt:number;lastAt:number|null;result:Result|null;files:number;bytes:number};

// An opt-in schedule runs only while this service is open. Every run reuses
// the native cache inventory, protected-reference validation and plan check.
export class WindowsCacheSchedule {
 private closed=false;private generation=0;private active:Promise<void>|undefined;private timer:ReturnType<typeof setInterval>|undefined;
 readonly store:Pick<Store,'db'>;readonly storage:Pick<WindowsStorage,'inspect'|'prune'>;readonly idle:()=>boolean;readonly now:()=>number;
 constructor(store:Pick<Store,'db'>,storage:Pick<WindowsStorage,'inspect'|'prune'>,idle:()=>boolean,now=()=>Date.now()){
  this.store=store;this.storage=storage;this.idle=idle;this.now=now;
  this.store.db.exec(`CREATE TABLE IF NOT EXISTS windows_cache_schedule (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, next_at INTEGER NOT NULL, last_at INTEGER, result TEXT, files INTEGER NOT NULL, bytes INTEGER NOT NULL)`);
 }
 private read():RecordValue {
  const row=this.store.db.prepare('SELECT enabled,next_at AS nextAt,last_at AS lastAt,result,files,bytes FROM windows_cache_schedule WHERE id=1').get() as RecordValue|undefined;
  if(!row)return {enabled:0,nextAt:0,lastAt:null,result:null,files:0,bytes:0};
  if(![0,1].includes(row.enabled)||!Number.isSafeInteger(row.nextAt)||row.nextAt<0||row.lastAt!==null&&(!Number.isSafeInteger(row.lastAt)||row.lastAt<0)||row.result!==null&&!['pending','nothing','cleaned','blocked','failed'].includes(row.result)||!Number.isSafeInteger(row.files)||row.files<0||!Number.isSafeInteger(row.bytes)||row.bytes<0)throw new AppError('定期缓存清理设置无法核验，自动清理已停止。',409,'CACHE_SCHEDULE_INVALID');
  return row;
 }
 status():WindowsCacheScheduleStatus {const row=this.read();return {enabled:row.enabled===1,nextAt:row.enabled?row.nextAt:null,lastAt:row.lastAt,result:row.result,files:row.files,bytes:row.bytes,running:!!this.active};}
 configure(enabled:boolean):WindowsCacheScheduleStatus {
  if(this.closed)throw new AppError('服务正在关闭',409,'CACHE_SCHEDULE_CLOSED');
  if(this.active)throw new AppError('定期清理正在核验或执行，请稍后修改设置。',409,'CACHE_SCHEDULE_BUSY');
  if(typeof enabled!=='boolean')throw new AppError('清理设置无效',400,'CACHE_SCHEDULE_INVALID');
  this.read();const now=this.now();if(!Number.isSafeInteger(now)||now<0||now>Number.MAX_SAFE_INTEGER-DAY)throw Error('Invalid schedule clock');this.generation++;
  this.store.db.prepare(`INSERT INTO windows_cache_schedule(id,enabled,next_at,last_at,result,files,bytes) VALUES(1,?,?,NULL,NULL,0,0)
    ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,next_at=excluded.next_at`).run(enabled?1:0,enabled?now+DAY:0);
  return this.status();
 }
 start(){if(this.closed||this.timer)return;const tick=()=>{void Promise.resolve().then(()=>this.run()).catch(()=>{});};this.timer=setInterval(tick,RETRY);this.timer.unref();tick();}
 run():Promise<void>{if(this.closed)return Promise.resolve();if(this.active)return this.active;
  const row=this.read(),now=this.now();if(!row.enabled||now<row.nextAt)return Promise.resolve();const epoch=this.generation;
  const work=(async()=>{
   let result:Result='failed',files=0,bytes=0;
   try{
    if(!this.idle()){result='blocked';}
    else{const plan=await this.storage.inspect();
      if(this.closed||this.generation!==epoch||!this.read().enabled)return;
      if(plan.reason){result='blocked';}
      else if(!plan.canPrune){result='nothing';}
      else if(!this.idle()){result='blocked';}
      else{
       // Persist uncertainty before mutation. A crash or lost reply is never
       // displayed as a completed cleanup; the next run inspects afresh.
       const pendingAt=this.now();if(!Number.isSafeInteger(pendingAt)||pendingAt<0||pendingAt>Number.MAX_SAFE_INTEGER-RETRY)throw Error('Invalid schedule clock');
       const receipt=this.store.db.prepare("UPDATE windows_cache_schedule SET next_at=?,last_at=?,result='pending',files=0,bytes=0 WHERE id=1 AND enabled=1").run(pendingAt+RETRY,pendingAt);
       if(receipt.changes!==1)throw Error('Cleanup schedule changed');
       const cleared=await this.storage.prune(plan.plan,this.idle);files=cleared.deletedFiles;bytes=cleared.reclaimedBytes;result='cleaned';
      }
    }
   }catch{result='failed';}
   if(this.closed||this.generation!==epoch||!this.read().enabled)return;
   const completed=this.now();this.store.db.prepare('UPDATE windows_cache_schedule SET next_at=?,last_at=?,result=?,files=?,bytes=? WHERE id=1 AND enabled=1').run(completed+(result==='blocked'||result==='failed'?RETRY:DAY),completed,result,files,bytes);
  })();
  const tracked=work.finally(()=>{if(this.active===tracked)this.active=undefined;});this.active=tracked;return tracked;
 }
 stop(){this.closed=true;this.generation++;if(this.timer)clearInterval(this.timer);this.timer=undefined;}
}
