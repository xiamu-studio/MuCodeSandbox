import type {Store} from '../../store.ts';
import {AppError} from '../../errors.ts';

const WEEK=7*24*60*60*1000,HOUR=60*60*1000;
type Outcome='pending'|'done'|'blocked'|'failed';
type Row={enabled:number;nextAt:number;lastAt:number|null;result:Outcome|null};
export interface CompactionScheduleBackend {
 eligible(id:string):boolean;
 pending(id:string):Promise<boolean>;
 compact(id:string):Promise<void>;
}

// Experimental and opt-in. No timer is started by this class until start().
// A durable pending record precedes mutation; uncertain outcomes are never
// automatically retried, including after service or machine restart.
export class WindowsDiskCompactionSchedule {
 private closed=false;private active=new Map<string,Promise<void>>();private sweep:Promise<void>|undefined;private timer:ReturnType<typeof setInterval>|undefined;
 private configuring=new Map<string,object>();
 private store:Pick<Store,'db'>;private backend:CompactionScheduleBackend;private now:()=>number;
 constructor(store:Pick<Store,'db'>,backend:CompactionScheduleBackend,now=()=>Date.now()){
  this.store=store;this.backend=backend;this.now=now;
  store.db.exec('CREATE TABLE IF NOT EXISTS windows_disk_compaction_schedule (environment_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL,next_at INTEGER NOT NULL,last_at INTEGER,result TEXT)');
 }
 private read(id:string):Row{
  const row=this.store.db.prepare('SELECT enabled,next_at AS nextAt,last_at AS lastAt,result FROM windows_disk_compaction_schedule WHERE environment_id=?').get(id) as Row|undefined;
  if(!row)return {enabled:0,nextAt:0,lastAt:null,result:null};
  if(![0,1].includes(row.enabled)||!Number.isSafeInteger(row.nextAt)||row.nextAt<0||row.lastAt!==null&&(!Number.isSafeInteger(row.lastAt)||row.lastAt<0)||row.result!==null&&!['pending','done','blocked','failed'].includes(row.result))throw new AppError('定期磁盘回收设置无法核验，自动回收已停止',409,'DISK_SCHEDULE_INVALID');
  return row;
 }
 private clock(extra:number){const value=this.now();if(!Number.isSafeInteger(value)||value<0||value>Number.MAX_SAFE_INTEGER-extra)throw Error('Invalid schedule clock');return value;}
 status(id:string){const row=this.read(id);return {enabled:row.enabled===1,nextAt:row.enabled?row.nextAt:null,lastAt:row.lastAt,result:row.result,running:this.active.has(id)};}
 async configure(id:string,enabled:boolean){
  if(this.closed)throw new AppError('服务正在关闭',409,'DISK_SCHEDULE_CLOSED');
  if(this.active.has(id))throw new AppError('磁盘回收正在处理，请稍后修改设置',409,'DISK_SCHEDULE_BUSY');
  if(typeof enabled!=='boolean')throw new AppError('定期回收设置无效',400,'DISK_SCHEDULE_INVALID');
  this.read(id);const token={};this.configuring.set(id,token);
  try{
   if(enabled&&await this.backend.pending(id))throw new AppError('上次磁盘维护尚未确认，请先继续检查原操作',409,'DISK_COMPACTION_PENDING');
   if(this.configuring.get(id)!==token)throw new AppError('定期回收设置已变化，请刷新状态',409,'DISK_SCHEDULE_CHANGED');
   if(this.closed||this.active.has(id))throw new AppError('磁盘回收状态已变化',409,'DISK_SCHEDULE_BUSY');
   const now=this.clock(WEEK);
   this.store.db.prepare(`INSERT INTO windows_disk_compaction_schedule(environment_id,enabled,next_at,last_at,result) VALUES(?,?,?,NULL,NULL)
     ON CONFLICT(environment_id) DO UPDATE SET enabled=excluded.enabled,next_at=excluded.next_at,result=CASE WHEN windows_disk_compaction_schedule.result IN ('pending','failed') AND excluded.enabled=1 THEN NULL ELSE windows_disk_compaction_schedule.result END`).run(id,enabled?1:0,enabled?now+WEEK:0);
   return this.status(id);
  }finally{if(this.configuring.get(id)===token)this.configuring.delete(id);}
 }
 start(){if(this.closed||this.timer)return;const tick=()=>{void this.run().catch(()=>{});};this.timer=setInterval(tick,HOUR);this.timer.unref();tick();}
 run():Promise<void>{
  if(this.closed)return Promise.resolve();if(this.sweep)return this.sweep;
  const work=this.runDue();const tracked=work.finally(()=>{if(this.sweep===tracked)this.sweep=undefined;});this.sweep=tracked;return tracked;
 }
 private async runDue(){
  const rows=this.store.db.prepare('SELECT environment_id AS id FROM windows_disk_compaction_schedule WHERE enabled=1 AND next_at<=? AND (result IS NULL OR result NOT IN (?,?)) ORDER BY next_at,environment_id').all(this.clock(WEEK),'pending','failed') as {id:string}[];
  for(const {id} of rows){if(this.closed)return;if(this.active.has(id))continue;const work=this.runOne(id);this.active.set(id,work);try{await work;}finally{this.active.delete(id);}}
 }
 private async runOne(id:string){
  const now=this.clock(WEEK),row=this.read(id);if(!row.enabled||row.nextAt>now||row.result==='pending'||row.result==='failed')return;
  if(!this.backend.eligible(id)){this.store.db.prepare("UPDATE windows_disk_compaction_schedule SET next_at=?,last_at=?,result='blocked' WHERE environment_id=? AND enabled=1").run(now+HOUR,now,id);return;}
  try{
   if(await this.backend.pending(id))throw new Error('Previous maintenance remains unconfirmed');
   if(this.closed)return;
   if(!this.backend.eligible(id)){this.store.db.prepare("UPDATE windows_disk_compaction_schedule SET next_at=?,last_at=?,result='blocked' WHERE environment_id=? AND enabled=1").run(now+HOUR,now,id);return;}
   const changed=this.store.db.prepare("UPDATE windows_disk_compaction_schedule SET last_at=?,result='pending' WHERE environment_id=? AND enabled=1 AND result IS NOT 'pending'").run(now,id);if(changed.changes!==1)return;
   await this.backend.compact(id);
   if(!this.closed){const finished=this.clock(WEEK);this.store.db.prepare("UPDATE windows_disk_compaction_schedule SET next_at=?,last_at=?,result='done' WHERE environment_id=? AND enabled=1 AND result='pending'").run(finished+WEEK,finished,id);}
  }catch{
   // A failure may hide a submitted provider job. Preserve the protected
   // journal and require explicit inspection before opting in again.
   if(!this.closed)this.store.db.prepare("UPDATE windows_disk_compaction_schedule SET enabled=0,next_at=0,last_at=?,result='failed' WHERE environment_id=?").run(this.clock(0),id);
  }
 }
 stop(){this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;}
}
