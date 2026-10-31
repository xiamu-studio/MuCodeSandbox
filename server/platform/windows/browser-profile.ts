import {z} from 'zod';
import {AppError} from '../../errors.ts';
import {WINDOWS_BROWSER_SELECTION_HELPERS,windowsBrowserApprovedVersion,windowsBrowserSelectedVersion} from './browser-selection.ts';
import type {WindowsBrowserProfileStatus} from '../../../shared/windows-browser-profile.ts';

// Runs as dev. Fixed relative no-follow descriptors; never reads profile
// contents other than the bounded version record, launches, or writes files.
export function windowsBrowserProfileHelpers(expectedVersion?:string){
 const expected=expectedVersion===undefined?'None':JSON.stringify(windowsBrowserSelectedVersion(expectedVersion));
 return String.raw`
import os,stat,re,json
${WINDOWS_BROWSER_SELECTION_HELPERS}
MU_PROFILE_EXPECTED=${expected}
class MuProfileRefused(Exception):
 def __init__(self,issue):self.issue=issue
def mu_profile_require(ok,issue):
 if not ok:raise MuProfileRefused(issue)
def mu_profile_version(value):return isinstance(value,str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){3}',value) is not None
def mu_profile_stamp(info):return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
def mu_profile_directory(info,owner):mu_profile_require(stat.S_ISDIR(info.st_mode) and info.st_uid==owner and not info.st_mode&0o022,'permissions')
def mu_profile_regular(info):mu_profile_require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and not info.st_mode&0o022 and info.st_nlink==1 and 0<info.st_size<=256,'permissions')
def mu_profile_inspect():
 handles=[];parents=[];missing=None;record=None
 result=dict(version=1,state='untrusted',selectedVersion=MU_PROFILE_EXPECTED or MU_SELECTION_DEFAULT,recordedVersion=None,issue='unreadable')
 try:
  mu_profile_require(os.getuid()>0,'permissions')
  selected=mu_selected_version(MU_PROFILE_EXPECTED);result['selectedVersion']=selected
  flags=os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK
  parent=os.open('/',flags|os.O_DIRECTORY);handles.append(parent);mu_profile_directory(os.fstat(parent),0)
  for index,name in enumerate(['home','dev','.local','share','mucodesandbox','browser']):
   try:child=os.open(name,flags|os.O_DIRECTORY,dir_fd=parent)
   except FileNotFoundError:
    mu_profile_require(index>=2,'unreadable');missing=(parent,name);result.update(state='absent',issue=None);break
   handles.append(child);before=os.fstat(child);owner=0 if index==0 else os.getuid();mu_profile_directory(before,owner);parents.append((parent,name,child,before,owner));parent=child
  else:
   try:record=os.open('Last Version',flags,dir_fd=parent)
   except FileNotFoundError:missing=(parent,'Last Version');result.update(state='unrecorded',issue=None)
   if record is not None:
    handles.append(record);before=os.fstat(record);mu_profile_regular(before);raw=os.read(record,257)
    mu_profile_require(len(raw)==before.st_size,'changed')
    try:value=raw.decode('ascii').strip()
    except UnicodeError:raise MuProfileRefused('record')
    mu_profile_require(mu_profile_version(value),'record')
    after=os.fstat(record);named=os.stat('Last Version',dir_fd=parent,follow_symlinks=False);mu_profile_regular(after);mu_profile_regular(named)
    mu_profile_require(mu_profile_stamp(before)==mu_profile_stamp(after)==mu_profile_stamp(named),'changed')
    newer=tuple(map(int,value.split('.')))>tuple(map(int,selected.split('.')))
    result.update(state='newer' if newer else 'compatible',recordedVersion=value,issue=None)
  for owner_fd,name,handle,before,owner in parents:
   after=os.fstat(handle);named=os.stat(name,dir_fd=owner_fd,follow_symlinks=False);mu_profile_directory(after,owner);mu_profile_directory(named,owner)
   mu_profile_require((before.st_dev,before.st_ino)==(after.st_dev,after.st_ino)==(named.st_dev,named.st_ino),'changed')
  mu_profile_directory(os.fstat(handles[0]),0)
  if missing is not None:
   try:os.stat(missing[1],dir_fd=missing[0],follow_symlinks=False)
   except FileNotFoundError:pass
   else:raise MuProfileRefused('changed')
  mu_selected_version(selected)
 except (MuProfileRefused,MuSelectionRefused) as error:result.update(state='untrusted',recordedVersion=None,issue=error.issue)
 except OSError:result.update(state='untrusted',recordedVersion=None,issue='unreadable')
 finally:
  for handle in reversed(handles):os.close(handle)
 return result
def mu_profile_admit():
 result=mu_profile_inspect()
 if result['state'] in ['newer','untrusted']:raise RuntimeError('MU_BROWSER_PROFILE_'+result['state'].upper())
 return result
`;}
export const WINDOWS_BROWSER_PROFILE_HELPERS=windowsBrowserProfileHelpers();
export const WINDOWS_BROWSER_PROFILE_INSPECT=WINDOWS_BROWSER_PROFILE_HELPERS+'\nprint(json.dumps(mu_profile_inspect(),sort_keys=True))\n';
export const WINDOWS_BROWSER_PROFILE_ADMIT=WINDOWS_BROWSER_PROFILE_HELPERS+'\nmu_profile_admit()\n';
export function windowsBrowserProfileAdmit(version:string){return windowsBrowserProfileHelpers(version)+'\nmu_profile_admit()\n';}
const version=z.string().max(39).regex(/^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){3}$/);
const receipt=z.object({version:z.literal(1),state:z.enum(['absent','unrecorded','compatible','newer','untrusted']),selectedVersion:windowsBrowserApprovedVersion,recordedVersion:version.nullable(),issue:z.enum(['permissions','changed','record','unreadable','adoption-pending','repair-pending','selection-unavailable','selection-changed']).nullable()}).strict().refine(value=>{
 if(value.state==='untrusted')return value.issue!==null&&value.recordedVersion===null;
 if(value.issue!==null)return false;
 if(value.state==='absent'||value.state==='unrecorded')return value.recordedVersion===null;
 if(!value.recordedVersion)return false;
 const a=value.recordedVersion.split('.').map(Number),b=value.selectedVersion.split('.').map(Number);let comparison=0;for(let i=0;i<4;i++)if(a[i]!==b[i]){comparison=a[i]>b[i]?1:-1;break;}
 return value.state==='newer'?comparison>0:comparison<=0;
});
export function parseWindowsBrowserProfile(text:string):WindowsBrowserProfileStatus{
 let value:unknown;try{value=JSON.parse(text);}catch{throw new AppError('浏览器资料版本回执无法核对，资料保持原样',502,'BROWSER_PROFILE_RECEIPT');}
 const parsed=receipt.safeParse(value);if(!parsed.success)throw new AppError('浏览器资料版本回执无法核对，资料保持原样',502,'BROWSER_PROFILE_RECEIPT');return parsed.data;
}
export function assertWindowsBrowserProfile(value:WindowsBrowserProfileStatus){
 if(value.state==='newer')throw new AppError('现有浏览器资料来自更高版本，当前批准版不能降级打开；请保留资料，使用匹配版本的应用或新建空白环境',409,'BROWSER_PROFILE_NEWER');
 if(value.state==='untrusted')throw new AppError('浏览器资料版本或路径无法核验，资料保持原样，浏览器保持关闭',409,'BROWSER_PROFILE_UNTRUSTED');
}
