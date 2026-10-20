import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { Environment, Job, LogEntry } from '../shared/types.ts';
import { AppError } from './errors.ts';
import { redact, identitySchema } from './validation.ts';
import type {ProtectionEvent,ProtectionResolution} from '../shared/protection-events.ts';
import {EXIT_CHECK_HOSTS,type ConnectionObservation,type ConnectionQuery} from '../shared/network-observations.ts';

export class Store {
  db: DatabaseSync;
  key: Buffer;
  dataDir: string;
  constructor(dataDir: string, credentialKey?: Buffer) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    if(credentialKey){
      if(credentialKey.length!==32)throw new AppError('凭据加密密钥无效',500,'INVALID_CREDENTIAL_KEY');
      this.key=Buffer.from(credentialKey);
    }else{
      const keyFile = path.join(dataDir, 'credentials.key');
      if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
      this.key = readFileSync(keyFile);
    }
    this.db = new DatabaseSync(path.join(dataDir, 'state.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, environment_id TEXT, action TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, environment_id TEXT, job_id TEXT, level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS logs_environment ON logs(environment_id,id);
      CREATE TABLE IF NOT EXISTS network_records (id INTEGER PRIMARY KEY AUTOINCREMENT, environment_id TEXT NOT NULL, kind TEXT NOT NULL, config_key TEXT NOT NULL, source_key TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(environment_id,kind,source_key));
      CREATE INDEX IF NOT EXISTS network_records_environment ON network_records(environment_id,kind,config_key,id);
      CREATE TABLE IF NOT EXISTS protection_events (id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS protection_events_environment ON protection_events(environment_id,created_at);
      PRAGMA user_version=1;`);
    chmodSync(path.join(dataDir, 'state.sqlite'), 0o600);
    this.db.prepare("UPDATE jobs SET status='failed',message='应用重启，操作已中断，请检查环境状态',finished_at=? WHERE status='running'").run(new Date().toISOString());
  }
  encrypt(secret: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return `enc:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }
  decrypt(secret: string) {
    if (!secret.startsWith('enc:')) return '';
    const data = Buffer.from(secret.slice(4), 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
  }
  save(environment: Environment) {
    const stored = structuredClone(environment);
    if (stored.network.password) stored.network.password = this.encrypt(stored.network.password);
    if (stored.network.wireguard?.privateKey) stored.network.wireguard.privateKey = this.encrypt(stored.network.wireguard.privateKey);
    if (stored.network.wireguard) delete stored.network.wireguard.privateKeyConfigured;
    delete stored.network.passwordConfigured;
    stored.updatedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO environments(id,config) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config').run(stored.id, JSON.stringify(stored));
  }
  decode(config: string): Environment {
    const e = JSON.parse(config) as Environment;
    if (e.network.password) e.network.password = this.decrypt(e.network.password);
    if (e.network.wireguard?.privateKey) e.network.wireguard.privateKey = this.decrypt(e.network.wireguard.privateKey);
    e.network.strict ??= false;
    e.network.transparent ??= false;
    e.identity = identitySchema.parse(e.identity ?? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: 'en-US' });
    e.browserRunning = false;
    return e;
  }
  get(id: string) {
    const row = this.db.prepare('SELECT config FROM environments WHERE id=?').get(id) as { config: string } | undefined;
    if (!row) throw new AppError('找不到这个环境', 404, 'NOT_FOUND');
    return this.decode(row.config);
  }
  list() { return (this.db.prepare('SELECT config FROM environments ORDER BY rowid DESC').all() as { config: string }[]).map(r => this.decode(r.config)); }
  public(e: Environment): Environment {
    const result = structuredClone(e);
    result.network.passwordConfigured = Boolean(result.network.password);
    delete result.network.password;
    if (result.network.wireguard) {
      result.network.wireguard.privateKeyConfigured = Boolean(result.network.wireguard.privateKey);
      delete result.network.wireguard.privateKey;
    }
    return result;
  }
  state(id: string, state: Environment['state'], lastError: string | null = null) {
    const e = this.get(id);
    this.save({ ...e, state, lastError: lastError ? redact(lastError).slice(-2400) : null });
  }
  remove(id: string) { this.db.prepare('DELETE FROM protection_events WHERE environment_id=?').run(id);this.db.prepare('DELETE FROM network_records WHERE environment_id=?').run(id);this.db.prepare('DELETE FROM environments WHERE id=?').run(id); }
  addProtectionEvent(event:ProtectionEvent){
    this.db.prepare('INSERT INTO protection_events VALUES(?,?,?,?)').run(event.id,event.environmentId,JSON.stringify(event),event.at);
    this.db.prepare('DELETE FROM protection_events WHERE environment_id=? AND id NOT IN (SELECT id FROM protection_events WHERE environment_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100)').run(event.environmentId,event.environmentId);
  }
  protectionEvents(id:string):ProtectionEvent[]{return (this.db.prepare('SELECT payload FROM protection_events WHERE environment_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(id) as {payload:string}[]).map(row=>JSON.parse(row.payload));}
  updateProtectionStop(id:string,status:ProtectionEvent['stopResult'],issue?:string){
    const row=this.db.prepare('SELECT payload FROM protection_events WHERE id=?').get(id) as {payload:string}|undefined;if(!row)return;
    const event:ProtectionEvent=JSON.parse(row.payload);event.stopResult=status;if(issue)event.stopIssue=redact(issue).slice(0,2400);this.db.prepare('UPDATE protection_events SET payload=? WHERE id=?').run(JSON.stringify(event),id);
  }
  resolveProtectionEvents(id:string,proof:ProtectionResolution){
    const valid=proof.ip&&new Set(proof.receipts.map(r=>r.receiver)).size>=2&&proof.receipts.every(r=>r.ip===proof.ip);
    for(const event of this.protectionEvents(id)){
      if(event.resolvedAt)continue;
      if(['exit-changed','exit-unavailable','connection','tls','proxy-auth','dns'].includes(event.kind)&&!valid)continue;
      event.resolvedAt=proof.at;event.resolution=proof;this.db.prepare('UPDATE protection_events SET payload=? WHERE id=?').run(JSON.stringify(event),event.id);
    }
  }
  newJob(environmentId: string | null, action: string): Job {
    const job: Job = { id: randomUUID(), environmentId, action, status: 'running', message: '', createdAt: new Date().toISOString(), finishedAt: null };
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(job.id, environmentId, action, job.status, '', job.createdAt, null);
    return job;
  }
  finishJob(id: string, status: Job['status'], message: string) {
    this.db.prepare('UPDATE jobs SET status=?,message=?,finished_at=? WHERE id=?').run(status, redact(message), new Date().toISOString(), id);
  }
  jobs() { return (this.db.prepare('SELECT id,environment_id AS environmentId,action,status,message,created_at AS createdAt,finished_at AS finishedAt FROM jobs ORDER BY created_at DESC LIMIT 50').all()) as unknown as Job[]; }
  log(environmentId: string | null, jobId: string | null, message: string, level: LogEntry['level'] = 'info') {
    this.db.prepare('INSERT INTO logs(environment_id,job_id,level,message,created_at) VALUES(?,?,?,?,?)').run(environmentId, jobId, level, redact(message).slice(0, 8000), new Date().toISOString());
    this.db.exec('DELETE FROM logs WHERE id < (SELECT COALESCE(MAX(id),0)-12000 FROM logs)');
  }
  logs(environmentId: string | null, after = 0) {
    const query = environmentId
      ? this.db.prepare('SELECT id,environment_id AS environmentId,job_id AS jobId,level,message,created_at AS createdAt FROM logs WHERE environment_id=? AND id>? ORDER BY id DESC LIMIT 300')
      : this.db.prepare('SELECT id,environment_id AS environmentId,job_id AS jobId,level,message,created_at AS createdAt FROM logs WHERE id>? ORDER BY id DESC LIMIT 300');
    return (environmentId ? query.all(environmentId, after) : query.all(after)).reverse() as unknown as LogEntry[];
  }
  close() { this.db.close(); }
  addNetworkRecord(id:string,kind:'sample'|'connection'|'gap'|'approval',key:string,source:string,payload:unknown) {
    this.db.prepare('INSERT OR IGNORE INTO network_records(environment_id,kind,config_key,source_key,payload,created_at) VALUES(?,?,?,?,?,?)')
      .run(id,kind,key,source,JSON.stringify(payload),new Date().toISOString());
    this.db.prepare('DELETE FROM network_records WHERE created_at<?').run(new Date(Date.now()-7*86400_000).toISOString());
    this.db.exec('DELETE FROM network_records WHERE id <= (SELECT COALESCE(MAX(id),0)-10000 FROM network_records)');
  }
  networkRecords(id:string,kind:'sample'|'connection'|'gap'|'approval',key:string) {
    return (this.db.prepare('SELECT id,payload FROM network_records WHERE environment_id=? AND kind=? AND config_key=? ORDER BY id DESC LIMIT 300').all(id,kind,key) as {id:number;payload:string}[])
      .reverse().map(r=>({...JSON.parse(r.payload),id:r.id}));
  }
  networkSampleHistory(id:string,key:string) {
    return (this.db.prepare("SELECT id,payload FROM network_records WHERE environment_id=? AND kind='sample' AND config_key LIKE ? ORDER BY id DESC LIMIT 300").all(id,`%:${key}:%`) as {id:number;payload:string}[])
      .reverse().map(r=>({...JSON.parse(r.payload),id:r.id}));
  }
  networkConnectionPage(id:string,key:string,query:ConnectionQuery){
    let where="environment_id=? AND kind='connection' AND config_key=?";const values:(string|number)[]=[id,key];
    const retained=Number((this.db.prepare('SELECT COUNT(*) AS n FROM network_records WHERE '+where).get(...values) as {n:number}).n);
    if(query.scope&&query.scope!=='all'){
      const slots=EXIT_CHECK_HOSTS.map(()=>'?').join(',');
      // Explicit TUN traffic overrides the legacy host heuristic. Never hide a
      // shared server connection merely because its weaker DNS reference is a probe.
      const check=`CASE WHEN json_extract(payload,'$.origin')='exit-check' THEN 1 WHEN json_extract(payload,'$.origin')='traffic' THEN 0 ELSE (lower(json_extract(payload,'$.target')) IN (${slots}) OR (json_extract(payload,'$.domainSource')='connection' AND lower(json_extract(payload,'$.domain')) IN (${slots}))) END`;
      where+=` AND COALESCE((${check}),0)=${query.scope==='checks'?1:0}`;values.push(...EXIT_CHECK_HOSTS,...EXIT_CHECK_HOSTS);
    }
    if(query.failures)where+=" AND json_extract(payload,'$.status')='failed'";
    if(query.q?.trim()){
      where+=" AND instr(lower(COALESCE(json_extract(payload,'$.target'),'')||' '||COALESCE(json_extract(payload,'$.domain'),'')||' '||COALESCE(json_extract(payload,'$.domainCandidates'),'')||' '||COALESCE(json_extract(payload,'$.exitIp'),'')),?)>0";values.push(query.q.trim().toLowerCase());
    }
    const total=Number((this.db.prepare('SELECT COUNT(*) AS n FROM network_records WHERE '+where).get(...values) as {n:number}).n);
    if(query.before!==undefined){where+=' AND id<?';values.push(query.before);}
    const rows=this.db.prepare('SELECT id,payload FROM network_records WHERE '+where+' ORDER BY id DESC LIMIT 301').all(...values) as {id:number;payload:string}[];
    const more=rows.length>300;const page=rows.slice(0,300);
    return{connections:page.reverse().map(row=>({...JSON.parse(row.payload),id:row.id})) as ConnectionObservation[],connectionPage:{total,retained,nextBefore:more?page[0].id:null}};
  }
}
