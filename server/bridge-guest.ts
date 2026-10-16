export const GUEST_BRIDGE_CONFIG_PYTHON = String.raw`
import json, os, stat

def install_bridge_config(home, uid, gid, name, configuration):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(home, flags)
    try:
        for component in ['.config', 'mucodesandbox']:
            try: os.mkdir(component, mode=0o700, dir_fd=directory)
            except FileExistsError: pass
            child = os.open(component, flags, dir_fd=directory)
            try:
                info = os.fstat(child)
                if info.st_uid not in [0, uid]: raise RuntimeError('Unexpected guest configuration owner')
                os.fchown(child, uid, gid)
                os.fchmod(child, 0o700)
            except BaseException:
                os.close(child)
                raise
            os.close(directory)
            directory = child
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            os.fchown(fd, uid, gid)
            with os.fdopen(fd, 'w') as out:
                fd = -1
                json.dump(configuration, out)
                out.flush()
                os.fsync(out.fileno())
        finally:
            if fd != -1: os.close(fd)
    finally:
        os.close(directory)
`;

export function installGuestBridgeConfig(id: string, configuration: { socket: string; host: string; token: string }) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid bridge grant ID');
  return `sudo python3 - <<'MU_BRIDGE_CONFIG'
${GUEST_BRIDGE_CONFIG_PYTHON}
import pwd
developer = pwd.getpwnam('dev')
install_bridge_config('/home/dev', developer.pw_uid, developer.pw_gid, ${JSON.stringify(`bridge-${id}.json`)}, ${JSON.stringify(configuration)})
MU_BRIDGE_CONFIG
`;
}

export const GUEST_BRIDGE_CLIENT = `#!/usr/bin/python3
import sys, os, json, re, socket, http.client, base64
if len(sys.argv) < 3 or not re.fullmatch(r'[a-f0-9-]{36}',sys.argv[1]) or sys.argv[2] not in ['list','read','stat','sha256','write','command'] or len(sys.argv)>4:
    sys.exit('Usage: mu-host GRANT_ID list|read|stat|sha256|write [relative_path] | command git-status|git-diff|git-log')
with open(os.path.expanduser('~/.config/mucodesandbox/bridge-'+sys.argv[1]+'.json')) as f: config=json.load(f)
request={'operation':sys.argv[2],'path':sys.argv[3] if len(sys.argv)>3 else ''}
if request['operation']=='command':
    request={'operation':'command','command':sys.argv[3] if len(sys.argv)>3 else ''}
if request['operation']=='write':
    data=sys.stdin.buffer.read(1048577)
    if len(data)>1048576: sys.exit('Transfer limit exceeded')
    request['data']=base64.b64encode(data).decode()
class Connection(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect(config['socket'])
connection=Connection(config['host'],timeout=10)
connection.request('POST','/capability',json.dumps(request),{'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'})
response=connection.getresponse()
value=json.loads(response.read(1500000))
if response.status!=200: sys.exit(value.get('error','Bridge request failed'))
result=value['result']
if request['operation']=='read': sys.stdout.buffer.write(base64.b64decode(result['data']))
else: print(json.dumps(result,ensure_ascii=False))
`;
