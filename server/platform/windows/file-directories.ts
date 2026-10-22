import {z} from 'zod';
import {type GuestExchange,transferZone,transferName,transferPath} from '../../guest-exchange.ts';
import {AppError} from '../../errors.ts';
import {TRANSFER_FOLDERS} from '../../../shared/guest-exchange.ts';
import {windowsDirectoryNameIssue,type WindowsTransferDirectory} from '../../../shared/windows-files.ts';

export const windowsDirectoryRequest=z.object({zone:transferZone,path:transferPath.default(''),name:transferName.refine(name=>windowsDirectoryNameIssue(name)===null,'文件夹名称无效')}).strict().refine(input=>{const combined=[input.path,input.name].filter(Boolean).join('/');return transferPath.safeParse(combined).success&&Buffer.byteLength(combined)<=2048;},'文件夹路径最多 2048 字节、16 层');

// Windows currently ships an AMD64 Linux base. No openat()/stat() fallback:
// openat2 also rejects bind mounts and mount crossings on the selected walk.
export const WINDOWS_DIRECTORY_PYTHON=String.raw`import ctypes,errno,json,os,platform,pwd,sys
class How(ctypes.Structure):
 _fields_=[('flags',ctypes.c_uint64),('mode',ctypes.c_uint64),('resolve',ctypes.c_uint64)]
libc=ctypes.CDLL(None,use_errno=True);libc.syscall.restype=ctypes.c_long
handles=[];changed=False
def opened(fd):handles.append(fd);return fd
def child(parent,name):
 how=How(os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,0,0x01|0x02|0x04|0x08)
 fd=libc.syscall(ctypes.c_long(437),ctypes.c_int(parent),ctypes.c_char_p(name.encode('utf8')),ctypes.byref(how),ctypes.c_size_t(ctypes.sizeof(how)))
 if fd<0:
  number=ctypes.get_errno();raise OSError(number,os.strerror(number))
 return opened(int(fd))
def name(value,visible=False):
 if not isinstance(value,str) or not value or value in ['.','..'] or len(value.encode('utf8'))>180 or '/' in value or '\\' in value or any(ord(c)<32 or ord(c)==127 for c in value):raise ValueError('Invalid name')
 if visible and (not value.strip() or value.startswith('.') or value.endswith(('.part','.tmp','.crdownload'))):raise ValueError('Hidden or empty name')
 return value
try:
 request=json.load(sys.stdin)
 if not isinstance(request,dict) or set(request)!=set(['zone','path','name']):raise ValueError('Invalid request')
 if platform.machine()!='x86_64':raise OSError(errno.ENOSYS,'Unsupported guest architecture')
 uid=pwd.getpwnam('dev').pw_uid
 if uid==0 or os.getuid()!=uid or os.geteuid()!=uid:raise ValueError('Ordinary dev identity required')
 root=opened(os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC));home=child(root,'home')
 if os.fstat(home).st_uid!=0:raise ValueError('Untrusted home ancestor')
 base=child(home,'dev')
 if os.fstat(base).st_uid!=uid:raise ValueError('Foreign home owner')
 zone=request['zone'];relative=request['path'];leaf=name(request['name'],True)
 if zone not in ['downloads','incoming','outgoing'] or not isinstance(relative,str) or len(relative)>2048:raise ValueError('Invalid folder')
 parts=[name(part) for part in relative.split('/')] if relative else []
 if len(parts)>=16 or len(('/'.join(parts+[leaf])).encode('utf8'))>2048:raise ValueError('Folder depth or path exceeded')
 fixed=['Downloads'] if zone=='downloads' else ['Transfers','Incoming' if zone=='incoming' else 'Outgoing']
 def owned(parent,part,initialize=False):
  made=False
  if initialize:
   try:os.mkdir(part,0o700,dir_fd=parent);made=True
   except FileExistsError:pass
  fd=child(parent,part)
  if os.fstat(fd).st_uid!=uid:raise ValueError('Foreign folder owner')
  if made:os.fsync(fd);os.fsync(parent)
  return fd
 parent=base
 for part in fixed:parent=owned(parent,part,True)
 for part in parts:parent=owned(parent,part)
 try:os.mkdir(leaf,0o700,dir_fd=parent);changed=True
 except FileExistsError:print(json.dumps({'status':'exists'}))
 else:
  directory=owned(parent,leaf);os.fsync(directory);os.fsync(parent)
  # Confirm that the same selected parent and final entry remain reachable.
  current=base
  for part in fixed+parts:current=owned(current,part)
  actual=owned(current,leaf)
  identity=lambda fd:(os.fstat(fd).st_dev,os.fstat(fd).st_ino)
  print(json.dumps({'status':'created' if identity(parent)==identity(current) and identity(directory)==identity(actual) else 'uncertain'}))
except OSError as failure:print(json.dumps({'status':'uncertain' if changed else 'unsupported' if failure.errno==errno.ENOSYS else 'denied'}))
except (ValueError,KeyError,TypeError,UnicodeError):print(json.dumps({'status':'uncertain' if changed else 'denied'}))
finally:
 for fd in reversed(handles):os.close(fd)
`;

export class WindowsFileDirectories {
 readonly exchange:Pick<GuestExchange,'authorize'|'runtime'|'busy'>;
 constructor(exchange:Pick<GuestExchange,'authorize'|'runtime'|'busy'>){this.exchange=exchange;}
 async create(id:string,input:unknown,signal?:AbortSignal):Promise<WindowsTransferDirectory>{
  const request=windowsDirectoryRequest.parse(input),exchange=this.exchange;
  signal?.throwIfAborted();if(exchange.busy.has(id))throw new AppError('当前环境正在传输，请稍后重试',409,'TRANSFER_BUSY');exchange.busy.add(id);
  try{
   const e=await exchange.authorize(id);if(e.kind!=='vm')throw new AppError('此功能只支持 Linux 环境',409,'FEATURE_UNAVAILABLE');signal?.throwIfAborted();
   let result:z.infer<typeof directoryResult>;
   try{const raw=await exchange.runtime.guest(e,['python3','-c','import sys,json;exec(compile(json.loads(sys.stdin.buffer.readline()), "<mu-windows-directory>", "exec"))'],{input:JSON.stringify(WINDOWS_DIRECTORY_PYTHON)+'\n'+JSON.stringify(request),signal,timeoutMs:20000,maxBytes:4096,onOutput:undefined});result=directoryResult.parse(JSON.parse(raw));}
   catch(error){if(error instanceof AppError&&['GUARD_FAILED','CONFIGURATION_CHANGED','TRANSFER_LIMIT'].includes(error.code))throw error;throw new AppError('创建尚未确认，请刷新列表；已创建的文件夹会保留。',409,'DIRECTORY_CREATE_UNCONFIRMED');}
   signal?.throwIfAborted();const current=await exchange.authorize(id);signal?.throwIfAborted();if(current.updatedAt!==e.updatedAt)throw new AppError('环境已变化，请刷新文件夹列表',409,'CONFIGURATION_CHANGED');
   if(result.status==='exists')throw new AppError('此名称已存在，请使用其他名称',409,'DIRECTORY_EXISTS');
   if(result.status==='unsupported')throw new AppError('客体不支持当前文件路径防护，请先更新空白基盘',409,'DIRECTORY_PROTECTION_UNAVAILABLE');
   if(result.status==='denied')throw new AppError('文件夹已移动，或路径、挂载和权限不符合要求，请刷新后重试',409,'DIRECTORY_PATH_DENIED');
   if(result.status!=='created')throw new AppError('创建尚未确认，请刷新列表；已创建的文件夹会保留。',409,'DIRECTORY_CREATE_UNCONFIRMED');
   const relativePath=[request.path,request.name].filter(Boolean).join('/');return {kind:'directory',zone:request.zone,name:request.name,relativePath,path:TRANSFER_FOLDERS[request.zone]+'/'+relativePath};
  }finally{exchange.busy.delete(id);}
 }
}
const directoryResult=z.object({status:z.enum(['created','exists','unsupported','denied','uncertain'])}).strict();
