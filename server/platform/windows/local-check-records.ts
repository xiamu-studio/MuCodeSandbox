import {z} from 'zod';
import type {Store} from '../../store.ts';
import {AppError} from '../../errors.ts';
import {windowsLocalCheckReportSchema,type WindowsLocalCheckReport} from '../../../shared/windows-local-check.ts';

type Row={environment_id:string;report_id:string;payload:unknown};
// A bounded last report per environment, in the existing private SQLite store.
// Payloads use its CurrentUser-DPAPI-backed encryption key. Unknown records are
// retained and cannot be replaced by the next successful check.
export class WindowsLocalCheckRecords{
 readonly store:Pick<Store,'db'|'encrypt'|'decrypt'|'get'>;issue:string|undefined;
 private observed=new Map<string,Row|null>();private owned=new Map<string,Row>();
 constructor(store:Pick<Store,'db'|'encrypt'|'decrypt'|'get'>){
  this.store=store;
  store.db.exec('CREATE TABLE IF NOT EXISTS windows_local_checks (environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE, report_id TEXT NOT NULL, payload TEXT NOT NULL)');
 }
 private parse(row:Row):WindowsLocalCheckReport{
  try{
   z.uuid().parse(row.environment_id);z.uuid().parse(row.report_id);
   if(typeof row.payload!=='string'||row.payload.length>131072||!row.payload.startsWith('enc:'))throw Error();
   const plain=this.store.decrypt(row.payload);if(Buffer.byteLength(plain)>65536)throw Error();
   const result=windowsLocalCheckReportSchema.parse(JSON.parse(plain));
   if(result.environmentId!==row.environment_id||result.id!==row.report_id)throw Error();
   this.store.get(result.environmentId);return result;
  }catch{throw new AppError('历史检测报告无法核对，原记录已保留',409,'LOCAL_CHECK_RECORD_INVALID');}
 }
 private row(id:string){return this.store.db.prepare('SELECT environment_id,report_id,CASE WHEN length(payload)<=131072 THEN payload ELSE NULL END AS payload FROM windows_local_checks WHERE environment_id=?').get(id) as Row|undefined;}
 forgetMissing(ids:Set<string>){for(const id of this.observed.keys())if(!ids.has(id))this.observed.delete(id);for(const id of this.owned.keys())if(!ids.has(id))this.owned.delete(id);}
 writable(id:string){const row=this.row(id);if(row)this.parse(row);else if(Number((this.store.db.prepare('SELECT COUNT(*) AS n FROM windows_local_checks').get() as {n:number}).n)>=50)throw new AppError('检测报告已达到保留上限，请先处理不再使用的环境',409,'LOCAL_CHECK_REPORT_LIMIT');this.observed.set(id,row??null);}
 restore(){
  const rows=this.store.db.prepare('SELECT environment_id,report_id,CASE WHEN length(payload)<=131072 THEN payload ELSE NULL END AS payload FROM windows_local_checks LIMIT 51').all() as Row[],reports:WindowsLocalCheckReport[]=[];
  if(rows.length>50)this.issue='历史检测报告超过保留上限，原记录已保留';
  for(const row of rows.slice(0,50)){
   try{
    const report=this.parse(row),job=this.store.db.prepare('SELECT environment_id,action,status FROM jobs WHERE id=?').get(report.jobId) as {environment_id:string;action:string;status:string}|undefined;
    if(report.state==='running'||report.state==='passed'&&(!job||job.environment_id!==report.environmentId||job.action!=='lab-check'||job.status!=='succeeded')){
     report.state='failed';report.error='应用退出时检测或任务确认未完成，请重新检测';report.checkedAt=new Date().toISOString();
    }
    reports.push(report);
   }catch{this.issue='部分历史检测报告无法核对，原记录已保留';}
  }
  return reports;
 }
 save(report:WindowsLocalCheckReport,begin=false){
  try{
   const validated=windowsLocalCheckReportSchema.parse(report),text=JSON.stringify(validated);if(Buffer.byteLength(text)>65536)throw Error();
   const previous=this.row(report.environmentId),expected=begin?this.observed.get(report.environmentId):this.owned.get(report.environmentId);
   if(expected===undefined||!begin&&expected?.report_id!==report.id||previous?.report_id!==(expected?.report_id)||previous?.payload!==expected?.payload)throw Error('Report identity changed');
   if(previous)this.parse(previous);else if(Number((this.store.db.prepare('SELECT COUNT(*) AS n FROM windows_local_checks').get() as {n:number}).n)>=50)throw Error('Report capacity changed');
   const payload=this.store.encrypt(text);
   if(previous){const result=this.store.db.prepare('UPDATE windows_local_checks SET report_id=?,payload=? WHERE environment_id=? AND report_id=? AND payload=?').run(report.id,payload,report.environmentId,previous.report_id,previous.payload as string);if(result.changes!==1)throw Error();}
   else this.store.db.prepare('INSERT INTO windows_local_checks(environment_id,report_id,payload) VALUES(?,?,?)').run(report.environmentId,report.id,payload);
   this.owned.set(report.environmentId,{environment_id:report.environmentId,report_id:report.id,payload});
  }catch(error){if(error instanceof AppError)throw error;throw new AppError('检测报告未能安全保存，请核对操作记录；原记录保留',409,'LOCAL_CHECK_RECORD_SAVE_FAILED');}
 }
}
