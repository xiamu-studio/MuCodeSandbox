import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {shellQuote} from '../../network-guard.ts';
import type {RunOptions} from '../../process.ts';
import type {HyperVRuntime} from './runtime.ts';
import type {WindowsConfig} from './config.ts';
import {downloadVerifiedAsset} from './download.ts';
import {WINDOWS_CHROME,WINDOWS_DISPLAY,WINDOWS_CHROME_ROOT,WINDOWS_DISPLAY_ROOT} from './browser-assets.ts';
import {BOOTSTRAP_IP_STACK} from './guest.ts';

export const WINDOWS_DESKTOP_PACKAGES=['xauth','x11vnc','x11-utils','x11-xkb-utils','xkb-data','xfonts-base','xfonts-scalable','fonts-unifont','xsettingsd','openbox','wmctrl','xclip','dbus-x11','thunar','pulseaudio','pulseaudio-utils','libxfont2','libnss3-tools',
 'fonts-noto-cjk','fonts-noto-color-emoji','fonts-liberation','libfontconfig1','libfreetype6','libasound2t64','libatk-bridge2.0-0t64','libatk1.0-0t64','libatspi2.0-0t64',
 'libcairo2','libcups2t64','libdbus-1-3','libdrm2','libgbm1','libgl1','libegl1','libgl1-mesa-dri','libglib2.0-0t64','libnspr4','libnss3','libpango-1.0-0',
 'libgtk-3-0t64','libvulkan1','libcurl4t64','libexpat1','libudev1','xdg-utils','libx11-6','libxcb1','libxcomposite1','libxdamage1','libxext6','libxfixes3','libxkbcommon0','libxrandr2'] as const;

export function desktopDependenciesScript(bootstrapProxy?:string){
 const proxy=bootstrapProxy?['-o',`Acquire::http::Proxy=${bootstrapProxy}`,'-o',`Acquire::https::Proxy=${bootstrapProxy}`]:['-o','APT::Sandbox::User=dev'];
 const options=[...proxy,'-o','Acquire::ForceIPv4=true'].map(shellQuote).join(' ');
 return `set -euo pipefail
${bootstrapProxy?BOOTSTRAP_IP_STACK:''}
sudo env DEBIAN_FRONTEND=noninteractive SYSTEMD_OFFLINE=1 NEEDRESTART_MODE=l apt-get ${options} -o APT::Update::Error-Mode=any update -qq
sudo env DEBIAN_FRONTEND=noninteractive SYSTEMD_OFFLINE=1 NEEDRESTART_MODE=l apt-get ${options} -y --no-install-recommends --no-remove install ${WINDOWS_DESKTOP_PACKAGES.join(' ')}
`;
}

// Only a fresh empty builder or an explicitly selected protected guest uses
// this installer. It never executes vendor DEB maintainer scripts or updaters.
export function installDesktopComponent(role:'chrome'|'display'){
 const asset=role==='chrome'?WINDOWS_CHROME:WINDOWS_DISPLAY,target=role==='chrome'?WINDOWS_CHROME_ROOT:WINDOWS_DISPLAY_ROOT;
 return `import os,sys,pathlib,tempfile,hashlib,subprocess,tarfile,shutil,stat,json
assert os.geteuid()==0
expected=${JSON.stringify(asset)}
root=pathlib.Path('/opt/mucodesandbox/windows')
current=pathlib.Path('/')
for part in root.parts[1:]:
 current=current/part
 current.mkdir(mode=0o755,exist_ok=True)
 info=current.lstat()
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('Unsafe component parent')
target=pathlib.Path(${JSON.stringify(target)})
if target.exists() or target.is_symlink():
 raise RuntimeError('Component destination already exists; inspect it before repair')
with tempfile.TemporaryDirectory(prefix='.component-',dir=root) as folder:
 stage=pathlib.Path(folder);archive=stage/'archive.deb';digest=hashlib.sha256();size=0
 with archive.open('xb') as output:
  os.chmod(archive,0o600)
  while True:
   block=sys.stdin.buffer.read(65536)
   if not block:break
   size+=len(block)
   if size>expected['bytes']:raise RuntimeError('Oversized component')
   digest.update(block);output.write(block)
  output.flush();os.fsync(output.fileno())
 if size!=expected['bytes'] or digest.hexdigest()!=expected['sha256']:raise RuntimeError('Component checksum mismatch')
 if subprocess.check_output(['dpkg-deb','-f',str(archive),'Architecture'],text=True).strip()!='amd64':raise RuntimeError('Wrong component architecture')
 if ${JSON.stringify(role)}=='chrome':
  if subprocess.check_output(['dpkg-deb','-f',str(archive),'Version'],text=True).strip()!=expected['packageVersion']:raise RuntimeError('Wrong browser version')
 payload=stage/'payload';payload.mkdir(mode=0o755)
 process=subprocess.Popen(['dpkg-deb','--fsys-tarfile',str(archive)],stdout=subprocess.PIPE)
 count=0;total=0;seen=set()
 try:
  with tarfile.open(fileobj=process.stdout,mode='r|') as contents:
   for item in contents:
    name=pathlib.PurePosixPath(item.name)
    if name.is_absolute() or '..' in name.parts:raise RuntimeError('Unsafe component path')
    if ${JSON.stringify(role)}=='chrome':
     if name.parts[:3]!=('opt','google','chrome') or len(name.parts)<=3:continue
     relative=pathlib.PurePosixPath(*name.parts[3:])
    else:
     mapping={'opt/TurboVNC/bin/Xvnc':'bin/Xvnc','usr/share/doc/turbovnc-'+expected['version']+'/LICENSE.txt':'LICENSE.txt'}
     if str(name) not in mapping:continue
     relative=pathlib.PurePosixPath(mapping[str(name)])
    if not(item.isfile() or item.isdir()) or str(relative) in seen:raise RuntimeError('Unexpected component link or duplicate')
    seen.add(str(relative));count+=1;total+=item.size
    if count>20000 or total>1024*1024*1024:raise RuntimeError('Component payload exceeds bounds')
    destination=payload/relative;destination.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
    if item.isdir():destination.mkdir(exist_ok=True,mode=0o755)
    else:
     with contents.extractfile(item) as source,destination.open('xb') as output:shutil.copyfileobj(source,output);output.flush();os.fsync(output.fileno())
     os.chmod(destination,item.mode&0o755)
  if process.wait()!=0:raise RuntimeError('Component extraction failed')
 finally:
  process.stdout.close()
  if process.poll() is None:process.kill();process.wait()
 main=payload/('chrome' if ${JSON.stringify(role)}=='chrome' else 'bin/Xvnc')
 if not main.is_file():raise RuntimeError('Missing component executable')
 binary_hash=hashlib.sha256(main.read_bytes()).hexdigest()
 if ${JSON.stringify(role)}=='display' and binary_hash!=expected['binarySha256']:raise RuntimeError('Display executable checksum mismatch')
 os.chmod(main,0o755)
 if ${JSON.stringify(role)}=='chrome':
  helper=payload/'chrome-sandbox'
  if not helper.is_file() or helper.is_symlink():raise RuntimeError('Missing browser sandbox helper')
  os.chmod(helper,0o4755)
 record=payload/'.mu-component.json';record.write_text(json.dumps(dict(archiveSha256=expected['sha256'],binarySha256=binary_hash,architecture='amd64',version=expected['version']),sort_keys=True));os.chmod(record,0o644)
 with record.open('rb') as source:os.fsync(source.fileno())
 os.rename(payload,target)
 fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
 print('Verified AMD64 component installed: '+${JSON.stringify(role)})
`;
}

export async function prepareDesktopAssets(directory:string){
 for(const [name,asset] of [['chrome.deb',WINDOWS_CHROME],['display.deb',WINDOWS_DISPLAY]] as const)await downloadVerifiedAsset(asset,path.join(directory,name),{maxBytes:asset.bytes+1});
}
export async function installDesktopAssets(runtime:Pick<HyperVRuntime,'management'>,config:WindowsConfig,directory:string,options:RunOptions={}){
 for(const [role,name] of [['chrome','chrome.deb'],['display','display.deb']] as const){
  options.signal?.throwIfAborted();
  await runtime.management(config,['sudo','-n','python3','-c',installDesktopComponent(role)],{...options,inputBytes:await readFile(path.join(directory,name)),timeoutMs:300000,maxBytes:8192});
 }
}
