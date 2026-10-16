import {z} from 'zod';
import type {Environment} from '../shared/types.ts';
import type {DesktopAppId} from '../shared/guest-desktop.ts';
import type {LimaRuntime} from './runtime.ts';
import type {RunOptions} from './process.ts';
import {AppError} from './errors.ts';
import {shellQuote} from './network-guard.ts';

export const LINK_DIRECTORY='/run/mucodesandbox-links';
export const LINK_HELPER='/usr/local/bin/mu-open-link';
const schemes:Record<string,DesktopAppId>={'grokbot:':'grok-bot','sand:':'grok-bot','claude:':'claude-desktop'};
export type GuestLink={url:string;application:DesktopAppId|null};
export function parseGuestLink(input:string):GuestLink{
  if(typeof input!=='string'||Buffer.byteLength(input)>8192||/[\x00-\x20\x7f]/.test(input))throw new AppError('客体链接格式无效',400,'INVALID_GUEST_LINK');
  let url:URL;try{url=new URL(input);}catch{throw new AppError('客体链接格式无效',400,'INVALID_GUEST_LINK');}
  if(url.username||url.password)throw new AppError('链接不能包含登录凭据',400,'INVALID_GUEST_LINK');
  if(['http:','https:'].includes(url.protocol)&&url.hostname)return {url:url.href,application:null};
  const application=schemes[url.protocol];if(application)return {url:url.href,application};
  throw new AppError('该客体链接协议未获准',400,'INVALID_GUEST_LINK');
}
export const LINK_HELPER_PYTHON=String.raw`#!/usr/bin/python3
import os,pathlib,sys,json,time,uuid,urllib.parse
root=pathlib.Path('/run/mucodesandbox-links')
if root.is_symlink() or not root.is_dir() or root.stat().st_uid!=os.getuid():raise SystemExit(1)
if len(sys.argv)!=2:raise SystemExit(1)
url=sys.argv[1]
if len(url.encode())>8192 or any(ord(c)<=32 or ord(c)==127 for c in url):raise SystemExit(1)
try:p=urllib.parse.urlsplit(url)
except ValueError:raise SystemExit(1)
if p.username or p.password or p.scheme not in ['http','https','grokbot','sand','claude']:raise SystemExit(1)
if p.scheme in ['http','https'] and not p.hostname:raise SystemExit(1)
if len(list(root.glob('*.json')))>=16:raise SystemExit(1)
name=uuid.uuid4().hex+'.json'
fd=os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'w') as f:
 json.dump({'id':name[:-5],'url':url,'created':time.clock_gettime(getattr(time,'CLOCK_BOOTTIME',time.CLOCK_MONOTONIC))},f);f.flush();os.fsync(f.fileno())
`;
export const READ_LINKS_PYTHON=String.raw`import pathlib,os,pwd,json,re,time,itertools
root=pathlib.Path('/run/mucodesandbox-links');items=[]
uid=pwd.getpwnam('dev').pw_uid
if not root.exists():print('[]');raise SystemExit(0)
if root.is_symlink() or root.stat().st_uid!=uid:raise RuntimeError('Invalid link queue')
for p in itertools.islice(root.iterdir(),32):
 if not re.fullmatch(r'[a-f0-9]{32}\.json',p.name):continue
 if p.is_symlink():p.unlink();continue
 try:
  fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
  with os.fdopen(fd) as f:
   st=os.fstat(f.fileno())
   if st.st_uid!=uid or st.st_size>16384:raise ValueError('Invalid request')
   value=json.load(f)
  age=time.clock_gettime(getattr(time,'CLOCK_BOOTTIME',time.CLOCK_MONOTONIC))-float(value['created'])
  if value['id']!=p.stem or not isinstance(value['url'],str) or len(value['url'].encode())>8192 or age<0 or age>120:raise ValueError('Expired request')
  items.append({'id':p.stem,'url':value['url']})
 except (OSError,ValueError,TypeError,KeyError):p.unlink(missing_ok=True)
 if len(items)>=4:break
print(json.dumps(items))
`;
export function installGuestLinksScript(){
  const desktop='[Desktop Entry]\nType=Application\nName=MuCodeSandbox protected links\nExec='+LINK_HELPER+' %u\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/grokbot;x-scheme-handler/sand;x-scheme-handler/claude;\n';
  return `set -euo pipefail
sudo install -d -o dev -g dev -m 0700 ${LINK_DIRECTORY}
helper_next=$(sudo mktemp /usr/local/bin/.mu-open-link-XXXXXXXX)
printf '%s' ${shellQuote(LINK_HELPER_PYTHON)} | sudo tee "$helper_next" >/dev/null
sudo chown root:root "$helper_next"
sudo chmod 0755 "$helper_next"
sudo mv -f "$helper_next" ${LINK_HELPER}
printf '%s' ${shellQuote(desktop)} | sudo tee /usr/share/applications/mucodesandbox-links.desktop >/dev/null
sudo chown root:root /usr/share/applications/mucodesandbox-links.desktop
sudo chmod 0644 /usr/share/applications/mucodesandbox-links.desktop
sudo -H -u dev -- python3 - <<'MU_LINK_DEFAULTS'
import pathlib,configparser,os,tempfile
paths=[pathlib.Path('/home/dev/.config')]+[pathlib.Path('/home/dev/.local/share/mucodesandbox/desktop-clients')/app/'config' for app in ['grok-bot','claude-desktop']]
for directory in paths:
 for part in [directory,*directory.parents]:
  if part.is_symlink():raise RuntimeError('Symlink in link configuration')
 directory.mkdir(mode=0o700,parents=True,exist_ok=True)
 file=directory/'mimeapps.list'
 if file.is_symlink():raise RuntimeError('Symlink in MIME defaults')
 data=configparser.ConfigParser(interpolation=None,strict=False);data.optionxform=str
 if file.exists():data.read(file)
 if not data.has_section('Default Applications'):data.add_section('Default Applications')
 for scheme in ['http','https','grokbot','sand','claude']:data['Default Applications']['x-scheme-handler/'+scheme]='mucodesandbox-links.desktop;'
 with tempfile.NamedTemporaryFile(mode='w',dir=directory,delete=False) as f:
  data.write(f,space_around_delimiters=False);f.flush();os.fsync(f.fileno());name=f.name
 os.chmod(name,0o600);os.replace(name,file)
MU_LINK_DEFAULTS
`;
}
const requestSchema=z.object({id:z.string().regex(/^[a-f0-9]{32}$/),url:z.string().max(8192)}).strict();
export class GuestLinks {
  readonly runtime:LimaRuntime;
  readonly tracked=new Set<string>();
  prepared=new Map<string,string>();
  preparing=new Map<string,Promise<void>>();
  readonly timer:ReturnType<typeof setInterval>;
  current?:Promise<void>;
  stopped=false;
  readonly getEnvironment:(id:string)=>Environment|undefined;
  readonly busy:(id:string)=>boolean;
  readonly handle:(e:Environment,link:GuestLink)=>Promise<void>;
  constructor(runtime:LimaRuntime,getEnvironment:(id:string)=>Environment|undefined,busy:(id:string)=>boolean,handle:(e:Environment,link:GuestLink)=>Promise<void>){
    this.runtime=runtime;this.getEnvironment=getEnvironment;this.busy=busy;this.handle=handle;this.timer=setInterval(()=>void this.poll(),1000);this.timer.unref();
  }
  async prepare(e:Environment,options:RunOptions={}):Promise<void>{
    if(e.kind!=='vm'||!e.network.strict||!e.network.transparent)return;
    const key=e.updatedAt;
    if(this.prepared.get(e.id)===key)return;
    const previous=this.preparing.get(e.id);if(previous){await previous;return this.prepare(e,options);}
    const task=this.runtime.management(e,['bash','-s'],{...options,input:installGuestLinksScript(),timeoutMs:12000}).then(()=>{this.tracked.add(e.id);this.prepared.set(e.id,key);});
    this.preparing.set(e.id,task);try{await task;}finally{if(this.preparing.get(e.id)===task)this.preparing.delete(e.id);}
  }
  async poll(){
    if(this.stopped||this.current)return;
    this.current=this.read().finally(()=>{this.current=undefined;});await this.current;
  }
  private async read(){
    for(const id of this.tracked){
      if(this.stopped)return;
      const e=this.getEnvironment(id);if(!e||e.state!=='running'){this.prepared.delete(id);continue;}if(this.busy(id))continue;
      try{
        const rows=z.array(requestSchema).max(4).parse(JSON.parse(await this.runtime.management(e,['sudo','python3','-c',READ_LINKS_PYTHON],{timeoutMs:6000,maxBytes:40000})));
        for(const row of rows){
          if(this.stopped||this.busy(id))break;
          try{await this.handle(e,parseGuestLink(row.url));}
          catch(error){if(error instanceof AppError&&error.code==='OPERATION_IN_PROGRESS')break;}
          // Only the fixed validated ID reaches a guest pathname. OAuth content
          // remains in memory and the private tmpfs queue, never an event log.
          await this.runtime.management(e,['sudo','rm','-f',`${LINK_DIRECTORY}/${row.id}.json`],{timeoutMs:5000});
        }
      }catch{/* Missing/stopping VM or partial file: retry the same queue; no host fallback. */}
    }
  }
  async close(){this.stopped=true;clearInterval(this.timer);await this.current?.catch(()=>{});this.tracked.clear();}
}
