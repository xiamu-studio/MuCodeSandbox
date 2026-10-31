export const WINDOWS_DESKTOP_SESSION={directory:'/run/mu-browser/session',address:'unix:path=/run/mu-browser/session/bus',config:'/run/mu-browser/session/config',portalConfig:'[preferred]\ndefault=gtk\n'} as const;

// All children stay in the display service control group. An existing runtime
// directory is refused rather than adopted or overwritten.
export const WINDOWS_DESKTOP_SESSION_START=`export XDG_RUNTIME_DIR=${WINDOWS_DESKTOP_SESSION.directory} XDG_CONFIG_HOME=${WINDOWS_DESKTOP_SESSION.config} XDG_CURRENT_DESKTOP=Openbox
export DBUS_SESSION_BUS_ADDRESS=${WINDOWS_DESKTOP_SESSION.address}
mkdir -m 0700 "$XDG_RUNTIME_DIR"
mkdir -m 0700 "$XDG_CONFIG_HOME" "$XDG_CONFIG_HOME/xdg-desktop-portal"
printf '%s' '[preferred]
default=gtk
' > "$XDG_CONFIG_HOME/xdg-desktop-portal/portals.conf"
chmod 0600 "$XDG_CONFIG_HOME/xdg-desktop-portal/portals.conf"
/usr/bin/dbus-daemon --session --nofork --nopidfile --address="$DBUS_SESSION_BUS_ADDRESS" &
bus_pid=$!
session_name_ready(){ /usr/bin/timeout 2 /usr/bin/gdbus call --address "$DBUS_SESSION_BUS_ADDRESS" --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner "$1" 2>/dev/null; }
session_wait(){ for attempt in $(seq 1 100); do if [ "$(session_name_ready "$1")" = '(true,)' ]; then return 0; fi; kill -0 "$2"; kill -0 "$bus_pid"; sleep .05; done; return 1; }
session_wait org.freedesktop.DBus "$bus_pid"
/usr/libexec/xdg-desktop-portal-gtk &
portal_gtk_pid=$!
session_wait org.freedesktop.impl.portal.desktop.gtk "$portal_gtk_pid"
/usr/libexec/xdg-desktop-portal &
portal_pid=$!
session_wait org.freedesktop.portal.Desktop "$portal_pid"
`;

// Requires an already verified display unit, runs as root, asks its bus as dev.
// Names existing alone do not prove ownership: inspect each actual owner process
// and verify that the bus identity and owner PIDs remain stable throughout.
export const WINDOWS_DESKTOP_SESSION_CHECK=String.raw`
import os,stat,pathlib,subprocess,re,xml.etree.ElementTree as ET
mu_session=${JSON.stringify(WINDOWS_DESKTOP_SESSION)}
mu_uid=int(subprocess.check_output(['id','-u','dev'],text=True))
def mu_session_query(method,*args):
 result=subprocess.check_output(['/usr/bin/sudo','-n','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','/usr/bin/gdbus','call','--address',mu_session['address'],'--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.'+method,*args],text=True,timeout=3)
 if len(result)>256:raise RuntimeError('Desktop bus receipt oversized')
 return result.strip()
def mu_session_identity():
 value=mu_session_query('GetId')
 if re.fullmatch(r"\('[a-f0-9]{32}',\)",value) is None:raise RuntimeError('Desktop bus identity invalid')
 return value
def mu_session_pid(name):
 value=mu_session_query('GetConnectionUnixProcessID',name);match=re.fullmatch(r'\(uint32 ([1-9][0-9]{0,9}),\)',value)
 if match is None or int(match[1])<2:raise RuntimeError('Desktop bus owner invalid')
 return match[1]
def mu_session_process(pid,executable):
 root=pathlib.Path('/proc')/pid;start=(root/'stat').read_text().rsplit(')',1)[1].split()[19]
 fields=dict(line.split(':',1) for line in (root/'status').read_text().splitlines() if ':' in line)
 ids=fields.get('Uid','').split()
 if len(ids)!=4 or any(int(v)!=mu_uid for v in ids) or int(fields.get('CapEff','1'),16)!=0 or (root/'cgroup').read_text().strip()!='0::/system.slice/mucodesandbox-display.service':raise RuntimeError('Desktop session process ownership invalid')
 if os.readlink(root/'exe')!=executable:raise RuntimeError('Desktop session executable invalid')
 raw=(root/'environ').read_bytes()
 if len(raw)>65536:raise RuntimeError('Desktop session environment oversized')
 values={}
 for field in raw.split(bytes([0])):
  if not field:continue
  pair=field.split(b'=',1)
  if len(pair)!=2 or pair[0] in values:raise RuntimeError('Desktop session environment invalid')
  values[pair[0]]=pair[1]
 for key,value in {'DBUS_SESSION_BUS_ADDRESS':mu_session['address'],'XDG_RUNTIME_DIR':mu_session['directory'],'DISPLAY':':99','XAUTHORITY':'/run/mu-browser/Xauthority'}.items():
  if values.get(key.encode())!=value.encode():raise RuntimeError('Desktop session environment mismatch')
 if start!=(root/'stat').read_text().rsplit(')',1)[1].split()[19]:raise RuntimeError('Desktop session process changed')
 return start
def mu_session_interface(name,interface):
 raw=subprocess.check_output(['/usr/bin/sudo','-n','-H','-u','dev','--','env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','/usr/bin/gdbus','introspect','--xml','--address',mu_session['address'],'--dest',name,'--object-path','/org/freedesktop/portal/desktop'],text=True,timeout=3)
 if len(raw)>131072 or '<!ENTITY' in raw.upper():raise RuntimeError('Desktop portal interface receipt invalid')
 raw=re.sub(r'<!DOCTYPE\s+node\s+PUBLIC\s+"-//freedesktop//DTD D-BUS Object Introspection 1\.0//EN"\s+"http://www\.freedesktop\.org/standards/dbus/1\.0/introspect\.dtd"\s*>','',raw,count=1)
 if '<!DOCTYPE' in raw.upper():raise RuntimeError('Desktop portal interface declaration invalid')
 tree=ET.fromstring(raw);interfaces=[v for v in tree.findall('interface') if v.get('name')==interface]
 if tree.tag!='node' or len(interfaces)!=1 or not {'OpenFile','SaveFile'}<={v.get('name') for v in interfaces[0].findall('method')}:raise RuntimeError('Desktop file chooser interface unavailable')
def assert_windows_desktop_session():
 for name in [mu_session['directory'],mu_session['config'],mu_session['config']+'/xdg-desktop-portal']:
  value=pathlib.Path(name).lstat()
  if not stat.S_ISDIR(value.st_mode) or value.st_uid!=mu_uid or stat.S_IMODE(value.st_mode)!=0o700:raise RuntimeError('Desktop session directory invalid')
 socket=pathlib.Path(mu_session['directory']+'/bus').lstat()
 if not stat.S_ISSOCK(socket.st_mode) or socket.st_uid!=mu_uid:raise RuntimeError('Desktop session socket invalid')
 config=pathlib.Path(mu_session['config']+'/xdg-desktop-portal/portals.conf');value=config.lstat()
 if not stat.S_ISREG(value.st_mode) or value.st_uid!=mu_uid or value.st_nlink!=1 or stat.S_IMODE(value.st_mode)!=0o600 or value.st_size!=len(mu_session['portalConfig']):raise RuntimeError('Desktop portal configuration invalid')
 if config.read_text()!=mu_session['portalConfig']:raise RuntimeError('Desktop portal selection changed')
 identity=mu_session_identity();owners={}
 for name,executable in [('org.freedesktop.DBus','/usr/bin/dbus-daemon'),('org.freedesktop.impl.portal.desktop.gtk','/usr/libexec/xdg-desktop-portal-gtk'),('org.freedesktop.portal.Desktop','/usr/libexec/xdg-desktop-portal')]:
  pid=mu_session_pid(name);owners[name]=(pid,executable,mu_session_process(pid,executable))
 if len(set(v[0] for v in owners.values()))!=3:raise RuntimeError('Desktop session owner collision')
 mu_session_interface('org.freedesktop.impl.portal.desktop.gtk','org.freedesktop.impl.portal.FileChooser')
 mu_session_interface('org.freedesktop.portal.Desktop','org.freedesktop.portal.FileChooser')
 for name,(pid,executable,start) in owners.items():
  if mu_session_pid(name)!=pid or mu_session_process(pid,executable)!=start:raise RuntimeError('Desktop session owner changed')
 if mu_session_identity()!=identity:raise RuntimeError('Desktop bus replaced')
assert_windows_desktop_session()
`;
