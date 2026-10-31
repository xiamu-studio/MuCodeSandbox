"""Production root-task policy with ordinary Windows files and explicit OS/systemd adapters.
No sudo, systemd, real guest, vendor executable or account is invoked.
"""
import pathlib,sys,json,io,types,hashlib,stat,os as native
operations=pathlib.Path(sys.argv[1]).read_text(encoding='utf8');runner_raw=pathlib.Path(sys.argv[3]).read_bytes();runner_source=runner_raw.decode('utf8').replace('\r\n','\n').rsplit('\ntry:\n need(len(sys.argv)==7)',1)[0]
parameters=json.loads(pathlib.Path(sys.argv[4]).read_text(encoding='utf8'));parameters['bootId']='12345678-1234-4234-8234-123456789abc'
prefix=pathlib.Path(__file__).with_name('windows-agent-component.py').read_text(encoding='utf8').split('def expect_refused')[0]
prefix=prefix.replace("['stat','json','hashlib','tarfile','re','io']","['stat','json','hashlib','tarfile','re','io','uuid','time','subprocess','types']")
prefix=prefix.replace('stdin=types.SimpleNamespace(buffer=io.BytesIO(raw))','stdin=types.SimpleNamespace(buffer=io.BytesIO(raw)),stdout=io.StringIO(),stderr=io.StringIO(),test_context=self')
prefix=prefix.replace("safe['open']=lambda *a,**k:(_ for _ in ()).throw(AssertionError('Unpinned path operation'))","safe['open']=self.kernel_open")
exec(compile(prefix,'explicit-root-task-file-adapters','exec'),globals())
BOOT=parameters['bootId'];results=[]

class Task(Fixture):
 def __init__(self,name):
  super().__init__(name);self.boot=BOOT;self.loaded=False;self.active='inactive';self.pid='0';self.populated=False;self.group_exists=False;self.stop_works=True;self.keep_group=False;self.override={};self.payloads=[];self.starts=[];self.stops=[];self.before_start=None;self.version=255;self.proc_group=None;self.raw_group=None;self.communication_fails=False;self.client_kills=0
 @property
 def unit(self):return 'mucodesandbox-desktop-component-'+parameters['token']+'.service'
 @property
 def folder(self):return self.root/'run/mucodesandbox/desktop-component-jobs'/parameters['token']
 def kernel_open(self,name,*args,**kwargs):
  if name=='/proc/sys/kernel/random/boot_id':return io.StringIO(self.boot+'\n')
  if name=='/proc/self/cgroup':return io.StringIO(self.proc_group or '0::/system.slice/'+self.unit+'\n')
  if name=='/sys/fs/cgroup/system.slice/'+self.unit+'/cgroup.events':
   if not self.group_exists:raise FileNotFoundError(name)
   return io.StringIO(self.raw_group if self.raw_group is not None else 'populated '+str(int(self.populated))+'\nfrozen 0\n')
  raise AssertionError('Unpinned kernel read '+str(name))
 def values(self):
  values=dict.fromkeys(['Id','LoadState','ActiveState','MainPID','User','Group','Type','ExitType','KillMode','RuntimeMaxUSec','TimeoutStopUSec','Description','ControlGroup','ExecStart'],'')
  values.update(Id=self.unit,LoadState='loaded' if self.loaded else 'not-found',ActiveState=self.active,MainPID=self.pid)
  if self.loaded:
   argv=['/usr/bin/python3','-I','/run/mucodesandbox/desktop-component-jobs/'+parameters['token']+'/runner.py',parameters['token'],parameters['application'],BOOT,parameters['programSha256'],parameters['runnerSha256'],str(parameters['runnerBytes'])]
   values.update(User='root',Group='root',Type='exec',ExitType='cgroup',KillMode='control-group',RuntimeMaxUSec='10min',TimeoutStopUSec='2s',Description='MuCodeSandbox desktop component '+parameters['token']+' '+parameters['programSha256'],ControlGroup='/system.slice/'+self.unit,ExecStart='{ path=/usr/bin/python3 ; argv[]='+' '.join(argv)+' ; ignore_errors=no ; pid=123 ; status=0/0 }')
  values.update(self.override);return values
 def system_run(self,command,**options):
  assert options['stdin']==-3 and options['stderr']==-3 and options['timeout'] in [2,5] and options['env']['LC_ALL']=='C'
  if command==['/usr/bin/systemctl','--version']:return types.SimpleNamespace(returncode=0,stdout=('systemd '+str(self.version)+' (synthetic)\n').encode())
  if command[:3]==['/usr/bin/systemctl','show',self.unit]:
   assert '--all' in command;return types.SimpleNamespace(returncode=0,stdout=('\n'.join(k+'='+v for k,v in self.values().items())+'\n').encode())
  assert command==['/usr/bin/systemctl','--no-ask-password','stop',self.unit],command;self.stops.append(self.unit)
  if self.stop_works:self.active='inactive';self.pid='0';self.populated=self.keep_group
  return types.SimpleNamespace(returncode=0 if self.stop_works else 1,stdout=b'')
 def system_popen(self,command,**options):
  self.starts.append(command);assert command[:8]==['/usr/bin/systemd-run','--quiet','--no-ask-password','--pipe','--wait','--collect','--service-type=exec','--unit='+self.unit]
  for value in ['ExitType=cgroup','KillMode=control-group','RuntimeMaxSec=600','TimeoutStopSec=2','NoNewPrivileges=yes','PrivateNetwork=yes','ProtectHome=yes','ProtectSystem=strict','CapabilityBoundingSet=']:assert '--property='+value in command
  assert options['start_new_session'] is True
  if self.before_start:self.before_start()
  self.loaded=True;self.active='active';self.pid='123';self.group_exists=True;self.populated=True
  try:self.perform('runner')
  except Exception:code=78;output=b''
  else:code=0;output=b'{"version":1,"state":"verified"}\n'
  self.active='inactive' if code==0 else 'failed';self.pid='0';self.populated=self.keep_group
  def communicate(timeout):
   if self.communication_fails and timeout==605:raise RuntimeError('Synthetic client pipe failure')
   return output,b''
  def kill_client():self.client_kills+=1
  return types.SimpleNamespace(returncode=code,communicate=communicate,kill=kill_client)
 def perform(self,mode,asset=None):
  global source
  original=source
  source=(runner_source if mode=='runner' else operations)+'''
def main(asset,mode):
 import types
 global subprocess,payload_main
 test=sys.test_context;subprocess=types.SimpleNamespace(DEVNULL=-3,PIPE=-1,run=test.system_run,Popen=test.system_popen)
 meta=metadata(asset['token'],asset['application'],asset['bootId'],asset['programSha256'],asset['runnerSha256'],asset['runnerBytes'])
 if mode=='reserve':return reserve_task(meta,test.runner)
 if mode=='cancel':return cancel_task(meta)
 if mode=='launch':launch_task(meta);return {'output':sys.stdout.getvalue()}
 if mode=='arm':
  owner=Owner(meta)
  try:owner.verify();owner.mark('attempted')
  finally:owner.close()
  return {'armed':True}
 if mode=='runner':
  payload_main=lambda value:test.payloads.append(value['token'])
  runner_main(meta);return {'executed':True}
 raise AssertionError('Unknown fixture mode')
'''
  self.runner=runner_raw
  try:return self.execute(mode,b'SYNTHETIC FRAME',asset or parameters)
  finally:source=original

def refused(function):
 try:function()
 except Exception:return
 raise AssertionError('Unverified root task authority was accepted')
def prepared(name):
 f=Task(name);assert f.perform('reserve')['phase']=='reserved';return f
f=prepared('fresh');before=(f.folder/'descriptor.json').read_bytes();assert f.perform('reserve')['phase']=='reserved' and (f.folder/'descriptor.json').read_bytes()==before;assert f.perform('launch')['output']=='{"version":1,"state":"verified"}\n';assert len(f.payloads)==1 and len(f.starts)==1;refused(lambda:f.perform('launch'));assert len(f.starts)==1;results.append('reserve-full-launch-idempotent-refusal')
f=prepared('cancel-first');assert f.perform('cancel')['phase']=='cancelled';refused(lambda:f.perform('launch'));assert not f.payloads and not f.starts;results.append('cancel-before-launch-fence')
f=prepared('cancel-race');f.before_start=lambda: f.perform('cancel');refused(lambda:f.perform('launch'));assert not f.payloads and len(f.starts)==1 and not f.stops;results.append('late-unit-cannot-cross-cancel-marker')
f=prepared('active-stop');f.perform('arm');f.loaded=True;f.active='active';f.pid='123';f.group_exists=True;f.populated=True;assert f.perform('cancel')['phase']=='cancelled' and f.stops==[f.unit] and not f.populated;results.append('owned-cgroup-stop-confirmed')
f=prepared('foreign-without-intent');f.loaded=True;f.active='active';f.pid='123';f.group_exists=True;f.populated=True;refused(lambda:f.perform('cancel'));assert not f.stops;results.append('unit-without-own-launch-intent-refused')
for key,value in [('User','dev'),('Group','dev'),('Description','foreign'),('ControlGroup','/system.slice/foreign.service'),('ExecStart','{ path=/bin/false ; argv[]=/bin/false ; }'),('KillMode','process'),('ExitType','main'),('RuntimeMaxUSec','infinity'),('TimeoutStopUSec','90s'),('Id','foreign.service')]:
 f=prepared('foreign-'+key);f.perform('arm');f.loaded=True;f.active='active';f.pid='123';f.group_exists=True;f.populated=True;f.override[key]=value;refused(lambda:f.perform('cancel'));assert not f.stops;results.append('foreign-property-'+key)
f=prepared('group-survives');f.perform('arm');f.loaded=True;f.active='active';f.pid='123';f.group_exists=True;f.populated=True;f.keep_group=True;refused(lambda:f.perform('cancel'));assert f.stops==[f.unit] and f.populated;results.append('main-pid-zero-is-not-empty-group')
f=prepared('boot-changed');f.boot='22345678-1234-4234-8234-123456789abc';refused(lambda:f.perform('cancel'));assert not f.stops and not (f.folder/'cancelled').exists();results.append('different-boot-refused-before-touch')
for name in ['descriptor.json','runner.py']:
 f=prepared('changed-'+name);target=f.folder/name;target.write_bytes(b'KEEP CHANGED DATA');refused(lambda:f.perform('cancel'));assert target.read_bytes()==b'KEEP CHANGED DATA' and not f.stops;results.append('changed-'+name+'-preserved')
f=prepared('hardlink');native.link(f.folder/'runner.py',f.root/'retained-runner');refused(lambda:f.perform('cancel'));assert not f.stops;results.append('hardlinked-runner-refused')
f=prepared('unknown-file');(f.folder/'note.txt').write_bytes(b'KEEP NOTE');refused(lambda:f.perform('launch'));assert not f.starts and (f.folder/'note.txt').read_bytes()==b'KEEP NOTE';results.append('unknown-state-file-preserved')
f=prepared('wrong-marker');(f.folder/'cancelled').write_bytes(b'KEEP BAD MARKER');refused(lambda:f.perform('cancel'));assert not f.stops and (f.folder/'cancelled').read_bytes()==b'KEEP BAD MARKER';results.append('changed-cancel-marker-preserved')
f=prepared('wrong-cgroup');f.perform('arm');f.proc_group='0::/system.slice/foreign.service\n';refused(lambda:f.perform('runner'));assert not f.payloads;results.append('runner-requires-actual-owned-cgroup')
f=Task('old-systemd');f.version=249;refused(lambda:f.perform('reserve'));assert not f.folder.exists();results.append('unsupported-systemd-refused')
f=prepared('client-pipe-failure');f.communication_fails=True;refused(lambda:f.perform('launch'));assert f.client_kills==1 and f.perform('cancel')['phase']=='cancelled';results.append('owned-client-is-reaped-after-pipe-failure')
print(json.dumps(dict(complete=True,checks=results,actualOrdinaryWindowsFiles=True,actualHardLinks=True,posixMetadataDirfdLockAdapters=True,systemdSubprocessAdapter=True,procAndCgroupTextAdapters=True,actualLinux=False,actualSystemd=False,actualHyperV=False,clientExecuted=False,projectAndCredentialSentinelsPreserved=True)))
