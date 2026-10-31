import {z} from 'zod';
import type {BrowserVersionStatus} from '../../../shared/types.ts';
import {AppError} from '../../errors.ts';
import {WINDOWS_CHROME} from './browser-assets.ts';
import {WINDOWS_BROWSER_RELEASES} from './browser-releases.ts';
import {WINDOWS_BROWSER_SELECTION_HELPERS,windowsBrowserApprovedVersion} from './browser-selection.ts';

// Read installed data only. Even a version query must not execute an unknown
// or damaged browser. No network, sudo, process launch, chmod or file writes.
export const WINDOWS_BROWSER_VERSION_SCRIPT=`import os,stat,json,hashlib,re
${WINDOWS_BROWSER_SELECTION_HELPERS}
RELEASES=${JSON.stringify(Object.fromEntries(WINDOWS_BROWSER_RELEASES.map(release=>[release.version,{version:release.version,sha256:release.sha256,...'binarySha256' in release?{binarySha256:release.binarySha256}:{}}])))}
class Refused(Exception):
 def __init__(self,code):self.code=code
def require(ok,code):
 if not ok:raise Refused(code)
def directory(info):require(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022,'unsafe')
def regular(info,maximum):require(stat.S_ISREG(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022 and info.st_nlink==1 and 0<info.st_size<=maximum,'unsafe')
def identity(info):return info.st_dev,info.st_ino
def stamp(info):return identity(info)+(info.st_size,info.st_mtime_ns,info.st_ctime_ns)
def object_pairs(pairs):
 result={}
 for key,value in pairs:
  require(key not in result,'record');result[key]=value
 return result
def version(value):return isinstance(value,str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,8})(?:\\.(?:0|[1-9][0-9]{0,8})){3}',value) is not None
handles=[];parents=[];recorded=None
result=dict(version=1,state='untrusted',issue='unreadable',recordedVersion=None,selectedVersion=MU_SELECTION_DEFAULT)
try:
 selected=mu_selected_version();result['selectedVersion']=selected;EXPECTED=RELEASES[selected];ROOT='/opt/mucodesandbox/windows/chrome-'+selected
 flags=os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW
 parent=os.open('/',flags|os.O_DIRECTORY);handles.append(parent);directory(os.fstat(parent))
 parts=ROOT.strip('/').split('/')
 for index,name in enumerate(parts):
  if index==len(parts)-1:
   try:os.stat('.browser-repair',dir_fd=parent,follow_symlinks=False)
   except FileNotFoundError:pass
   else:raise Refused('repair-pending')
  child=os.open(name,flags|os.O_DIRECTORY,dir_fd=parent);handles.append(child);before=os.fstat(child);directory(before);parents.append((parent,name,child,before));parent=child
 record=os.open('.mu-component.json',flags,dir_fd=parent);handles.append(record);record_before=os.fstat(record);regular(record_before,4096)
 with os.fdopen(record,'rb',closefd=False) as source:raw=source.read(4097)
 require(len(raw)<=4096,'record')
 try:values=json.loads(raw.decode('utf-8'),object_pairs_hook=object_pairs)
 except (ValueError,UnicodeError,RecursionError):raise Refused('record')
 require(isinstance(values,dict) and set(values)=={'archiveSha256','binarySha256','architecture','version'},'record')
 require(version(values['version']),'record');recorded=values['version']
 require(isinstance(values['binarySha256'],str) and re.fullmatch('[0-9a-f]{64}',values['binarySha256']) is not None and values['binarySha256']!='0'*64,'record')
 require(values['architecture']=='amd64' and values['archiveSha256']==EXPECTED['sha256'] and recorded==EXPECTED['version'],'unapproved')
 binary=os.open('chrome',flags,dir_fd=parent);handles.append(binary);binary_before=os.fstat(binary);regular(binary_before,1073741824);digest=hashlib.sha256();count=0
 with os.fdopen(binary,'rb',closefd=False) as source:
  while True:
   block=source.read(1048576)
   if not block:break
   count+=len(block);require(count<=binary_before.st_size,'changed');digest.update(block)
 require(count==binary_before.st_size,'changed')
 require(digest.hexdigest()==values['binarySha256'],'changed')
 require(EXPECTED.get('binarySha256',digest.hexdigest())==digest.hexdigest(),'changed')
 for name,handle,before,maximum in [('.mu-component.json',record,record_before,4096),('chrome',binary,binary_before,1073741824)]:
  after=os.fstat(handle);named=os.stat(name,dir_fd=parent,follow_symlinks=False);regular(after,maximum);regular(named,maximum);require(stamp(before)==stamp(after)==stamp(named),'changed')
 for owner,name,handle,before in parents:
  after=os.fstat(handle);named=os.stat(name,dir_fd=owner,follow_symlinks=False);directory(after);directory(named);require(identity(before)==identity(after)==identity(named),'changed')
 directory(os.fstat(handles[0]));mu_selected_version(selected);result.update(state='verified',issue=None)
except FileNotFoundError:result.update(state='missing',issue='missing')
except Refused as error:result.update(state='untrusted',issue=error.code)
except MuSelectionRefused as error:result.update(state='untrusted',issue='unsafe' if error.issue=='permissions' else error.issue)
except OSError:result.update(state='untrusted',issue='unreadable')
finally:
 for handle in reversed(handles):os.close(handle)
result['recordedVersion']=recorded
print(json.dumps(result,sort_keys=True))
`;

const versionSchema=z.string().max(39).regex(/^(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){3}$/);
const issueSchema=z.enum(['missing','unsafe','record','unapproved','changed','unreadable','repair-pending','adoption-pending','selection-unavailable','selection-changed']);
const installationSchema=z.object({version:z.literal(1),state:z.enum(['verified','missing','untrusted']),issue:issueSchema.nullable(),recordedVersion:versionSchema.nullable(),selectedVersion:windowsBrowserApprovedVersion.default(WINDOWS_CHROME.version)}).strict().refine(value=>value.state==='verified'?value.issue===null&&value.recordedVersion===value.selectedVersion:value.state==='missing'?value.issue==='missing':value.issue!==null&&value.issue!=='missing');
const messages:Record<z.infer<typeof issueSchema>,string>={
 'repair-pending':'浏览器组件恢复尚未完成，请保持浏览器关闭并核对操作记录；浏览器资料与项目文件保留。',
 'adoption-pending':'浏览器版本采用尚未完成，请保持浏览器关闭并核对恢复记录；浏览器资料与项目文件保留。',
 'selection-unavailable':'浏览器版本选择未通过批准清单核验，请保持浏览器关闭并保留原文件。',
 'selection-changed':'浏览器版本选择在读取期间变化，请保持浏览器关闭并重新核对。',
 missing:'浏览器组件或安装记录缺失，尚不能确认已安装版本；请保持浏览器关闭并检查组件。',
 unsafe:'浏览器安装路径、文件归属或权限未通过核验；原文件保持不变，请检查组件。',
 record:'浏览器安装记录无法核对；原文件保持不变，请检查组件。',
 unapproved:'浏览器安装记录与本应用批准的 AMD64 组件不一致；请勿使用未知版本。',
 changed:'浏览器文件内容或身份已变化，尚不能确认已安装版本；请保持浏览器关闭。',
 unreadable:'浏览器组件暂时无法读取核验；原文件保持不变，请检查组件和客体权限。',
};
export function parseWindowsBrowserVersion(source:string):BrowserVersionStatus{
 let value:unknown;try{value=JSON.parse(source);}catch{throw new AppError('无法核对 Linux 浏览器安装资料',502,'BROWSER_VERSION_UNREADABLE');}
 const parsed=installationSchema.safeParse(value);if(!parsed.success)throw new AppError('无法核对 Linux 浏览器安装资料',502,'BROWSER_VERSION_UNREADABLE');
 const state=parsed.data,verified=state.state==='verified';
 return {selectedVersion:state.selectedVersion,installedVersion:verified?state.selectedVersion:null,availableVersion:state.selectedVersion,installedChannel:verified?'stable':null,availableChannel:'stable',updateAvailable:false,recoveryRequired:!verified,installationState:state.state,recordedVersion:state.recordedVersion,...state.issue?{installationIssue:messages[state.issue]}:{}};
}
