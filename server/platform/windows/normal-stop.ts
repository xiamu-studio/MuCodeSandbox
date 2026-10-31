// Used only after a user-requested stop has confirmed both egress disconnect
// and lease revocation. Fault shutdown must never wait for this helper.
export const PREPARE_WINDOWS_NORMAL_STOP=String.raw`import json,os,pathlib,re,subprocess,time
unit='mucodesandbox-browser.service'
def state():
 value=subprocess.check_output(['/usr/bin/systemctl','show',unit,'--property=ActiveState,MainPID,ControlGroup'],text=True,timeout=.75)
 return dict(line.split('=',1) for line in value.splitlines() if '=' in line)
def stopped(value):return value.get('ActiveState')=='inactive' and value.get('MainPID')=='0'
before=state()
if stopped(before):
 print(json.dumps({'version':1,'browser':'already-stopped'}));raise SystemExit(0)
if before.get('ActiveState')!='active' or not re.fullmatch('[1-9][0-9]*',before.get('MainPID','')) or before.get('ControlGroup')!='/system.slice/'+unit:raise RuntimeError('Browser unit identity unavailable')
main=before['MainPID']
pids=set((pathlib.Path('/sys/fs/cgroup')/before['ControlGroup'].lstrip('/')/'cgroup.procs').read_text().split())
windows=[]
for line in subprocess.check_output(['/usr/bin/wmctrl','-lp'],text=True,timeout=.75).splitlines():
 fields=line.split(None,4)
 if len(fields)>=4 and fields[2] in pids and re.fullmatch('0x[0-9a-fA-F]{1,16}',fields[0]):windows.append(fields[0])
if not windows or len(windows)>8:raise RuntimeError('Browser windows unavailable')
for window in windows:
 current=state()
 if stopped(current):break
 if current.get('MainPID')!=main or current.get('ControlGroup')!=before['ControlGroup']:raise RuntimeError('Browser unit changed')
 subprocess.run(['/usr/bin/wmctrl','-ic',window],check=True,timeout=.75,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
deadline=time.monotonic()+3
while True:
 current=state()
 if stopped(current):break
 if current.get('MainPID')!=main:raise RuntimeError('Browser unit changed')
 if time.monotonic()>=deadline:raise TimeoutError('Browser close unconfirmed')
 time.sleep(.05)
print(json.dumps({'version':1,'browser':'closed'}))
`;
