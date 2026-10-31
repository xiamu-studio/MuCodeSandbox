import {shellQuote} from './network-guard.ts';

export const IMAGE_CLIPBOARD_OWNER=String.raw`#!/usr/bin/python3
import socket,os,struct,subprocess,hashlib,select,time
MAX=10485760
connection=socket.socket(fileno=os.dup(0));connection.settimeout(8)
process=None
try:
 if struct.unpack('3i',connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1]!=os.getuid():raise ValueError()
 def exact(size):
  data=bytearray()
  while len(data)<size:
   chunk=connection.recv(min(65536,size-len(data)))
   if not chunk:raise ValueError()
   data.extend(chunk)
  return bytes(data)
 size=struct.unpack('!I',exact(4))[0]
 if size<45 or size>MAX:raise ValueError()
 data=exact(size)
 if connection.recv(1) or data[:8]!=b'\x89PNG\r\n\x1a\n':raise ValueError()
 width,height=struct.unpack('!II',data[16:24])
 if not width or not height or width*height>16000000:raise ValueError()
 process=subprocess.Popen(['/usr/bin/xclip','-selection','clipboard','-target','image/png','-in','-quiet'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 process.stdin.write(data);process.stdin.close()
 expected=hashlib.sha256(data).digest();verified=False
 for attempt in range(20):
  if process.poll() is not None:raise ValueError()
  query=subprocess.Popen(['/usr/bin/xclip','-selection','clipboard','-target','image/png','-out'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
  result=bytearray();deadline=time.monotonic()+.3
  try:
   while len(result)<=MAX and time.monotonic()<deadline:
    if not select.select([query.stdout],[],[],.02)[0]:continue
    chunk=os.read(query.stdout.fileno(),min(65536,MAX+1-len(result)))
    if not chunk:break
    result.extend(chunk)
   query.wait(timeout=.1)
   verified=query.returncode==0 and len(result)==size and hashlib.sha256(result).digest()==expected
  except (OSError,subprocess.TimeoutExpired):pass
  finally:
   if query.poll() is None:query.kill();query.wait()
  if verified:break
  time.sleep(.05)
 if not verified:raise ValueError()
 connection.sendall(b'OK\n');connection.close();del data
 process.wait()
except Exception:
 try:connection.sendall(b'ERROR\n')
 except OSError:pass
 if process is not None and process.poll() is None:process.kill();process.wait()
 raise SystemExit(1)
`;
export const IMAGE_CLIPBOARD_SEND=String.raw`import sys,json,socket,struct,base64
request=json.load(sys.stdin);data=base64.b64decode(request['data'],validate=True)
if not 45<=len(data)<=10485760:raise ValueError('Invalid image size')
with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
 s.settimeout(12);s.connect('/run/mucodesandbox-clipboard/image.sock');s.sendall(struct.pack('!I',len(data))+data);s.shutdown(socket.SHUT_WR)
 response=b''
 while len(response)<3:
  part=s.recv(3-len(response))
  if not part:break
  response+=part
 if response!=b'OK\n':raise ValueError('Image clipboard not confirmed')
print('{"ok":true}')
`;
export function imageClipboardSetupScript(){return `set -eu
systemctl is-active --quiet mucodesandbox-display.service
sudo systemctl stop mucodesandbox-clipboard.service 'mucodesandbox-image-clipboard@*.service' mucodesandbox-image-clipboard.socket 2>/dev/null || true
sudo /usr/bin/python3 -I - <<'MU_IMAGE_DIRECTORY'
import os,pathlib,pwd,stat
p=pathlib.Path('/run/mucodesandbox-clipboard');uid=pwd.getpwnam('dev').pw_uid
if p.is_symlink():raise ValueError('Invalid clipboard directory')
if p.exists():
 if not p.is_dir() or p.stat().st_uid!=uid:raise ValueError('Invalid clipboard owner')
else:p.mkdir(mode=0o700);os.chown(p,uid,pwd.getpwnam('dev').pw_gid)
p.chmod(0o700)
s=p/'image.sock'
if s.exists() or s.is_symlink():
 st=s.lstat()
 if not stat.S_ISSOCK(st.st_mode) or st.st_uid!=uid:raise ValueError('Invalid clipboard socket')
 s.unlink()
MU_IMAGE_DIRECTORY
sudo install -d -m 0755 /usr/local/libexec
image_helper=$(sudo mktemp /usr/local/libexec/.mu-image-clipboard-XXXXXXXX)
printf '%s' ${shellQuote(IMAGE_CLIPBOARD_OWNER)} | sudo tee "$image_helper" >/dev/null
sudo chown root:root "$image_helper"
sudo chmod 0755 "$image_helper"
sudo mv -f "$image_helper" /usr/local/libexec/mu-image-clipboard
sudo tee /etc/systemd/system/mucodesandbox-image-clipboard.socket >/dev/null <<'MU_IMAGE_SOCKET'
[Unit]
BindsTo=mucodesandbox-display.service
After=mucodesandbox-display.service
PartOf=mucodesandbox-display.service
[Socket]
ListenStream=/run/mucodesandbox-clipboard/image.sock
SocketUser=dev
SocketGroup=dev
SocketMode=0600
DirectoryMode=0700
Accept=yes
MaxConnections=1
RemoveOnStop=yes
MU_IMAGE_SOCKET
sudo tee /etc/systemd/system/mucodesandbox-image-clipboard@.service >/dev/null <<'MU_IMAGE_SERVICE'
[Unit]
BindsTo=mucodesandbox-display.service
After=mucodesandbox-display.service
PartOf=mucodesandbox-display.service
[Service]
User=dev
Group=dev
UMask=0077
Environment=DISPLAY=:99 XAUTHORITY=/run/mu-browser/Xauthority
StandardInput=socket
StandardOutput=null
StandardError=null
ExecStart=/usr/bin/python3 /usr/local/libexec/mu-image-clipboard
KillMode=control-group
TimeoutStopSec=3
MemoryMax=256M
TasksMax=8
Restart=no
MU_IMAGE_SERVICE
sudo systemctl daemon-reload
sudo systemctl start mucodesandbox-image-clipboard.socket
`;}
