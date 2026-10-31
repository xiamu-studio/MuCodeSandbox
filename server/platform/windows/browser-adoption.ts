import {createHash} from 'node:crypto';
import {AppError} from '../../errors.ts';
import {LEASE_HELPER} from '../../guest-lease.ts';
import {WINDOWS_CHROME} from './browser-assets.ts';
import {WINDOWS_BROWSER_RELEASES,WINDOWS_BROWSER_CANDIDATE} from './browser-releases.ts';
import {WINDOWS_COMPONENT_PACKAGE_PYTHON} from './component-package.ts';
import {WINDOWS_BROWSER_RESET_HELPERS} from './browser-reset.ts';
import {WINDOWS_BROWSER_REPAIR_PYTHON} from './browser-repair.ts';
import {WINDOWS_BROWSER_PROFILE_WORKER} from './browser-profile-worker.ts';

export type WindowsBrowserAdoptionAction='status'|'begin'|'trial'|'commit'|'recover';
export const WINDOWS_BROWSER_ADOPTION_PYTHON=String.raw`
ADOPTION_SLOTS=8192
PROFILE_PARENT=pathlib.Path('/home/dev/.local/share/mucodesandbox')
SELECTOR=ROOT/'browser-selection.json'
ADOPTION=ROOT/'.browser-adoption'
def adoption_step(name):pass
def adoption_version(value):return isinstance(value,str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){3}',value) is not None
def adoption_pairs(items):
 result={}
 for key,value in items:
  if key in result:raise RuntimeError('Duplicate browser control field')
  result[key]=value
 return result
def adoption_json(raw):return json.loads(raw.decode('utf-8'),object_pairs_hook=adoption_pairs)
def adoption_read(path,limit=4096):
 identity=repair_object(path,'file');fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  before=os.fstat(fd)
  if repair_identity(before)!=identity or before.st_size<1 or before.st_size>limit:raise RuntimeError('Browser control file cannot be verified')
  raw=os.read(fd,limit+1);after=os.fstat(fd)
  if len(raw)!=before.st_size or (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns) or repair_object(path,'file')!=identity:raise RuntimeError('Browser control file changed')
  return raw,identity
 finally:os.close(fd)
def adoption_selector():
 repair_directory(ROOT)
 if not repair_present(SELECTOR):return BASE,None,None
 raw,identity=adoption_read(SELECTOR);value=adoption_json(raw)
 if not isinstance(value,dict) or set(value)!={'schema','version','archiveSha256'} or type(value['schema']) is not int or value['schema']!=1 or value['version'] not in RELEASES or value['archiveSha256']!=RELEASES[value['version']]['sha256']:raise RuntimeError('Browser selection is unapproved')
 return value['version'],identity,raw.decode('utf-8')
def adoption_profile(path):
 info=path.lstat()
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=ACCOUNT.pw_uid or info.st_mode&0o022:raise RuntimeError('Browser profile directory cannot be verified')
 return repair_identity(info)
def adoption_parent():
 current=pathlib.Path('/')
 for index,part in enumerate(PROFILE_PARENT.parts[1:]):
  current=current/part;info=current.lstat();owner=0 if index==0 else ACCOUNT.pw_uid
  if not stat.S_ISDIR(info.st_mode) or info.st_uid!=owner or info.st_mode&0o022:raise RuntimeError('Browser profile parent cannot be verified')
 return adoption_profile(PROFILE_PARENT)
def adoption_component(version):
 release=RELEASES[version];directory=ROOT/('chrome-'+version);root_id=repair_directory(directory)
 raw,record_id=adoption_read(directory/'.mu-component.json');record=adoption_json(raw)
 if not isinstance(record,dict) or set(record)!={'archiveSha256','binarySha256','architecture','version'} or record['architecture']!='amd64' or record['version']!=version or record['archiveSha256']!=release['sha256'] or not isinstance(record['binarySha256'],str) or not re.fullmatch('[a-f0-9]{64}',record['binarySha256']):raise RuntimeError('Browser component record cannot be verified')
 result=dict(directory=root_id,record=record_id,recordSha256=hashlib.sha256(raw).hexdigest())
 for name,field in [('chrome','binarySha256'),('chrome-sandbox','sandboxSha256')]:
  file=directory/name;identity=repair_object(file,'file');digest=component_digest(file)
  if repair_object(file,'file')!=identity or stat.S_IMODE(file.lstat().st_mode)!=(0o755 if name=='chrome' else 0o4755):raise RuntimeError('Browser executable changed')
  expected=release.get(field,record['binarySha256'] if name=='chrome' else digest)
  if digest!=expected:raise RuntimeError('Browser executable is not approved')
  result[name]=dict(identity=identity,sha256=digest)
 return result
def adoption_candidate():
 expected=adoption_component(CANDIDATE);found=[]
 for count,folder in enumerate(ROOT.iterdir()):
  if count>=256:raise RuntimeError('Browser component inventory exceeds its bound')
  if not re.fullmatch(re.escape(REPAIR_LABEL)+r'-done-[a-f0-9]{32}',folder.name):continue
  _,record=repair_record(folder)
  if record['candidate']!=expected['directory']:continue
  if record['phase']!='published' or record['old'] is not None:raise RuntimeError('Candidate publication is incomplete')
  repair_object(folder/'archive.deb','file',record['archive']);verify_windows_component(folder/'archive.deb',ROOT/('chrome-'+CANDIDATE),EXPECTED,'chrome');found.append(folder.name)
 if len(found)!=1:raise RuntimeError('Candidate preparation cannot be uniquely verified')
 return expected
def adoption_lease(expected=None):
 repair_directory(pathlib.Path('/run/mucodesandbox-lease'),private=True);repair_directory(pathlib.Path('/usr/local/libexec'))
 raw,_=adoption_read(pathlib.Path('/run/mucodesandbox-lease/state'));value=adoption_json(raw)
 if not isinstance(value,dict) or set(value)!={'session','boot','state','deadline'} or value['state']!='active' or not all(isinstance(value[k],str) and re.fullmatch('[a-f0-9-]{36}',value[k]) for k in ['session','boot']):raise RuntimeError('Browser adoption network permission is unavailable')
 binding=dict(session=value['session'],boot=value['boot'])
 if expected is not None and binding!=expected:raise RuntimeError('Browser adoption network session changed')
 helper=pathlib.Path('/usr/local/libexec/mu-network-lease');repair_object(helper,'file')
 if component_digest(helper)!=LEASE_HELPER_SHA:raise RuntimeError('Browser adoption network helper changed')
 status=adoption_json(subprocess.check_output([str(helper),'status'],timeout=10))
 if not isinstance(status,dict) or set(status)!={'active','remainingMs'} or status['active'] is not True or type(status['remainingMs']) is not int or not 5000<=status['remainingMs']<=45000:raise RuntimeError('Browser adoption network permission expired')
 after,_=adoption_read(pathlib.Path('/run/mucodesandbox-lease/state'));after=adoption_json(after)
 if any(after.get(k)!=binding[k] for k in binding) or after.get('state')!='active':raise RuntimeError('Browser adoption network session changed')
 return binding
def adoption_write(folder,sequence,data):
 repair_object(folder/'journal.bin','file',data['journal']);fd=os.open(folder/'journal.bin',os.O_RDWR|os.O_NOFOLLOW)
 try:
  if repair_identity(os.fstat(fd))!=data['journal']:raise RuntimeError('Browser adoption journal changed')
  raw=repair_frame(data,sequence);os.lseek(fd,((sequence-1)%2)*ADOPTION_SLOTS,os.SEEK_SET);repair_write_all(fd,raw[:64]);adoption_step('journal-half-written');repair_write_all(fd,raw[64:]);os.fsync(fd)
 finally:os.close(fd)
 adoption_step('journal-durable')
def adoption_load(folder=ADOPTION):
 repair_directory(folder,private=True);journal=folder/'journal.bin';identity=repair_object(journal,'file');fd=os.open(journal,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  if repair_identity(os.fstat(fd))!=identity or os.fstat(fd).st_size!=ADOPTION_SLOTS*2:raise RuntimeError('Browser adoption journal changed')
  raw=os.read(fd,ADOPTION_SLOTS*2)
 finally:os.close(fd)
 rows=[row for row in [repair_decode(raw[:ADOPTION_SLOTS]),repair_decode(raw[ADOPTION_SLOTS:])] if row is not None]
 if not rows:raise RuntimeError('Browser adoption journal has no complete frame')
 rows.sort(key=lambda row:row[0]);mutable={'phase','checkpointSha256','checkpointBytes','checkpointVersion','restoreReady'}
 if len(rows)==2 and (rows[1][0]!=rows[0][0]+1 or {k:v for k,v in rows[0][1].items() if k not in mutable}!={k:v for k,v in rows[1][1].items() if k not in mutable}):raise RuntimeError('Browser adoption frames disagree')
 sequence,data=rows[-1];fields={'schema','epoch','root','slot','journal','archive','reserve','restore','selectionNext','parent','profile','prior','candidate','priorSelectionId','priorSelectionRaw','priorComponent','candidateComponent','lease','phase','checkpointSha256','checkpointBytes','checkpointVersion','restoreReady'}
 if not isinstance(data,dict) or set(data)!=fields or type(data['schema']) is not int or data['schema']!=1 or not isinstance(data['epoch'],str) or not re.fullmatch('[a-f0-9]{32}',data['epoch']) or data['prior'] not in RELEASES or data['candidate']!=CANDIDATE or data['prior']==CANDIDATE or data['phase'] not in ['checkpointing','ready','trial','restoring','committed','restored','aborted'] or type(data['restoreReady']) is not bool:raise RuntimeError('Browser adoption record is invalid')
 for key in ['root','slot','journal','archive','reserve','restore','selectionNext','parent','profile']:
  if not isinstance(data[key],list) or len(data[key])!=2 or any(not isinstance(v,str) or not re.fullmatch('[0-9]{1,40}',v) for v in data[key]):raise RuntimeError('Browser adoption identity is invalid')
 if data['priorSelectionId'] is not None and (not isinstance(data['priorSelectionId'],list) or len(data['priorSelectionId'])!=2 or any(not isinstance(v,str) or not re.fullmatch('[0-9]{1,40}',v) for v in data['priorSelectionId'])):raise RuntimeError('Prior selection identity is invalid')
 if not isinstance(data['lease'],dict) or set(data['lease'])!={'session','boot'} or any(not isinstance(v,str) or not re.fullmatch('[a-f0-9-]{36}',v) for v in data['lease'].values()):raise RuntimeError('Browser network binding is invalid')
 if len(rows)==2:
  old=rows[0][1];allowed={'checkpointing':['ready','aborted'],'ready':['trial','aborted'],'trial':['committed','restoring'],'restoring':['restoring','restored'],'aborted':['aborted']}
  if data['phase'] not in allowed.get(old.get('phase'),[]) or old.get('restoreReady') is True and data['restoreReady'] is not True or old.get('phase')!='checkpointing' and any(old.get(k)!=data[k] for k in ['checkpointSha256','checkpointBytes','checkpointVersion']):raise RuntimeError('Browser adoption transition is invalid')
 if (data['priorSelectionId'] is None)!=(data['priorSelectionRaw'] is None) or data['priorSelectionRaw'] is not None and (not isinstance(data['priorSelectionRaw'],str) or len(data['priorSelectionRaw'].encode())>4096):raise RuntimeError('Prior browser selection is invalid')
 if type(data['checkpointBytes']) is not int or not 0<=data['checkpointBytes']<=1099515822080:raise RuntimeError('Browser checkpoint bound is invalid')
 if data['phase'] not in ['checkpointing','aborted'] and (not isinstance(data['checkpointSha256'],str) or not re.fullmatch('[a-f0-9]{64}',data['checkpointSha256']) or not adoption_version(data['checkpointVersion']) or data['checkpointBytes']<1024):raise RuntimeError('Browser checkpoint is incomplete')
 if data['root']!=repair_directory(ROOT) or data['slot']!=repair_directory(folder,private=True) or data['journal']!=identity or data['parent']!=adoption_parent():raise RuntimeError('Browser adoption authority changed')
 return sequence,data
def adoption_inventory(folder):
 if {entry.name for entry in folder.iterdir()}-{'journal.bin','profile.tar','reserve.bin','restore','selection-next','selection-prior','failed-profile','trial-stop'}:raise RuntimeError('Unknown browser adoption files preserved')
def adoption_file(folder,name,data,key):return repair_object(folder/name,'file',data[key])
def adoption_worker(kind,directory,archive,data):
 fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);process=None
 try:
  expected=data['profile'] if kind in ['capture','version'] else data['restore']
  if repair_identity(os.fstat(fd))!=expected or adoption_profile(directory)!=expected:raise RuntimeError('Profile worker directory changed')
  process=subprocess.Popen(['/usr/bin/python3','-I','-c',PROFILE_WORKER,kind,str(fd),str(os.getpid())],user=ACCOUNT.pw_uid,group=ACCOUNT.pw_gid,extra_groups=[],pass_fds=(fd,),env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','HOME':'/home/dev'},stdin=subprocess.DEVNULL if kind in ['capture','version'] else archive,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
  output=bytearray();digest=hashlib.sha256();size=0;deadline=time.monotonic()+1800
  while True:
   remaining=deadline-time.monotonic()
   if remaining<=0:raise RuntimeError('Profile worker timed out')
   if not select.select([process.stdout],[],[],min(1,remaining))[0]:continue
   block=os.read(process.stdout.fileno(),1048576)
   if not block:break
   size+=len(block)
   if size>(1099515822080 if kind=='capture' else 4096):raise RuntimeError('Profile worker output exceeds its bound')
   if kind=='capture':repair_write_all(archive.fileno(),block);digest.update(block)
   else:output.extend(block)
  if process.wait(timeout=max(1,deadline-time.monotonic()))!=0:raise RuntimeError('Profile worker could not verify all data')
  return dict(bytes=size,sha256=digest.hexdigest()) if kind=='capture' else adoption_json(bytes(output))
 finally:
  if process is not None:
   if process.poll() is None:process.kill();process.wait()
   process.stdout.close()
  os.close(fd)
def adoption_checkpoint(folder,data):
 adoption_file(folder,'profile.tar',data,'archive');fd=os.open(folder/'profile.tar',os.O_RDWR|os.O_NOFOLLOW)
 try:
  if repair_identity(os.fstat(fd))!=data['archive'] or os.fstat(fd).st_size!=0:raise RuntimeError('Browser checkpoint file is not new')
  with os.fdopen(fd,'r+b',closefd=False) as output:result=adoption_worker('capture',PROFILE_PARENT/'browser',output,data);output.flush();os.fsync(fd)
 finally:os.close(fd)
 if adoption_profile(PROFILE_PARENT/'browser')!=data['profile']:raise RuntimeError('Original browser profile changed')
 version=None
 with tarfile.open(folder/'profile.tar','r:') as archive:
  for item in archive:
   if pathlib.PurePosixPath(item.name).parts!=('Last Version',):continue
   if version is not None or not item.isfile() or not 0<item.size<=256:raise RuntimeError('Browser checkpoint version is invalid')
   version=archive.extractfile(item).read(257).decode('ascii').strip()
 if not adoption_version(version) or tuple(map(int,version.split('.')))>tuple(map(int,data['prior'].split('.'))):raise RuntimeError('Compatible previous browser profile cannot be established')
 reserve=os.open(folder/'reserve.bin',os.O_RDWR|os.O_NOFOLLOW)
 try:
  if repair_identity(os.fstat(reserve))!=data['reserve']:raise RuntimeError('Browser rollback reserve changed')
  os.posix_fallocate(reserve,0,result['bytes']+67108864);os.fsync(reserve)
 finally:os.close(reserve)
 return result,version
def adoption_begin():
 if repair_present(ADOPTION):raise RuntimeError('A browser adoption already needs recovery')
 retained=0
 for count,entry in enumerate(ROOT.iterdir()):
  if count>=256:raise RuntimeError('Browser adoption history exceeds its bound')
  if re.fullmatch(r'\.browser-adoption-prep-[a-f0-9]{32}',entry.name):retained+=1
  elif re.fullmatch(r'\.browser-adoption-done-[a-f0-9]{32}',entry.name):
   try:
    repair_directory(entry,private=True)
    if {p.name for p in entry.iterdir()}!={'journal.bin'}:retained+=1
   except Exception:retained+=1
 if retained>=2:raise RuntimeError('Retained browser adoption data needs review before another checkpoint')
 prior,selection_id,selection_raw=adoption_selector()
 if prior==CANDIDATE:raise RuntimeError('Browser is already selected')
 if tuple(map(int,prior.split('.')))>=tuple(map(int,CANDIDATE.split('.'))):raise RuntimeError('In-place browser downgrade is forbidden')
 previous=adoption_component(prior);candidate=adoption_candidate();lease=adoption_lease();windows_stop_browser();parent=adoption_parent();profile=adoption_profile(PROFILE_PARENT/'browser')
 if parent[0]!=profile[0] or profile[0]!=repair_directory(ROOT)[0]:raise RuntimeError('Browser profile adoption requires one filesystem for exclusive publication')
 epoch=uuid.uuid4().hex;folder=ROOT/('.browser-adoption-prep-'+epoch);folder.mkdir(mode=0o700);repair_sync(ROOT)
 restore=folder/'restore';restore.mkdir(mode=0o700);os.chown(restore,ACCOUNT.pw_uid,ACCOUNT.pw_gid)
 for name,size in [('profile.tar',0),('reserve.bin',0),('selection-next',0),('journal.bin',ADOPTION_SLOTS*2)]:
  fd=os.open(folder/name,os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_NOFOLLOW,0o600)
  try:os.ftruncate(fd,size);os.fsync(fd)
  finally:os.close(fd)
 data=dict(schema=1,epoch=epoch,root=repair_directory(ROOT),slot=repair_directory(folder,private=True),journal=repair_object(folder/'journal.bin','file'),archive=repair_object(folder/'profile.tar','file'),reserve=repair_object(folder/'reserve.bin','file'),restore=adoption_profile(restore),selectionNext=repair_object(folder/'selection-next','file'),parent=parent,profile=profile,prior=prior,candidate=CANDIDATE,priorSelectionId=selection_id,priorSelectionRaw=selection_raw,priorComponent=previous,candidateComponent=candidate,lease=lease,phase='checkpointing',checkpointSha256=None,checkpointBytes=0,checkpointVersion=None,restoreReady=False)
 adoption_write(folder,1,data);repair_sync(folder);adoption_step('initialization-durable');repair_rename(folder,ADOPTION);adoption_step('active-published')
 result,version=adoption_checkpoint(ADOPTION,data);data.update(phase='ready',checkpointSha256=result['sha256'],checkpointBytes=result['bytes'],checkpointVersion=version);adoption_write(ADOPTION,2,data);adoption_step('checkpoint-ready');return adoption_result(data,'ready',False)
def adoption_prior_selection(data):
 version,identity,raw=adoption_selector()
 if (version,identity,raw)!=(data['prior'],data['priorSelectionId'],data['priorSelectionRaw']):raise RuntimeError('Original browser selection changed')
def adoption_archive(folder,data):
 adoption_file(folder,'profile.tar',data,'archive')
 if (folder/'profile.tar').lstat().st_size!=data['checkpointBytes'] or component_digest(folder/'profile.tar')!=data['checkpointSha256']:raise RuntimeError('Original browser checkpoint changed')
def adoption_trial(epoch):
 sequence,data=adoption_load();adoption_inventory(ADOPTION)
 if data['epoch']!=epoch or data['phase']!='ready':raise RuntimeError('Browser trial is not bound to this checkpoint')
 adoption_prior_selection(data);adoption_archive(ADOPTION,data)
 if adoption_profile(PROFILE_PARENT/'browser')!=data['profile'] or adoption_component(data['prior'])!=data['priorComponent'] or adoption_candidate()!=data['candidateComponent']:raise RuntimeError('Browser trial authority changed')
 adoption_file(ADOPTION,'reserve.bin',data,'reserve')
 if (ADOPTION/'reserve.bin').lstat().st_size!=data['checkpointBytes']+67108864:raise RuntimeError('Browser rollback capacity reserve changed')
 adoption_lease(data['lease']);data['phase']='trial';adoption_write(ADOPTION,sequence+1,data);adoption_step('trial-durable');return adoption_result(data,'trial',False)
def adoption_move(source,name,destination,target,identity):
 before=os.stat(name,dir_fd=source,follow_symlinks=False)
 if repair_identity(before)!=identity:raise RuntimeError('Browser publication source changed')
 libc=ctypes.CDLL(None,use_errno=True)
 if not hasattr(libc,'renameat2') or libc.renameat2(source,os.fsencode(name),destination,os.fsencode(target),1)!=0:raise RuntimeError('Exclusive browser publication could not complete')
 if repair_identity(os.stat(target,dir_fd=destination,follow_symlinks=False))!=identity:raise RuntimeError('Browser publication identity changed')
 os.fsync(source);os.fsync(destination)
def adoption_publish_selection(data):
 slot=os.open(ADOPTION,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);root=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  if repair_identity(os.fstat(slot))!=data['slot'] or repair_identity(os.fstat(root))!=data['root']:raise RuntimeError('Browser publication parents changed')
  if repair_present(SELECTOR) and repair_object(SELECTOR,'file')==data['selectionNext']:
   selected,_,_=adoption_selector()
   if selected!=CANDIDATE:raise RuntimeError('Committed browser selection changed')
   return
  if repair_present(SELECTOR):
   adoption_prior_selection(data);adoption_move(root,SELECTOR.name,slot,'selection-prior',data['priorSelectionId']);adoption_step('prior-selection-retained')
  elif data['priorSelectionId'] is not None:
   raw,identity=adoption_read(ADOPTION/'selection-prior')
   if identity!=data['priorSelectionId'] or raw.decode()!=data['priorSelectionRaw']:raise RuntimeError('Prior browser selection was lost')
  raw,identity=adoption_read(ADOPTION/'selection-next');value=adoption_json(raw)
  if identity!=data['selectionNext'] or value!={'schema':1,'version':CANDIDATE,'archiveSha256':RELEASES[CANDIDATE]['sha256']}:raise RuntimeError('Next browser selection changed')
  descriptor=os.open(ADOPTION/'selection-next',os.O_RDONLY|os.O_NOFOLLOW)
  try:os.fchmod(descriptor,0o644)
  finally:os.close(descriptor)
  adoption_move(slot,'selection-next',root,SELECTOR.name,data['selectionNext']);adoption_step('selection-published')
 finally:os.close(slot);os.close(root)
def adoption_commit(epoch,require_profile_version=False):
 sequence,data=adoption_load();adoption_inventory(ADOPTION)
 if data['epoch']!=epoch or data['phase']!='trial':raise RuntimeError('Browser acceptance is not bound to this trial')
 adoption_prior_selection(data);adoption_archive(ADOPTION,data)
 if adoption_profile(PROFILE_PARENT/'browser')!=data['profile'] or adoption_candidate()!=data['candidateComponent']:raise RuntimeError('Accepted browser candidate changed')
 adoption_file(ADOPTION,'selection-next',data,'selectionNext');fd=os.open(ADOPTION/'selection-next',os.O_RDWR|os.O_NOFOLLOW)
 try:
  if repair_identity(os.fstat(fd))!=data['selectionNext']:raise RuntimeError('Browser selection producer changed')
  raw=json.dumps(dict(schema=1,version=CANDIDATE,archiveSha256=RELEASES[CANDIDATE]['sha256']),sort_keys=True).encode();os.ftruncate(fd,0);repair_write_all(fd,raw);os.fsync(fd)
 finally:os.close(fd)
 if require_profile_version and adoption_worker('version',PROFILE_PARENT/'browser',None,data)!={'version':CANDIDATE}:raise RuntimeError('Accepted candidate did not retain its own profile version')
 adoption_lease(data['lease']);data['phase']='committed';adoption_write(ADOPTION,sequence+1,data);adoption_step('commit-durable');adoption_publish_selection(data);return adoption_finish(data,'committed')
def adoption_restore(data):
 adoption_archive(ADOPTION,data)
 if adoption_component(data['prior'])!=data['priorComponent']:raise RuntimeError('Previous browser cannot be restored')
 adoption_file(ADOPTION,'reserve.bin',data,'reserve');fd=os.open(ADOPTION/'reserve.bin',os.O_RDWR|os.O_NOFOLLOW)
 try:os.ftruncate(fd,0);os.fsync(fd)
 finally:os.close(fd)
 profile=PROFILE_PARENT/'browser';restored=repair_present(profile) and adoption_profile(profile)==data['restore']
 if restored:
  if not data['restoreReady']:raise RuntimeError('Unrecorded restored browser profile')
  with (ADOPTION/'profile.tar').open('rb') as archive:adoption_worker('verify',profile,archive,data)
  return
 if adoption_profile(ADOPTION/'restore')!=data['restore']:raise RuntimeError('Browser restore directory changed')
 with (ADOPTION/'profile.tar').open('rb') as archive:adoption_worker('restore',ADOPTION/'restore',archive,data)
 with (ADOPTION/'profile.tar').open('rb') as archive:adoption_worker('verify',ADOPTION/'restore',archive,data)
 sequence,current=adoption_load();current['restoreReady']=True;adoption_write(ADOPTION,sequence+1,current);data.update(current);adoption_step('restore-ready')
 parent=os.open(PROFILE_PARENT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);slot=os.open(ADOPTION,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  if repair_identity(os.fstat(parent))!=data['parent']:raise RuntimeError('Browser profile parent changed')
  if repair_present(profile):
   if adoption_profile(profile)!=data['profile'] or repair_present(ADOPTION/'failed-profile'):raise RuntimeError('Original profile destination changed')
   adoption_move(parent,'browser',slot,'failed-profile',data['profile']);adoption_step('failed-profile-retained')
  elif adoption_profile(ADOPTION/'failed-profile')!=data['profile']:raise RuntimeError('Original browser profile was lost')
  adoption_move(slot,'restore',parent,'browser',data['restore']);adoption_step('restored-profile-published')
 finally:os.close(parent);os.close(slot)
def adoption_cleanup(folder,data):
 try:
  adoption_inventory(folder)
  if repair_present(folder/'trial-stop'):
   identity=adoption_check_stop(data,folder);repair_object(folder/'trial-stop','file',identity);(folder/'trial-stop').unlink();repair_sync(folder)
  if repair_present(folder/'profile.tar'):
   adoption_file(folder,'profile.tar',data,'archive')
   if data['checkpointSha256'] is not None:adoption_archive(folder,data)
   (folder/'profile.tar').unlink();repair_sync(folder);adoption_step('checkpoint-removed')
  for name,key in [('reserve.bin','reserve'),('selection-next','selectionNext')]:
   if repair_present(folder/name):adoption_file(folder,name,data,key);(folder/name).unlink();repair_sync(folder)
  if repair_present(folder/'selection-prior'):
   raw,identity=adoption_read(folder/'selection-prior')
   if identity!=data['priorSelectionId'] or raw.decode()!=data['priorSelectionRaw']:raise RuntimeError('Retained selection changed')
   (folder/'selection-prior').unlink();repair_sync(folder)
  if repair_present(folder/'restore'):
   if adoption_profile(folder/'restore')!=data['restore'] or any((folder/'restore').iterdir()):return True
   (folder/'restore').rmdir();repair_sync(folder)
  return repair_present(folder/'failed-profile')
 except Exception:return True
def adoption_finish(data,state):
 done=ROOT/('.browser-adoption-done-'+data['epoch']);repair_rename(ADOPTION,done);adoption_step('receipt-published');warning=adoption_cleanup(done,data);return adoption_result(data,state,warning)
def adoption_result(data,state,warning):return dict(version=1,state=state,epoch=data['epoch'],priorVersion=data['prior'],candidateVersion=data['candidate'],selectedVersion=adoption_selector()[0],cleanupWarning=warning)
def adoption_binding(data):
 return hashlib.sha256(json.dumps({key:value for key,value in data.items() if key not in ['phase','restoreReady']},sort_keys=True,separators=(',',':')).encode()).hexdigest()

def adoption_stop_bytes(data):return json.dumps(dict(version=1,epoch=data['epoch'],binding=adoption_binding(data)),sort_keys=True,separators=(',',':')).encode()

def adoption_check_stop(data,folder=ADOPTION):
 raw,identity=adoption_read(folder/'trial-stop')
 if raw!=adoption_stop_bytes(data):raise RuntimeError('Candidate stop fence belongs to another checkpoint')
 return identity

def adoption_stop_fence(data):
 path=ADOPTION/'trial-stop'
 try:fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 except FileExistsError:adoption_check_stop(data);return
 try:
  raw=adoption_stop_bytes(data);half=len(raw)//2;repair_write_all(fd,raw[:half]);adoption_step('trial-stop-prefix');repair_write_all(fd,raw[half:]);os.fsync(fd)
 finally:os.close(fd)
 repair_sync(ADOPTION);adoption_step('trial-stop-durable')

def adoption_require_trial(epoch,full=False,for_launch=False):
 _,data=adoption_load();adoption_inventory(ADOPTION)
 if data['epoch']!=epoch or data['phase']!='trial' or data['restoreReady']:raise RuntimeError('Candidate trial no longer owns this browser checkpoint')
 if for_launch and repair_present(ADOPTION/'trial-stop'):raise RuntimeError('Candidate trial launch has been durably revoked; recover its checkpoint first')
 adoption_prior_selection(data)
 if adoption_profile(PROFILE_PARENT/'browser')!=data['profile']:raise RuntimeError('Candidate trial profile changed')
 if full:
  adoption_archive(ADOPTION,data)
  if adoption_candidate()!=data['candidateComponent']:raise RuntimeError('Candidate trial component changed')
 adoption_lease(data['lease']);return data
def adoption_trial_receipt(epoch,full=False):
 data=adoption_require_trial(epoch,full)
 return dict(version=1,epoch=data['epoch'],priorVersion=data['prior'],candidateVersion=data['candidate'],binding=adoption_binding(data),lease=data['lease'])
def adoption_commit_bound(epoch,binding):
 if not isinstance(binding,str) or not re.fullmatch('[a-f0-9]{64}',binding) or adoption_trial_receipt(epoch)['binding']!=binding:raise RuntimeError('Candidate acceptance belongs to another checkpoint')
 _,data=adoption_load();adoption_check_stop(data)
 windows_stop_browser();subprocess.run(['/usr/bin/sync'],check=True,timeout=30,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 return adoption_commit(epoch,True)
def adoption_recover(epoch=None):
 if not repair_present(ADOPTION):
  if epoch is not None and repair_present(ROOT/('.browser-adoption-done-'+epoch)):
   folder=ROOT/('.browser-adoption-done-'+epoch);_,data=adoption_load(folder)
   if data['phase'] not in ['committed','restored','aborted'] or data['epoch']!=epoch:raise RuntimeError('Browser cleanup record is incomplete')
   result=adoption_result(data,'cleanup',adoption_cleanup(folder,data));result['decision']=data['phase'];return result
  return adoption_status()
 sequence,data=adoption_load()
 if epoch is not None and epoch!=data['epoch']:raise RuntimeError('Another browser adoption is active')
 if data['phase']=='committed':
  if adoption_candidate()!=data['candidateComponent'] or adoption_profile(PROFILE_PARENT/'browser')!=data['profile']:raise RuntimeError('Committed candidate changed')
  adoption_publish_selection(data);return adoption_finish(data,'committed')
 adoption_inventory(ADOPTION)
 windows_stop_browser();adoption_prior_selection(data)
 if data['phase'] in ['checkpointing','ready','aborted']:
  if adoption_profile(PROFILE_PARENT/'browser')!=data['profile']:raise RuntimeError('Original browser profile changed')
  data['phase']='aborted';adoption_write(ADOPTION,sequence+1,data);return adoption_finish(data,'aborted')
 if data['phase'] in ['trial','restoring']:
  data['phase']='restoring';adoption_write(ADOPTION,sequence+1,data);adoption_restore(data);sequence,data=adoption_load();data['phase']='restored';adoption_write(ADOPTION,sequence+1,data);adoption_step('restore-durable')
 if data['phase']=='restored':
  if adoption_profile(PROFILE_PARENT/'browser')!=data['restore'] or adoption_profile(ADOPTION/'failed-profile')!=data['profile']:raise RuntimeError('Restored browser identities changed')
  return adoption_finish(data,'restored')
 raise RuntimeError('Browser adoption cannot be recovered')
def adoption_status():
 selected=adoption_selector()[0];pending=None;retained=[];truncated=False
 if repair_present(ADOPTION):
  _,data=adoption_load();pending=dict(epoch=data['epoch'],phase=data['phase'],priorVersion=data['prior'],candidateVersion=data['candidate'])
 for count,folder in enumerate(ROOT.iterdir()):
  if count>=256:raise RuntimeError('Browser adoption history exceeds its bound')
  match=re.fullmatch(r'\.browser-adoption-(prep|done)-([a-f0-9]{32})',folder.name)
  if not match:continue
  try:
   _,data=adoption_load(folder);names={p.name for p in folder.iterdir()}
   if match[1]=='done' and names=={'journal.bin'}:continue
   issue=dict(epoch=match[2],trusted=True,privateDataMayRemain=bool(names&{'profile.tar','failed-profile','restore'} or names-{'journal.bin','reserve.bin','selection-next','selection-prior'}))
  except Exception:issue=dict(epoch=match[2],trusted=False,privateDataMayRemain=True)
  if len(retained)<32:retained.append(issue)
  else:truncated=True
 return dict(version=1,state='idle' if pending is None else 'pending',selectedVersion=selected,pending=pending,retained=retained,truncated=truncated)
`;

export function windowsBrowserAdoptionProgram(action:WindowsBrowserAdoptionAction,epoch?:string,binding?:string){
 if(!['status','begin','trial','commit','recover'].includes(action))throw new AppError('浏览器资料事务操作无效',400,'BROWSER_ADOPTION_ACTION');
 if(epoch!==undefined&&(typeof epoch!=='string'||!/^[a-f0-9]{32}$/.test(epoch)||['status','begin'].includes(action))||['trial','commit'].includes(action)&&!epoch)throw new AppError('浏览器资料事务身份无效',400,'BROWSER_ADOPTION_ID');
 if(action==='commit'?(typeof binding!=='string'||!/^[a-f0-9]{64}$/.test(binding)):binding!==undefined)throw new AppError('浏览器候选验收身份无效',400,'BROWSER_ADOPTION_ACCEPTANCE');
 const operation=action==='begin'?'adoption_begin()':action==='status'?'adoption_status()':action==='trial'?`adoption_trial(${JSON.stringify(epoch)})`:action==='commit'?`adoption_commit_bound(${JSON.stringify(epoch)},${JSON.stringify(binding)})`:`adoption_recover(${epoch?JSON.stringify(epoch):'None'})`;
 return windowsBrowserAdoptionPrelude()+`${action==='status'?`print(json.dumps(${operation}))`:`with repair_lock():
 if repair_present(ROOT/'.browser-repair'):raise RuntimeError('Current component repair needs recovery first')
 print(json.dumps(${operation}))`}
`;
}
export function windowsBrowserAdoptionPrelude(){return `import os,sys,pathlib,hashlib,subprocess,tarfile,shutil,stat,json,struct,re,uuid,contextlib,fcntl,ctypes,pwd,select,time
os.umask(0o077)
ROOT=pathlib.Path('/opt/mucodesandbox/windows')
STATE=pathlib.Path('/var/lib/mucodesandbox')
BASE=${JSON.stringify(WINDOWS_CHROME.version)}
CANDIDATE=${JSON.stringify(WINDOWS_BROWSER_CANDIDATE.version)}
RELEASES=${JSON.stringify(Object.fromEntries(WINDOWS_BROWSER_RELEASES.map(r=>[r.version,r])))}
EXPECTED=RELEASES[CANDIDATE]
TARGET=ROOT/('chrome-'+CANDIDATE)
REPAIR_LABEL='.browser-candidate-'+CANDIDATE
REPAIR_RETAINED=REPAIR_LABEL+'-retained'
REPAIR_NEW_ONLY=True
REPAIR_KEEP_ARCHIVE=True
REPAIR_STOP_BROWSER=False
REPAIR_ADOPTION_OWNER=True
LEASE_HELPER_SHA=${JSON.stringify(createHash('sha256').update(LEASE_HELPER).digest('hex'))}
PROFILE_WORKER=${JSON.stringify(WINDOWS_BROWSER_PROFILE_WORKER)}
ACCOUNT=pwd.getpwnam('dev')
${WINDOWS_COMPONENT_PACKAGE_PYTHON}
${WINDOWS_BROWSER_RESET_HELPERS}
${WINDOWS_BROWSER_REPAIR_PYTHON}
${WINDOWS_BROWSER_ADOPTION_PYTHON}
`;}
export function windowsBrowserAdoptionInput(action:WindowsBrowserAdoptionAction,epoch?:string,binding?:string){return windowsBrowserProgramInput(windowsBrowserAdoptionProgram(action,epoch,binding));}
export function windowsBrowserProgramInput(source:string){const program=Buffer.from(source);if(program.length>262144)throw Error('Browser adoption program exceeds its bound');const header=Buffer.alloc(4);header.writeUInt32BE(program.length);return Buffer.concat([header,program]);}
