import {z} from 'zod';
import {AppError} from './errors.ts';
import {DEEPSEEK_TRANSLATE_PYTHON,TRANSLATE_BOOTSTRAP,TRANSLATION_PROMPT,translationResult,translationError} from './deepseek-translation.ts';
import {TRANSLATION_INPUT_LIMIT,TRANSLATION_RESPONSE_BYTES,TRANSLATION_TIMEOUT_SECONDS,TRANSLATION_MODEL,translationTarget,type TranslationDirection} from '../shared/translation.ts';
import type {TranslationSettings} from './translation-settings.ts';
import type {Environment} from '../shared/types.ts';
import type {LimaRuntime} from './runtime.ts';
import {TRANSFER_MAX_BYTES,CLIPBOARD_MAX_BYTES,type TransferFile,type TransferFilePage} from '../shared/guest-exchange.ts';
export const transferZone=z.enum(['incoming','outgoing','downloads']);
export const transferName=z.string().min(1).max(180).refine(name=>!/[\\/\x00-\x1f\x7f]/.test(name)&&!['.','..'].includes(name)&&Buffer.byteLength(name)<=180,'文件名不能包含路径或控制字符');
export const transferPath=z.string().max(2048).refine(value=>value===''||(value.split('/').length<=16&&value.split('/').every(part=>transferName.safeParse(part).success)),'文件夹路径无效');
export const transferRevision=z.string().regex(/^[a-f0-9]{64}$/);
export const clipboardText=z.string().max(CLIPBOARD_MAX_BYTES).refine(text=>!text.includes('\0')&&Buffer.byteLength(text)<=CLIPBOARD_MAX_BYTES,'只支持最多64 KiB的普通文本');

// Anchored descriptors reject parent symlinks, leaf symlinks, hardlinks and
// special files. The ordinary guest user can only exchange these three folders.
export const FILE_EXCHANGE_PYTHON=String.raw`import os,sys,json,stat,base64,datetime,uuid,heapq,hashlib
request=json.load(sys.stdin)
limit=26214400
def directory(parent,name):
 try:os.mkdir(name,0o700,dir_fd=parent)
 except FileExistsError:pass
 return os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
base=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
try:
 for part in '/home/dev'.strip('/').split('/'):
  nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=base);os.close(base);base=nxt
 if os.fstat(base).st_uid!=os.getuid():raise ValueError('Invalid transfer owner')
 def folder(zone):
  if zone=='downloads':return directory(base,'Downloads'),'/home/dev/Downloads'
  if zone not in ['incoming','outgoing']:raise ValueError('Invalid folder')
  parent=directory(base,'Transfers')
  try:return directory(parent,'Incoming' if zone=='incoming' else 'Outgoing'),'/home/dev/Transfers/'+('Incoming' if zone=='incoming' else 'Outgoing')
  finally:os.close(parent)
 def name(value):
  if not isinstance(value,str) or not value or value in ['.','..'] or len(value.encode())>180 or '/' in value or '\\' in value or any(ord(c)<32 or ord(c)==127 for c in value):raise ValueError('Invalid filename')
  return value
 def regular(st):return stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_size<=limit and st.st_uid==os.getuid()
 def relative(value):
  if not isinstance(value,str) or len(value)>2048 or (value and len(value.split('/'))>16):raise ValueError('Invalid folder')
  return [name(part) for part in value.split('/')] if value else []
 def nested(zone,value):
  fd,path=folder(zone)
  try:
   device=os.fstat(fd).st_dev
   for part in relative(value):
    nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
    st=os.fstat(nxt)
    if st.st_uid!=os.getuid() or st.st_dev!=device:os.close(nxt);raise ValueError('Invalid folder owner or mount')
    os.close(fd);fd=nxt;path+='/'+part
   return fd,path
  except BaseException:os.close(fd);raise
 def revision(st):return hashlib.sha256((':'.join(str(x) for x in [st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns])).encode()).hexdigest()
 action=request['action']
 if action=='browse':
  zone=request['zone'];rel=request.get('path','');fd,path=nested(zone,rel);cursor=request.get('cursor');total=0
  after=(int(cursor[2]),int(cursor[3]),cursor[4]) if cursor else None
  if cursor and (cursor[0]!=zone or cursor[1]!=rel):raise ValueError('Cursor belongs to another folder')
  try:
   def browse_entries():
    global total
    with os.scandir(fd) as items:
     for entry in items:
      try:
       item=name(entry.name)
       if item.startswith('.') or item.endswith(('.crdownload','.part','.tmp')):continue
       st=os.stat(item,dir_fd=fd,follow_symlinks=False)
       directory=stat.S_ISDIR(st.st_mode) and st.st_uid==os.getuid() and st.st_dev==os.fstat(fd).st_dev
       if not directory and not regular(st):continue
       total+=1;key=(1 if directory else 0,st.st_mtime_ns,item)
       if after is not None and key>=after:continue
       row={'zone':zone,'name':item,'bytes':0 if directory else st.st_size,'modifiedAt':datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).isoformat(),'path':path+'/'+item,'kind':'directory' if directory else 'file','relativePath':rel+'/'+item if rel else item}
       if not directory:row['revision']=revision(st)
       yield key,row
      except (OSError,ValueError):continue
   selected=heapq.nlargest(51,browse_entries(),key=lambda item:item[0]);shown=selected[:50];next_cursor=None
   if len(selected)>50:
    key=shown[-1][0];next_cursor=json.dumps([zone,rel,key[0],str(key[1]),key[2]],separators=(',',':'))
   print(json.dumps({'files':[row for key,row in shown],'total':total,'nextCursor':next_cursor}))
  finally:os.close(fd)
 elif action=='list':
  paged=request.get('paged',False);cursor=request.get('cursor');total=0
  after=(int(cursor[0]),cursor[1],cursor[2]) if cursor else None
  def entries():
   global total
   for zone in ['incoming','outgoing','downloads']:
    fd,path=folder(zone)
    try:
     with os.scandir(fd) as items:
      for entry in items:
       item=entry.name
       try:
        name(item);st=os.stat(item,dir_fd=fd,follow_symlinks=False)
        if not regular(st):continue
        total+=1;key=(st.st_mtime_ns,zone,item)
        if after is not None and key>=after:continue
        yield key,{'zone':zone,'name':item,'bytes':st.st_size,'modifiedAt':datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).isoformat(),'path':path+'/'+item}
       except (OSError,ValueError):continue
    finally:os.close(fd)
  # Keep a single page in memory while scanning; directory names and older
  # uploads must not crowd newer files out of a fixed alphabetical prefix.
  selected=heapq.nlargest(51 if paged else 150,entries(),key=lambda item:item[0])
  if paged:
   shown=selected[:50];next_cursor=None
   if len(selected)>50:
    key=shown[-1][0];next_cursor=json.dumps([str(key[0]),key[1],key[2]],separators=(',',':'))
   print(json.dumps({'files':[row for key,row in shown],'total':total,'nextCursor':next_cursor}))
  else:print(json.dumps([row for key,row in selected]))
 elif action=='upload':
  original=name(request['name']);data=base64.b64decode(request['data'],validate=True)
  if len(data)>limit:raise ValueError('File too large')
  fd,path=folder('incoming');staging=None;pending=None
  try:
   # Publish only a complete, flushed file. A killed writer can leave an
   # unpublished temporary file, but never a partial user-facing filename.
   staging=directory(fd,'.mucodesandbox-upload-staging')
   st=os.fstat(staging)
   if st.st_uid!=os.getuid() or st.st_mode&0o077:raise ValueError('Invalid staging directory')
   temporary=uuid.uuid4().hex+'.part'
   target=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=staging);pending=temporary
   with os.fdopen(target,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
   for attempt in range(100):
    candidate=original
    if attempt:
     prefix=str(attempt)+'-';stem,extension=os.path.splitext(original)
     # Keep duplicate names inside the same UTF-8 limit used by list/download.
     budget=180-len(prefix.encode())
     if len(extension.encode())>=budget:stem,extension=original,''
     stem=stem.encode()[:budget-len(extension.encode())].decode('utf8',errors='ignore')
     candidate=name(prefix+stem+extension)
    try:os.link(pending,candidate,src_dir_fd=staging,dst_dir_fd=fd,follow_symlinks=False);break
    except FileExistsError:continue
   else:raise ValueError('Too many duplicate filenames')
   os.unlink(pending,dir_fd=staging);pending=None
   print(json.dumps({'name':candidate,'path':path+'/'+candidate,'bytes':len(data)}))
  finally:
   if staging is not None:
    try:
     if pending is not None:os.unlink(pending,dir_fd=staging)
    finally:os.close(staging)
   os.close(fd)
 elif action=='download':
  item=name(request['name']);fd,path=nested(request['zone'],request.get('path',''))
  try:
   leaf=os.open(item,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
   with os.fdopen(leaf,'rb') as f:
    before=os.fstat(f.fileno())
    if not regular(before):raise ValueError('Only private regular files may be exported')
    expected=request.get('revision')
    if expected is not None and expected!=revision(before):raise ValueError('MU_TRANSFER_FILE_CHANGED')
    data=f.read(limit+1)
    if len(data)>limit:raise ValueError('File too large')
    if revision(os.fstat(f.fileno()))!=revision(before):raise ValueError('MU_TRANSFER_FILE_CHANGED')
   print(json.dumps({'data':base64.b64encode(data).decode()}))
  finally:os.close(fd)
 else:raise ValueError('Invalid action')
finally:os.close(base)
`;

export const CLIPBOARD_READ_PYTHON=String.raw`import subprocess,json,select,time,os
p=subprocess.Popen(['/usr/bin/xclip','-selection','clipboard','-out','-target','UTF8_STRING'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
data=b'';deadline=time.monotonic()+3
try:
 while True:
  if time.monotonic()>deadline:raise ValueError('Clipboard timed out')
  if not select.select([p.stdout],[],[],.1)[0]:continue
  chunk=os.read(p.stdout.fileno(),min(4096,65537-len(data)))
  if not chunk:break
  data+=chunk
  if len(data)>65536:raise ValueError('Clipboard exceeds 64 KiB')
 p.wait(timeout=1)
 print(json.dumps({'text':data.decode('utf8') if p.returncode==0 else ''}))
finally:
 if p.poll() is None:p.kill();p.wait()
`;
export const CLIPBOARD_WRITE_PYTHON=String.raw`import os,pathlib,sys,json,subprocess
value=json.load(sys.stdin)['text'].encode('utf8')
if len(value)>65536 or b'\0' in value:raise ValueError('Invalid clipboard text')
root=pathlib.Path('/run/mucodesandbox-clipboard')
if root.is_symlink() or root.stat().st_uid!=os.getuid():raise ValueError('Invalid clipboard directory')
fd=os.open(root/'text',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
with os.fdopen(fd,'wb') as f:
 import stat
 st=os.fstat(f.fileno())
 if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_uid!=os.getuid():raise ValueError('Invalid clipboard file')
 os.ftruncate(f.fileno(),0);f.write(value)
`;
export const inlineTranslationText=z.string().min(1).max(TRANSLATION_INPUT_LIMIT).refine(text=>text.length<=TRANSLATION_INPUT_LIMIT&&!!text.trim()&&!text.includes('\0'),`请输入最多 ${TRANSLATION_INPUT_LIMIT} 字的普通文本`);

export class GuestExchange {
  runtime:LimaRuntime;authorize:(id:string)=>Promise<Environment>;
  busy=new Set<string>();
  private translationSettings?:Pick<TranslationSettings,'credential'|'revision'>;
  constructor(runtime:LimaRuntime,authorize:(id:string)=>Promise<Environment>,translationSettings?:Pick<TranslationSettings,'credential'|'revision'>){this.runtime=runtime;this.authorize=authorize;this.translationSettings=translationSettings;}
  private async operation<T>(id:string,work:(e:Environment)=>Promise<T>){
    if(this.busy.has(id))throw new AppError('当前环境正在传输，请稍后重试',409,'TRANSFER_BUSY');
    this.busy.add(id);
    try{const e=await this.authorize(id);if(e.kind!=='vm')throw new AppError('此功能只支持 Linux 环境',409);
      const result=await work(e);const current=await this.authorize(id);if(current.updatedAt!==e.updatedAt)throw new AppError('环境已变化，传输结果不再交付',409);return result;
    }finally{this.busy.delete(id);}
  }
  private async files(e:Environment,input:object){
    // Keep the SSH command small: macOS mux fd passing can fail with EMSGSIZE
    // for a large command. The fixed program and its data both travel on stdin;
    // the guest task supervisor, user identity and network guard are unchanged.
    const bootstrap='import sys,json; exec(compile(json.loads(sys.stdin.readline()), "<mu-file-transfer>", "exec"))';
    try{return JSON.parse(await this.runtime.guest(e,['python3','-c',bootstrap],{input:JSON.stringify(FILE_EXCHANGE_PYTHON)+'\n'+JSON.stringify(input),timeoutMs:30000,maxBytes:TRANSFER_MAX_BYTES*2,onOutput:undefined}));}
    catch(error){if(String(error).includes('MU_TRANSFER_FILE_CHANGED'))throw new AppError('文件已更新，请刷新列表后重新下载。',409,'TRANSFER_FILE_CHANGED');throw new AppError('文件传输未完成：文件夹可能已移动，或文件大小/权限不符合要求，请刷新重试。',409,'FILE_TRANSFER_FAILED');}
  }
  list(id:string):Promise<TransferFile[]>{return this.operation(id,e=>this.files(e,{action:'list'}));}
  listPage(id:string,cursor?:string):Promise<TransferFilePage>{
    let after:unknown=null;
    if(cursor!==undefined){
      try{after=z.tuple([z.string().regex(/^-?\d{1,25}$/),transferZone,transferName]).parse(JSON.parse(z.string().max(1024).parse(cursor)));}
      catch{throw new AppError('文件列表位置无效，请刷新文件后重试',400,'INVALID_TRANSFER_CURSOR');}
    }
    return this.operation(id,e=>this.files(e,{action:'list',paged:true,cursor:after}));
  }
  listDirectory(id:string,zone:string,relativePath='',cursor?:string):Promise<TransferFilePage>{
    transferZone.parse(zone);transferPath.parse(relativePath);let after:unknown=null;
    if(cursor!==undefined){try{const value=z.tuple([transferZone,transferPath,z.union([z.literal(0),z.literal(1)]),z.string().regex(/^-?\d{1,25}$/),transferName]).parse(JSON.parse(z.string().max(4096).parse(cursor)));if(value[0]!==zone||value[1]!==relativePath)throw Error();after=value;}catch{throw new AppError('文件夹位置已变化，请刷新文件后重试',400,'INVALID_TRANSFER_CURSOR');}}
    return this.operation(id,e=>this.files(e,{action:'browse',zone,path:relativePath,cursor:after}));
  }
  upload(id:string,name:string,data:Buffer){transferName.parse(name);if(data.length>TRANSFER_MAX_BYTES)throw new AppError('单个文件最多25 MiB',413);return this.operation(id,e=>this.files(e,{action:'upload',name,data:data.toString('base64')}));}
  download(id:string,zone:string,name:string,relativePath='',revision?:string){transferZone.parse(zone);transferName.parse(name);transferPath.parse(relativePath);if(revision!==undefined)transferRevision.parse(revision);return this.operation(id,async e=>Buffer.from((await this.files(e,{action:'download',zone,name,path:relativePath,revision})).data,'base64'));}
  translate(id:string,text:string,direction:TranslationDirection='auto'){inlineTranslationText.parse(text);return this.operation(id,async e=>{
    if(!this.translationSettings)throw new AppError('请先在翻译设置中填写 DeepSeek API Key。',409,'TRANSLATION_KEY_REQUIRED');
    const credential=this.translationSettings.credential(),target=translationTarget(text,direction);
    let result:z.infer<typeof translationResult>;
    try{
      // Keep the SSH command short; program and private text both travel on stdin.
      const raw=await this.runtime.guest(e,['python3','-c',TRANSLATE_BOOTSTRAP],{input:JSON.stringify(DEEPSEEK_TRANSLATE_PYTHON)+'\n'+JSON.stringify({text,apiKey:credential.apiKey,target,model:TRANSLATION_MODEL,prompt:TRANSLATION_PROMPT}),timeoutMs:(TRANSLATION_TIMEOUT_SECONDS+6)*1000,maxBytes:TRANSLATION_RESPONSE_BYTES,onOutput:undefined});
      result=translationResult.parse(JSON.parse(raw));
    }catch(error){
      if(error instanceof AppError&&error.code==='TIMEOUT')throw translationError('timeout');
      throw new AppError('沙箱翻译调用未完成，请重试。原文已保留。',502,'TRANSLATION_UNAVAILABLE');
    }
    if(credential.revision!==this.translationSettings.revision)throw new AppError('翻译密钥已更改，请重新翻译。原文已保留。',409,'TRANSLATION_SETTINGS_CHANGED');
    if('error' in result)throw translationError(result.error,result.httpStatus);
    return result;
  });}
  readClipboard(id:string){return this.operation(id,async e=>{
    try{return JSON.parse(await this.runtime.management(e,['sudo','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','DISPLAY=:99','XAUTHORITY=/run/mu-browser/Xauthority','python3','-c',CLIPBOARD_READ_PYTHON],{timeoutMs:6000,maxBytes:CLIPBOARD_MAX_BYTES*8,onOutput:undefined}));}
    catch{throw new AppError('无法读取沙箱文本；请先在沙箱中复制，且文本不超过64 KiB',409);}
  });}
  writeClipboard(id:string,text:string){clipboardText.parse(text);return this.operation(id,async e=>{
    await this.runtime.management(e,['bash','-s'],{input:`set -eu
systemctl is-active --quiet mucodesandbox-display.service
sudo systemctl stop mucodesandbox-clipboard.service 2>/dev/null || true
sudo python3 - <<'MU_CLIPBOARD_DIR'
import pathlib,os,pwd
p=pathlib.Path('/run/mucodesandbox-clipboard');uid=pwd.getpwnam('dev').pw_uid
if p.is_symlink():raise ValueError('Invalid clipboard directory')
if p.exists():
 if not p.is_dir() or p.stat().st_uid!=uid:raise ValueError('Invalid clipboard owner')
else:
 p.mkdir(mode=0o700);os.chown(p,uid,pwd.getpwnam('dev').pw_gid)
p.chmod(0o700)
MU_CLIPBOARD_DIR
`,timeoutMs:6000,onOutput:undefined});
    await this.runtime.management(e,['sudo','-H','-u','dev','--','python3','-c',CLIPBOARD_WRITE_PYTHON],{input:JSON.stringify({text}),timeoutMs:6000,onOutput:undefined});
    await this.runtime.management(e,['bash','-s'],{input:`set -eu
sudo tee /etc/systemd/system/mucodesandbox-clipboard.service >/dev/null <<'MU_CLIPBOARD'
[Unit]
BindsTo=mucodesandbox-display.service
After=mucodesandbox-display.service
PartOf=mucodesandbox-display.service
[Service]
User=dev
Group=dev
UMask=0077
Environment=DISPLAY=:99 XAUTHORITY=/run/mu-browser/Xauthority
ExecStart=/usr/bin/xclip -selection clipboard -quiet -in /run/mucodesandbox-clipboard/text
ExecStopPost=/usr/bin/rm -f /run/mucodesandbox-clipboard/text
KillMode=control-group
Restart=no
MU_CLIPBOARD
sudo systemctl daemon-reload
sudo systemctl start mucodesandbox-clipboard.service
`,timeoutMs:10000,onOutput:undefined});return {ok:true};
  });}
}
