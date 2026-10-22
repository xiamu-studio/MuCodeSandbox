import {constants,openSync,closeSync,lstatSync,fstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,fsyncSync,type Stats} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {AppError} from '../../errors.ts';
import {translationApiKey} from '../../translation-settings.ts';
import type {Store} from '../../store.ts';
import {TRANSLATION_MODEL,type TranslationSettingsStatus} from '../../../shared/translation.ts';

const record=z.object({version:z.literal(1),encryptedKey:z.string().startsWith('enc:').max(2048)}).strict();
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.birthtimeMs===b.birthtimeMs;
// The service opens this only after openWindowsStore has secured the directory
// DACL and loaded its CurrentUser-DPAPI protected encryption key. Keep settings
// separate from environment configuration, snapshots and future backup exports.
export class WindowsTranslationSettings {
 private readonly file:string;private readonly root:Stats;readonly store:Pick<Store,'dataDir'|'encrypt'|'decrypt'>;revision=0;
 constructor(store:Pick<Store,'dataDir'|'encrypt'|'decrypt'>){this.store=store;this.file=path.join(store.dataDir,'windows-translation-provider.json');this.root=lstatSync(store.dataDir);this.directory();}
 private directory(){const actual=lstatSync(this.store.dataDir);if(!actual.isDirectory()||actual.isSymbolicLink()||!same(actual,this.root))throw Error('Windows translation data directory changed');}
 private read():z.infer<typeof record>|null {
  let fd:number|undefined;
  try{
   this.directory();let before:Stats;
   try{before=lstatSync(this.file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
   if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>4096)throw Error();
   fd=openSync(this.file,constants.O_RDONLY);const opened=fstatSync(fd);
   if(!opened.isFile()||opened.nlink!==1||opened.size>4096||!same(before,opened))throw Error();
   const value=record.parse(JSON.parse(readFileSync(fd,'utf8')));this.directory();return value;
  }catch{throw new AppError('Windows 翻译密钥文件无法安全读取，请保留文件并检查本机配置。',409,'TRANSLATION_SETTINGS_INVALID');}
  finally{if(fd!==undefined)closeSync(fd);}
 }
 status():TranslationSettingsStatus{return{configured:this.read()!==null,provider:'DeepSeek',model:TRANSLATION_MODEL};}
 credential(){const value=this.read();if(!value)throw new AppError('请先在翻译设置中填写 DeepSeek API Key。',409,'TRANSLATION_KEY_REQUIRED');try{return{apiKey:translationApiKey.parse(this.store.decrypt(value.encryptedKey)),revision:this.revision};}catch{throw new AppError('Windows 翻译密钥无法解密，请重新填写。',409,'TRANSLATION_KEY_INVALID');}}
 save(value:string){
  const key=translationApiKey.parse(value);this.read();const temporary=path.join(this.store.dataDir,'.windows-translation-'+randomUUID()+'.next');let created=false;
  try{this.directory();const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);created=true;try{writeFileSync(fd,JSON.stringify({version:1,encryptedKey:this.store.encrypt(key)}));fsyncSync(fd);}finally{closeSync(fd);}this.read();this.directory();renameSync(temporary,this.file);created=false;this.revision++;return this.status();}
  catch{throw new AppError('Windows 翻译密钥未能保存，原有配置已保留。',409,'TRANSLATION_SETTINGS_SAVE_FAILED');}
  finally{if(created)try{unlinkSync(temporary);}catch{/* Preserve an unexpected temporary entry instead of following it. */}}
 }
 clear(){if(this.read()){this.directory();unlinkSync(this.file);}this.revision++;return this.status();}
}
