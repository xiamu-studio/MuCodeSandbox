import {WINDOWS_COMPONENT_FILES_PYTHON} from './component-files.ts';
import {WINDOWS_AGENT} from './agent-assets.ts';

// Shared implementation is also run on real ordinary test files with explicit
// POSIX ownership/dirfd adapters. Production parameters are constants in code,
// never request data. No package script, shell, subprocess or CLI is executed.
export const WINDOWS_AGENT_COMPONENT_PYTHON=WINDOWS_COMPONENT_FILES_PYTHON+String.raw`def main(asset,mode):
 need(mode in ['inspect','install']);need(set(asset['files'])=={'claude','package.json','LICENSE.md','README.md'});need(re.fullmatch(r'\d+\.\d+\.\d+',asset['version']) is not None)
 leaf='claude-code-'+asset['version'];candidate='.'+leaf+'.installing';pins=Pins();lock=None
 record=json.dumps(dict(version=1,name=asset['name'],release=asset['version'],architecture='x86_64',archiveSha256=asset['sha256'],files=asset['files']),sort_keys=True,separators=(',',':')).encode()
 files=dict(asset['files']);files['.mu-component.json']=dict(bytes=len(record),sha256=hashlib.sha256(record).hexdigest());result=dict(version=1,state='untrusted')
 try:
  if mode=='install':need(os.geteuid()==0)
  parent=pins.path(['opt','mucodesandbox','windows'],mode=='install')
  if exists(parent,leaf):
   result['state']='untrusted';final=pins.child(parent,leaf)
   try:check_tree(final,files)
   except FileNotFoundError:raise Refused('Published component is incomplete')
   pins.check();result['state']='verified';return result
  if mode=='inspect':result['state']='pending' if exists(parent,candidate) else 'missing';pins.check();return result
  lock=os.open('.claude-code-install.lock',os.O_RDWR|os.O_CREAT|os.O_CLOEXEC|os.O_NOFOLLOW,0o600,dir_fd=parent);regular(os.fstat(lock),0)
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:result['state']='busy';return result
  pins.check()
  if exists(parent,leaf):
   final=pins.child(parent,leaf);check_tree(final,files);pins.check();result['state']='verified';return result
  try:os.mkdir(candidate,0o700,dir_fd=parent);sync(parent)
  except FileExistsError:pass
  stage=pins.child(parent,candidate);need(set(os.listdir(stage))<=set(files)|{'.archive.tgz'})
  bounds=dict(files);bounds['.archive.tgz']=dict(bytes=asset['bytes']);remaining=sum(item['bytes'] for item in bounds.values())
  for name in os.listdir(stage):
   item=os.stat(name,dir_fd=stage,follow_symlinks=False);regular(item,bounds[name]['bytes']);remaining-=item.st_size
  space=os.fstatvfs(parent);need(space.f_bavail*space.f_frsize>=remaining+67108864)
  # Cache and candidate can only resume identical approved byte prefixes. Any
  # unknown name, hardlink, redirect or changed byte is retained and refused.
  fill(stage,'.archive.tgz',sys.stdin.buffer,dict(bytes=asset['bytes'],sha256=asset['sha256']),pins)
  archive=os.open('.archive.tgz',os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW,dir_fd=stage)
  try:
   before=os.fstat(archive);regular(before,asset['bytes']);seen=set()
   with os.fdopen(archive,'rb',closefd=False) as source:
    with tarfile.open(fileobj=source,mode='r|gz') as bundle:
     for member in bundle:
      need(member.name.startswith('package/'));name=member.name[8:];need(name in asset['files'] and name not in seen and member.isfile() and not member.pax_headers and member.size==asset['files'][name]['bytes']);seen.add(name)
      with bundle.extractfile(member) as content:fill(stage,name,content,asset['files'][name],pins,name=='claude')
   need(seen==set(asset['files']));stable(stage,'.archive.tgz',archive,before,asset['bytes'])
  finally:os.close(archive)
  import io
  fill(stage,'.mu-component.json',io.BytesIO(record),files['.mu-component.json'],pins)
  need(set(os.listdir(stage))==set(files)|{'.archive.tgz'})
  read_exact(stage,'.archive.tgz',dict(bytes=asset['bytes'],sha256=asset['sha256']));pins.check();os.unlink('.archive.tgz',dir_fd=stage);sync(stage)
  check_tree(stage,files);pins.check();os.fchmod(stage,0o755);sync(stage)
  # All handles are open and publication never replaces an existing version.
  rename_exclusive(parent,candidate,leaf);sync(parent)
  # Candidate bindings changed only in the intentional no-replace rename.
  final=os.stat(leaf,dir_fd=parent,follow_symlinks=False);directory(final);need(identity(final)==identity(os.fstat(stage)));check_tree(stage,files);result['state']='verified';return result
 except FileNotFoundError:
  if mode=='inspect':result['state']='missing';return result
  raise
 except (Refused,OSError,ValueError,tarfile.TarError):
  if mode=='inspect':return result
  raise
 finally:
  if lock is not None:os.close(lock)
  pins.close()
`;

export function windowsAgentComponentProgram(mode:'inspect'|'install'){
 if(mode!=='inspect'&&mode!=='install')throw Error('Invalid component operation');
 return WINDOWS_AGENT_COMPONENT_PYTHON+'\nprint(json.dumps(main('+JSON.stringify(WINDOWS_AGENT)+','+JSON.stringify(mode)+'),sort_keys=True))\n';
}
