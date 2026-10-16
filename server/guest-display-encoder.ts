import type { Environment } from '../shared/types.ts';
import type { LimaRuntime } from './runtime.ts';
import type { RunOptions } from './process.ts';
import { AppError } from './errors.ts';

export const DISPLAY_ENCODER_VERSION = '3.3.1';
export const DISPLAY_ENCODER_ARCHIVE_SHA256 = 'ad2448cd80997174c47b507e058fc385716aa9bd71c04e149f8da5a98fa77a9b';
export const DISPLAY_ENCODER_BINARY_SHA256 = 'a15ab79f481572b66af5fcad02a4174504237fab36e9adb607af2131a85a130d';
export const DISPLAY_ENCODER_EXECUTABLE = `/opt/mucodesandbox/turbovnc-${DISPLAY_ENCODER_VERSION}/bin/Xvnc`;

// Extract only the verified server and its notices. Never install the vendor's
// desktop viewer/JRE or execute DEB maintainer scripts that create services.
export const INSTALL_DISPLAY_ENCODER = `import hashlib,json,os,pathlib,pwd,shutil,stat,subprocess,tempfile
assert os.geteuid()==0
version='${DISPLAY_ENCODER_VERSION}'
archive_hash='${DISPLAY_ENCODER_ARCHIVE_SHA256}'
binary_hash='${DISPLAY_ENCODER_BINARY_SHA256}'
def digest(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def owned_directory(p,mode=0o755):
 p.mkdir(mode=mode,exist_ok=True)
 s=p.lstat()
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:raise RuntimeError('Unsafe display component directory')
def trusted_file(p,expected=None):
 try:
  s=p.lstat()
  return stat.S_ISREG(s.st_mode) and s.st_uid==0 and not s.st_mode&0o6022 and (expected is None or digest(p)==expected)
 except FileNotFoundError:return False
base=pathlib.Path('/opt/mucodesandbox');owned_directory(base)
target=base/('turbovnc-'+version);owned_directory(target)
owned_directory(target/'bin')
binary=target/'bin/Xvnc';notice=target/'LICENSE.txt'
if trusted_file(binary,binary_hash) and binary.stat().st_mode&0o7777==0o755 and trusted_file(notice):
 print('Verified multi-thread display component already installed.');raise SystemExit(0)
cache=pathlib.Path('/var/cache/mucodesandbox-display');owned_directory(cache,0o700)
archive=cache/('turbovnc-'+version+'-arm64.deb')
if not trusted_file(archive,archive_hash):
 print('Downloading official multi-thread display component through the guest network.',flush=True)
 dev=pwd.getpwnam('dev')
 with tempfile.TemporaryDirectory(prefix='mu-display-download-') as folder:
  os.chown(folder,dev.pw_uid,dev.pw_gid);download=pathlib.Path(folder)/'package.deb'
  subprocess.run(['sudo','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/local/bin:/usr/bin:/bin','curl','-q','--fail','--location','--proto','=https','--proto-redir','=https','--silent','--show-error','--retry','1','--max-time','180','--max-filesize','41809004','--output',str(download),'https://github.com/TurboVNC/turbovnc/releases/download/'+version+'/turbovnc_'+version+'_arm64.deb'],check=True)
  with os.fdopen(os.open(download,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK),'rb') as source:
   s=os.fstat(source.fileno())
   if not stat.S_ISREG(s.st_mode) or s.st_size!=41809004:raise RuntimeError('Unexpected display archive')
   with tempfile.NamedTemporaryFile(dir=cache,prefix='.download-',delete=False) as out:
    incoming=pathlib.Path(out.name);shutil.copyfileobj(source,out);out.flush();os.fsync(out.fileno())
  try:
   if digest(incoming)!=archive_hash:raise RuntimeError('Display archive checksum mismatch')
   incoming.chmod(0o600);os.replace(incoming,archive)
  finally:incoming.unlink(missing_ok=True)
if not trusted_file(archive,archive_hash):raise RuntimeError('Unverified display archive')
import tarfile
wanted={'opt/TurboVNC/bin/Xvnc':'bin/Xvnc','usr/share/doc/turbovnc-'+version+'/LICENSE.txt':'LICENSE.txt'}
files={};process=subprocess.Popen(['dpkg-deb','--fsys-tarfile',str(archive)],stdout=subprocess.PIPE)
try:
 with tarfile.open(fileobj=process.stdout,mode='r|') as content:
  for member in content:
   name=member.name.removeprefix('./')
   if name not in wanted:continue
   if not member.isfile() or member.size>16*1024*1024:raise RuntimeError('Invalid display archive member')
   files[wanted[name]]=content.extractfile(member).read()
 if process.wait()!=0:raise RuntimeError('Display archive extraction failed')
finally:
 process.stdout.close()
 if process.poll() is None:process.kill();process.wait()
if set(files)!={'bin/Xvnc','LICENSE.txt'} or hashlib.sha256(files['bin/Xvnc']).hexdigest()!=binary_hash:raise RuntimeError('Display executable verification failed')
for relative,data in files.items():
 destination=target/relative
 with tempfile.NamedTemporaryFile(dir=destination.parent,prefix='.install-',delete=False) as out:
  staged=pathlib.Path(out.name);out.write(data);out.flush();os.fsync(out.fileno())
 try:
  staged.chmod(0o755 if relative=='bin/Xvnc' else 0o644);os.replace(staged,destination)
 finally:staged.unlink(missing_ok=True)
if not trusted_file(binary,binary_hash):raise RuntimeError('Installed display executable is invalid')
print('Verified multi-thread display component installed; no service started.')
`;

export async function ensureDisplayEncoder(runtime: LimaRuntime, environment: Environment, options: RunOptions = {}) {
  if (environment.kind !== 'vm' || environment.state !== 'running') throw new AppError('请先启动 Linux 环境', 409);
  await runtime.management(environment, ['sudo', 'python3', '-u', '-c', INSTALL_DISPLAY_ENCODER], { ...options, timeoutMs: 420_000 });
}
