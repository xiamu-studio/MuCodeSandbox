"""Unchanged production session inspector; ordinary files, explicit proc/D-Bus/POSIX adapters.
No actual Linux bus, portal, sudo, client or VM runs.
"""
import pathlib as paths,os as native,sys,stat,types,hashlib,json,builtins,subprocess
program=paths.Path(sys.argv[1]).read_text(encoding='utf8');base=paths.Path(sys.argv[2]);checks=[]
cases=['valid','valid-doctype','directory-owner','directory-link','directory-mode','socket-type','socket-owner','config-link','config-mode','config-hardlink','config-size','config-content','bus-id','bus-replaced','pid-format','pid-low','owner-collision','owner-replaced','uid','caps','cgroup','executable','environment','environment-duplicate','environment-oversize','process-replaced','query-failure','interface-missing','interface-method-missing','interface-duplicate','interface-oversize','interface-entity','interface-malformed']
for case in cases:
 root=base/case;root.mkdir();counts={};pidnames={'org.freedesktop.DBus':'2222','org.freedesktop.impl.portal.desktop.gtk':'3333','org.freedesktop.portal.Desktop':'4444'};executables={'2222':'/usr/bin/dbus-daemon','3333':'/usr/libexec/xdg-desktop-portal-gtk','4444':'/usr/libexec/xdg-desktop-portal'}
 def file(name):return root.joinpath(*paths.PurePosixPath(name).parts[1:])
 config='/run/mu-browser/session/config/xdg-desktop-portal/portals.conf';target=file(config);target.parent.mkdir(parents=True);target.write_bytes(b'[preferred]\ndefault=gtk\n')
 file('/run/mu-browser/session/bus').write_bytes(b'SYNTHETIC SOCKET METADATA ONLY')
 for pid in executables:
  p=file('/proc/'+pid);p.mkdir(parents=True)
  (p/'stat').write_text(pid+' (synthetic session) '+' '.join(['S']+['0']*18+['12345']))
  (p/'status').write_text('Uid:\t1000\t1000\t1000\t1000\nCapEff:\t0000000000000000\n')
  (p/'cgroup').write_text('0::/system.slice/mucodesandbox-display.service\n')
  (p/'environ').write_bytes(b'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/mu-browser/session/bus\0XDG_RUNTIME_DIR=/run/mu-browser/session\0DISPLAY=:99\0XAUTHORITY=/run/mu-browser/Xauthority\0')
 if case=='config-content':target.write_bytes(b'[preferred]\ndefault=kde\n')
 if case=='uid':file('/proc/3333/status').write_text('Uid:\t0\t1000\t1000\t1000\nCapEff:\t0\n')
 if case=='caps':file('/proc/3333/status').write_text('Uid:\t1000\t1000\t1000\t1000\nCapEff:\t1\n')
 if case=='cgroup':file('/proc/3333/cgroup').write_text('0::/system.slice/foreign.service\n')
 if case=='environment':file('/proc/3333/environ').write_bytes(b'DISPLAY=:0\0')
 if case=='environment-duplicate':
  p=file('/proc/3333/environ');p.write_bytes(p.read_bytes()+b'DISPLAY=:99\0')
 if case=='environment-oversize':file('/proc/3333/environ').write_bytes(b'x'*65537)
 sentinel=root/'account-sentinel';sentinel.write_bytes(b'KEEP SYNTHETIC ACCOUNT')
 def inventory():return {p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
 before=inventory()
 class Path:
  def __init__(self,name):self.name=paths.PurePosixPath(name)
  def __truediv__(self,name):return Path(self.name/name)
  def __str__(self):return str(self.name)
  def lstat(self):
   real=file(str(self.name));s=real.lstat();mode=(stat.S_IFDIR|0o700) if real.is_dir() else (stat.S_IFSOCK|0o700) if self.name.name=='bus' else stat.S_IFREG|0o600;uid=1000;links=1;size=s.st_size
   if str(self.name)=='/run/mu-browser/session':
    if case=='directory-owner':uid=0
    if case=='directory-link':mode=stat.S_IFLNK|0o700
    if case=='directory-mode':mode=stat.S_IFDIR|0o755
   if self.name.name=='bus':
    if case=='socket-type':mode=stat.S_IFREG|0o700
    if case=='socket-owner':uid=0
   if str(self.name)==config:
    if case=='config-link':mode=stat.S_IFLNK|0o600
    if case=='config-mode':mode=stat.S_IFREG|0o644
    if case=='config-hardlink':links=2
    if case=='config-size':size+=1
   return types.SimpleNamespace(st_mode=mode,st_uid=uid,st_nlink=links,st_size=size)
  def read_text(self):
   raw=file(str(self.name)).read_text(encoding='utf8');key=str(self.name);counts[key]=counts.get(key,0)+1
   if case=='process-replaced' and key=='/proc/3333/stat' and counts[key]>1:raw=raw.replace('12345','67890')
   return raw
  def read_bytes(self):return file(str(self.name)).read_bytes()
 def command(args,**kwargs):
  if args==['id','-u','dev']:return '1000\n'
  if args[11]=='introspect':
   assert args[:14]==['/usr/bin/sudo','-n','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','/usr/bin/gdbus','introspect','--xml','--address'] and args[14]=='unix:path=/run/mu-browser/session/bus' and args[-2:]==['--object-path','/org/freedesktop/portal/desktop']
   interface='org.freedesktop.impl.portal.FileChooser' if args[16]=='org.freedesktop.impl.portal.desktop.gtk' else 'org.freedesktop.portal.FileChooser'
   if case=='interface-missing':return '<node/>'
   if case=='interface-oversize':return 'x'*131073
   if case=='interface-entity':return '<!DOCTYPE node><node/>'
   if case=='interface-malformed':return '<node'
   entry='<interface name="'+interface+'"><method name="OpenFile"/>'+('' if case=='interface-method-missing' else '<method name="SaveFile"/>')+'</interface>'
   return ('<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"\n"http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">\n' if case=='valid-doctype' else '')+'<node>'+entry*(2 if case=='interface-duplicate' else 1)+'</node>'
  assert args[:16]==['/usr/bin/sudo','-n','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','/usr/bin/gdbus','call','--address','unix:path=/run/mu-browser/session/bus','--dest','org.freedesktop.DBus'],args
  assert args[16:19]==['--object-path','/org/freedesktop/DBus','--method'] and kwargs==dict(text=True,timeout=3)
  method=args[19];counts[method]=counts.get(method,0)+1
  if case=='query-failure':raise subprocess.TimeoutExpired(args,3)
  if method=='org.freedesktop.DBus.GetId':return '(bad,)' if case=='bus-id' else "('"+('b' if case=='bus-replaced' and counts[method]>1 else 'a')*32+"',)\n"
  assert method=='org.freedesktop.DBus.GetConnectionUnixProcessID';name=args[20];key='pid-'+name;counts[key]=counts.get(key,0)+1
  if case=='pid-format':return '(uint32 ../../bad,)\n'
  if case=='pid-low':return '(uint32 1,)\n'
  pid=pidnames[name]
  if case=='owner-collision':pid='2222'
  if case=='owner-replaced' and name=='org.freedesktop.impl.portal.desktop.gtk' and counts[key]>1:pid='5555'
  return '(uint32 '+pid+',)\n'
 def readlink(name):
  pid=paths.PurePosixPath(str(name)).parts[2];return '/usr/bin/foreign' if case=='executable' and pid=='3333' else executables[pid]
 overrides={'pathlib':types.SimpleNamespace(Path=Path),'os':types.SimpleNamespace(readlink=readlink),'subprocess':types.SimpleNamespace(check_output=command)}
 def importing(name,*args,**kwargs):return overrides[name] if name in overrides else builtins.__import__(name,*args,**kwargs)
 safe=dict(vars(builtins));safe['__import__']=importing;error=None
 try:exec(compile(program,'unchanged-desktop-session-check','exec'),{'__builtins__':safe})
 except (RuntimeError,ValueError,OSError,subprocess.SubprocessError,__import__('xml.etree.ElementTree',fromlist=['ParseError']).ParseError) as failure:error=failure
 if case in ['valid','valid-doctype']:assert error is None,error
 else:assert error is not None,('Accepted invalid session',case)
 assert before==inventory();checks.append(case)
print(json.dumps(dict(complete=True,checks=checks,actualOrdinaryFiles=True,explicitProcBusPosixAdapters=True,actualLinux=False,actualBus=False,actualPortal=False,clientExecuted=False)))
