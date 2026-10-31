import {z} from 'zod';
import {AppError} from '../../errors.ts';
import {WINDOWS_CHROME} from './browser-assets.ts';
import {WINDOWS_BROWSER_RELEASES,approvedWindowsBrowserRelease} from './browser-releases.ts';

export const windowsBrowserApprovedVersion=z.string().refine(value=>WINDOWS_BROWSER_RELEASES.some(release=>release.version===value));
// Only fixed root-controlled paths and application-approved recipes. This
// reader runs as dev too; it never opens the private adoption directory.
export const WINDOWS_BROWSER_SELECTION_HELPERS=String.raw`
import os,stat,json
MU_SELECTION_DEFAULT=${JSON.stringify(WINDOWS_CHROME.version)}
MU_SELECTION_RELEASES=${JSON.stringify(Object.fromEntries(WINDOWS_BROWSER_RELEASES.map(release=>[release.version,release.sha256])))}
class MuSelectionRefused(Exception):
 def __init__(self,issue):self.issue=issue
def mu_selection_require(ok,issue):
 if not ok:raise MuSelectionRefused(issue)
def mu_selection_directory(info):mu_selection_require(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022,'permissions')
def mu_selection_identity(info):return info.st_dev,info.st_ino
def mu_selection_stamp(info):return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
def mu_selection_pairs(items):
 value={}
 for key,item in items:
  if key in value:raise ValueError('Duplicate browser selection field')
  value[key]=item
 return value
def mu_selection_absent(parent,name):
 try:os.stat(name,dir_fd=parent,follow_symlinks=False)
 except FileNotFoundError:return True
 return False
def mu_selected_version(expected=None,allow_repair=False):
 handles=[];parents=[];missing=None;selected=MU_SELECTION_DEFAULT
 try:
  flags=os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK
  parent=os.open('/',flags|os.O_DIRECTORY);handles.append(parent);mu_selection_directory(os.fstat(parent))
  for name in ['opt','mucodesandbox','windows']:
   try:child=os.open(name,flags|os.O_DIRECTORY,dir_fd=parent)
   except FileNotFoundError:missing=(parent,name);break
   handles.append(child);before=os.fstat(child);mu_selection_directory(before);parents.append((parent,name,child,before));parent=child
  else:
   for name,issue in [('.browser-adoption','adoption-pending'),('.browser-repair','repair-pending')]:
    if name=='.browser-repair' and allow_repair:continue
    mu_selection_require(mu_selection_absent(parent,name),issue)
   try:record=os.open('browser-selection.json',flags,dir_fd=parent)
   except FileNotFoundError:missing=(parent,'browser-selection.json')
   else:
    handles.append(record);before=os.fstat(record)
    mu_selection_require(stat.S_ISREG(before.st_mode) and before.st_uid==0 and not before.st_mode&0o022 and before.st_nlink==1 and 0<before.st_size<=4096,'permissions')
    raw=os.read(record,4097);after=os.fstat(record);named=os.stat('browser-selection.json',dir_fd=parent,follow_symlinks=False)
    mu_selection_require(len(raw)==before.st_size and mu_selection_stamp(before)==mu_selection_stamp(after)==mu_selection_stamp(named),'changed')
    try:value=json.loads(raw.decode('utf-8'),object_pairs_hook=mu_selection_pairs)
    except (ValueError,UnicodeError,RecursionError):raise MuSelectionRefused('record')
    mu_selection_require(isinstance(value,dict) and set(value)=={'schema','version','archiveSha256'} and type(value['schema']) is int and value['schema']==1 and isinstance(value['version'],str) and value['version'] in MU_SELECTION_RELEASES and value['archiveSha256']==MU_SELECTION_RELEASES[value['version']],'selection-unavailable')
    selected=value['version']
   for name,issue in [('.browser-adoption','adoption-pending'),('.browser-repair','repair-pending')]:
    if name=='.browser-repair' and allow_repair:continue
    mu_selection_require(mu_selection_absent(parent,name),issue)
  for owner,name,handle,before in parents:
   after=os.fstat(handle);named=os.stat(name,dir_fd=owner,follow_symlinks=False);mu_selection_directory(after);mu_selection_directory(named)
   mu_selection_require(mu_selection_identity(before)==mu_selection_identity(after)==mu_selection_identity(named),'changed')
  mu_selection_directory(os.fstat(handles[0]))
  if missing is not None:mu_selection_require(mu_selection_absent(*missing),'changed')
  mu_selection_require(expected is None or selected==expected,'selection-changed')
  return selected
 finally:
  for handle in reversed(handles):os.close(handle)
`;

export function windowsBrowserSelectedVersion(version:string){return approvedWindowsBrowserRelease(version).version;}
export const WINDOWS_BROWSER_SELECTION_INSPECT=WINDOWS_BROWSER_SELECTION_HELPERS+'\nprint(json.dumps(dict(version=1,selectedVersion=mu_selected_version()),sort_keys=True))\n';
const selectionReceipt=z.object({version:z.literal(1),selectedVersion:windowsBrowserApprovedVersion}).strict();
export function parseWindowsBrowserSelection(source:string){
 let value:unknown;try{value=JSON.parse(source);}catch{throw new AppError('浏览器版本选择回执无法核对，请保持浏览器关闭',502,'BROWSER_SELECTION_RECEIPT');}
 const parsed=selectionReceipt.safeParse(value);if(!parsed.success)throw new AppError('浏览器版本选择回执无法核对，请保持浏览器关闭',502,'BROWSER_SELECTION_RECEIPT');return parsed.data.selectedVersion;
}
export function assertWindowsBrowserProduct(product:unknown,version:string){
 const approved=windowsBrowserSelectedVersion(version);
 if(product!=='Chrome/'+approved)throw new AppError('实际浏览器进程版本与所选批准版不一致，请保持浏览器关闭',409,'BROWSER_VERSION_MISMATCH');
}
