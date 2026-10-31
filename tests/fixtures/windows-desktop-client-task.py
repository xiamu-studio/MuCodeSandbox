"""Unchanged client control operations on Windows files; explicit systemd/POSIX/boot adapters.
Never executes sudo, a guest, portal, package tool or target client.
"""
import pathlib,sys,json,types,io,stat,os as native
operations=pathlib.Path(sys.argv[1]).read_text(encoding='utf8');parameters=json.loads(pathlib.Path(sys.argv[3]).read_text(encoding='utf8'));BOOT='12345678-1234-4234-8234-123456789abc'
prefix=pathlib.Path(__file__).with_name('windows-agent-component.py').read_text(encoding='utf8').split('def expect_refused')[0]
prefix=prefix.replace("['stat','json','hashlib','tarfile','re','io']","['stat','json','hashlib','tarfile','re','io','uuid','time','subprocess','signal','pathlib']").replace('stdin=types.SimpleNamespace(buffer=io.BytesIO(raw))','stdin=types.SimpleNamespace(buffer=io.BytesIO(raw)),test_context=self').replace("safe['open']=lambda *a,**k:(_ for _ in ()).throw(AssertionError('Unpinned path operation'))","safe['open']=self.kernel_open")
exec(compile(prefix,'explicit-client-control-adapters','exec'),globals());results=[]
class ClientTask(Fixture):
 def __init__(self,name):
  super().__init__(name);self.boot=BOOT;self.loaded=False;self.active='inactive';self.pid='0';self.populated=False;self.group_exists=False;self.started=[];self.stops=[];self.before_start=None;self.during_prereq=None;self.after_reload=None;self.keep_group=False;self.stop_fails=False;self.override={};self.prereqs=0;self.systemd=255
  (self.root/'run/systemd/system').mkdir(parents=True);(self.root/'etc/apparmor.d').mkdir(parents=True)
  self.members={'2222'};self.starts={'2222':'100'};self.focus_windows='0x0400001 0 2222 localhost Synthetic client\n';self.focus_active='0x0400001';self.focus_actions=[];self.list_hook=None;self.window_reads=0
 @property
 def unit(self):return parameters['unit']
 @property
 def folder(self):return self.root/'run/mucodesandbox/desktop-client-jobs'/parameters['token']
 def kernel_open(self,name,*args,**kwargs):
  assert name=='/proc/sys/kernel/random/boot_id',name;return io.StringIO(self.boot+'\n')
 def values(self):
  value=dict.fromkeys(['LoadState','ActiveState','MainPID','User','Group','ControlGroup','FragmentPath','DropInPaths','KillMode','Type','Description','BindsTo','PartOf'],'')
  value.update(LoadState='loaded' if self.loaded else 'not-found',ActiveState=self.active,MainPID=self.pid)
  if self.loaded:value.update(User='dev',Group='dev',ControlGroup='/system.slice/'+self.unit if self.active=='active' else '',FragmentPath='/run/systemd/system/'+self.unit,KillMode='control-group',Type='exec',Description=parameters['description'],BindsTo='mucodesandbox-display.service',PartOf='mucodesandbox-display.service')
  value.update(self.override);return value
 def system_run(self,args,**options):
  assert options['stdin']==-3 and options['stderr']==-3
  if args[:1]==['/usr/bin/sudo']:
   assert args[:12]==['/usr/bin/sudo','-n','-H','-u','dev','--','/usr/bin/env','-i','HOME=/home/dev','PATH=/usr/bin:/bin','DISPLAY=:99','XAUTHORITY=/run/mu-browser/Xauthority'];assert options['timeout']==2 and options['check'] is True and options['env']=={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'}
   command=args[12:]
   if command==['/usr/bin/wmctrl','-lp']:
    self.window_reads+=1
    if self.list_hook:self.list_hook()
    return types.SimpleNamespace(stdout=self.focus_windows.encode())
   if command==['/usr/bin/xprop','-root','_NET_ACTIVE_WINDOW']:return types.SimpleNamespace(stdout=('_NET_ACTIVE_WINDOW(WINDOW): window id # '+self.focus_active+'\n').encode())
   assert command in [['/usr/bin/wmctrl','-ir','0x0400001','-b','add,maximized_vert,maximized_horz'],['/usr/bin/wmctrl','-ia','0x0400001']],command
   self.focus_actions.append(command);return types.SimpleNamespace(stdout=b'')
  if args==['/usr/bin/systemctl','--version']:return types.SimpleNamespace(returncode=0,stdout=('systemd '+str(self.systemd)+' (synthetic)\n').encode())
  if args[:3]==['/usr/bin/systemctl','show',self.unit]:return types.SimpleNamespace(returncode=0,stdout=('\n'.join(k+'='+v for k,v in self.values().items())+'\n').encode())
  if args==['/usr/bin/systemctl','daemon-reload']:
   self.loaded=(self.root/'run/systemd/system'/self.unit).exists()
   if self.after_reload:self.after_reload()
   return types.SimpleNamespace(returncode=0)
  if args==['/usr/bin/systemctl','--no-ask-password','start',self.unit]:
   if self.before_start:self.before_start()
   # Explicit PID1 ConditionPathExists adapter; not actual systemd acceptance.
   if not (self.folder/'cancelled').exists():self.started.append(self.unit);self.active='active';self.pid='2222';self.populated=True;self.group_exists=True
   return types.SimpleNamespace(returncode=0)
  assert args==['/usr/bin/systemctl','--no-ask-password','stop',self.unit],args;self.stops.append(self.unit)
  if self.stop_fails:raise RuntimeError('Synthetic stop failed')
  self.active='inactive';self.pid='0';self.populated=self.keep_group;return types.SimpleNamespace(returncode=0)
 def prerequisite(self):
  self.prereqs+=1
  if self.during_prereq:self.during_prereq()
 def perform(self,mode):
  global source
  previous=source;source=operations+'''
def main(spec,mode):
 global subprocess,pathlib,client_prerequisites,inspect_client,client_processes,client_start
 test=sys.test_context
 class Path:
  def __init__(self,name):self.name=str(name)
  def __truediv__(self,name):return Path(self.name+'/'+name)
  def read_text(self):
   assert self.name=='/sys/fs/cgroup/system.slice/'+test.unit+'/cgroup.events'
   if not test.group_exists:raise FileNotFoundError(self.name)
   return 'populated '+str(int(test.populated))+'\\nfrozen 0\\n'
 pathlib=type('Paths',(),{'Path':Path});subprocess=type('Process',(),{'run':staticmethod(test.system_run),'DEVNULL':-3,'PIPE':-1});client_prerequisites=lambda spec:test.prerequisite()
 if mode=='publish':
  client_publish('/etc/apparmor.d/client-policy',b'fixed approved policy\\n',spec['token']);return {'published':True}
 if mode=='focus':
  def inspect_client(meta):
   value=client_unit(meta);return dict(state='running' if value['ActiveState']=='active' else 'stopped')
  client_processes=lambda meta:set(test.members)
  client_start=lambda root:test.starts[str(root.name).split('/')[-1]]
  return focus_owned_client(spec,''' + repr(BOOT)+''')
 if mode=='reserve':return reserve_client(spec,''' + repr(BOOT)+''')
 if mode=='launch':return launch_client(spec,''' + repr(BOOT)+''')
 if mode=='cancel':return cancel_client(spec,''' + repr(BOOT)+''')
 if mode=='inspect':
  inspect_client=lambda meta:dict(inspected=True,token=meta['token'])
  return inspect_owned_client(spec,''' + repr(BOOT)+''')
 raise AssertionError('Unknown client control mode')
'''
  try:return self.execute(mode,b'',parameters)
  finally:source=previous
def refused(f,mode):
 try:f.perform(mode)
 except Exception as error:
  assert error.__class__.__name__ in ['Refused','RuntimeError'],type(error)
  return
 raise AssertionError('Unsafe control accepted: '+mode)
def prepared(name):
 f=ClientTask(name);assert f.perform('reserve')['phase']=='reserved';return f
f=prepared('fresh');before=(f.folder/'descriptor.json').read_bytes();assert f.perform('reserve')['phase']=='reserved' and (f.folder/'descriptor.json').read_bytes()==before;assert f.perform('launch')['phase']=='started';assert len(f.started)==1;refused(f,'launch');assert len(f.started)==1;assert f.perform('cancel')['phase']=='cancelled' and not f.populated;results.append('reserve-launch-once-stop')
f=prepared('cancel-first');assert f.perform('cancel')['phase']=='cancelled';assert f.perform('launch')['phase']=='cancelled' and not f.started;results.append('cancel-before-launch')
f=prepared('late-start');f.before_start=lambda:f.perform('cancel');assert f.perform('launch')['phase']=='cancelled' and not f.started;results.append('cancel-fences-late-pid1-start-adapter')
f=ClientTask('cancel-during-verification');f.during_prereq=lambda:f.perform('cancel');assert f.perform('reserve')['phase']=='cancelled' and not (f.root/'run/systemd/system'/f.unit).exists() and not f.started;results.append('cancel-before-unit-publication')
f=ClientTask('cancel-after-reload');f.after_reload=lambda:f.perform('cancel');assert f.perform('reserve')['phase']=='cancelled' and not f.started;results.append('cancel-after-unit-publication')
f=prepared('foreign-without-intent');f.active='active';f.pid='2222';f.populated=True;f.group_exists=True;refused(f,'cancel');assert not f.stops and (f.folder/'cancelled').exists();results.append('foreign-active-without-launch-intent')
for key,value in [('User','root'),('Group','root'),('Description','foreign'),('ControlGroup','/foreign'),('KillMode','process'),('Type','simple'),('FragmentPath','/etc/systemd/system/foreign.service'),('DropInPaths','/run/foreign.conf'),('BindsTo','foreign.service'),('PartOf','foreign.service')]:
 f=prepared('foreign-'+key);f.perform('launch');f.override[key]=value;refused(f,'cancel');assert not f.stops and (f.folder/'cancelled').exists();results.append('foreign-'+key)
for case in ['descriptor.json','launcher','cancelled']:
 f=prepared('changed-'+case);target=f.folder/case;target.write_bytes(b'KEEP UNRECOGNIZED BYTES');refused(f,'cancel');assert target.read_bytes()==b'KEEP UNRECOGNIZED BYTES' and not f.stops;results.append('changed-'+case+'-preserved')
f=prepared('unknown-state');(f.folder/'personal-note').write_bytes(b'KEEP NOTE');refused(f,'launch');assert not f.started and (f.folder/'personal-note').read_bytes()==b'KEEP NOTE';results.append('unknown-job-content-preserved')
f=prepared('group-not-empty');f.perform('launch');f.keep_group=True;refused(f,'cancel');assert f.pid=='0' and f.populated;results.append('main-pid-zero-is-not-stopped')
f=prepared('stop-fails');f.perform('launch');f.stop_fails=True;refused(f,'cancel');assert f.populated;results.append('failed-stop-not-confirmed')
f=prepared('boot-changed');f.boot='22345678-1234-4234-8234-123456789abc';refused(f,'cancel');assert not (f.folder/'cancelled').exists() and not f.stops;results.append('wrong-boot-refused')
f=prepared('hardlink-launcher');native.link(f.folder/'launcher',f.root/'retained-launcher');refused(f,'cancel');assert not f.stops;results.append('hardlinked-launcher-refused')
f=ClientTask('old-systemd');f.systemd=249;refused(f,'reserve');assert not f.folder.exists();results.append('old-systemd-refused')
f=ClientTask('foreign-unit-file');target=f.root/'run/systemd/system'/f.unit;target.write_bytes(b'KEEP FOREIGN UNIT');refused(f,'reserve');assert target.read_bytes()==b'KEEP FOREIGN UNIT' and not f.started;results.append('unknown-unit-not-overwritten')
f=prepared('inspect-bound-boot');assert f.perform('inspect')['inspected'] is True;f.boot='22345678-1234-4234-8234-123456789abc';refused(f,'inspect');results.append('inspect-requires-original-boot-and-registry')
f=prepared('inactive-foreign-group');f.override['ControlGroup']='/foreign';refused(f,'launch');assert not f.started;refused(f,'cancel');assert not f.stops;results.append('foreign-inactive-group-refused-before-start')
f=ClientTask('cancel-before-delayed-reserve');assert f.perform('cancel')['phase']=='cancelled';assert f.perform('reserve')['phase']=='cancelled' and f.prereqs==0 and not f.started;results.append('cancel-tombstone-before-reserve')
for case in ['same','different','mode','owner','hardlink','length','io-error','existing-mode']:
 f=ClientTask('policy-publication-'+case);target=f.root/'etc/apparmor.d/client-policy';raw=b'fixed approved policy\n';original=f.rename
 def competing(parent,src,other,dst,flags):
  if case=='io-error':f.errno=5;return -1
  target.write_bytes(b'foreign policy bytes!\n' if case=='different' else b'x' if case=='length' else raw)
  if case=='mode':f.modes[target]=0o600
  if case=='owner':f.owners[target]=2001
  if case=='hardlink':native.link(target,f.root/'retained-policy')
  return original(parent,src,other,dst,flags)
 f.rename=competing
 if case=='existing-mode':target.write_bytes(raw);f.modes[target]=0o600
 if case=='same':
  assert f.perform('publish')['published'] is True
  assert target.read_bytes()==raw and list(target.parent.iterdir())==[target]
 else:
  try:f.perform('publish')
  except Exception:pass
  else:raise AssertionError('Unverified concurrent policy accepted: '+case)
  if case=='io-error':assert not target.exists()
  else:assert target.read_bytes()==(b'foreign policy bytes!\n' if case=='different' else b'x' if case=='length' else raw)
  if case=='mode' or case=='existing-mode':assert f.modes[target]==0o600
  if case=='owner':assert f.owners[target]==2001
  if case!='existing-mode':assert (target.parent/('.client-policy.'+parameters['token']+'.preparing')).read_bytes()==raw
 results.append('policy-publication-'+case)
for case in ['match','foreign-only','none','cancelled','cancel-during-list','boot-change','pid-reused','members-change','window-gone','malformed-window','not-active','oversize','wrong-unit','root-file-change']:
 f=prepared('focus-'+case);f.perform('launch')
 if case=='foreign-only':f.focus_windows='0x0400002 0 7777 localhost Foreign application\n'
 if case=='none':f.focus_windows=''
 if case=='cancelled':f.perform('cancel')
 if case=='cancel-during-list':f.list_hook=lambda:f.perform('cancel')
 if case=='boot-change':f.list_hook=lambda:setattr(f,'boot','22345678-1234-4234-8234-123456789abc')
 if case=='pid-reused':f.list_hook=lambda:f.starts.update({'2222':'101'})
 if case=='members-change':f.list_hook=lambda:f.members.clear()
 if case=='window-gone':
  def vanished():
   if f.window_reads>1:f.focus_windows=''
  f.list_hook=vanished
 if case=='malformed-window':f.focus_windows='0x0400001;touch 0 2222 localhost Never execute\n'
 if case=='not-active':f.focus_active='0x0400002'
 if case=='oversize':f.focus_windows='x'*262145
 if case=='wrong-unit':f.override['Description']='foreign'
 if case=='root-file-change':(f.folder/'descriptor.json').write_bytes(b'KEEP FOREIGN REGISTRY')
 if case in ['boot-change','malformed-window','oversize','wrong-unit','root-file-change']:refused(f,'focus')
 else:assert f.perform('focus')['focused'] is (case=='match')
 assert len(f.focus_actions)==(2 if case in ['match','not-active'] else 0),(case,f.focus_actions)
 results.append('focus-'+case)
print(json.dumps(dict(complete=True,checks=results,actualOrdinaryWindowsFiles=True,actualHardLinks=True,explicitSystemdConditionPosixBootAdapters=True,actualSystemd=False,actualLinux=False,clientExecuted=False,projectAndCredentialSentinelsPreserved=True)))
