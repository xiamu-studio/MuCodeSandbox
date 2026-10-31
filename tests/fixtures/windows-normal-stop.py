import contextlib,io,json,pathlib,subprocess,sys,time,unittest.mock
program=sys.stdin.read()
checks=[]
for scenario in ['owned-window','already-stopped','no-owned-window','changed-unit','wrong-group','many-windows','timeout','missing-unit']:
 calls=[];closed=False;clock=0;reads=0
 def output(command,**options):
  global reads
  calls.append(command)
  if command[0]=='/usr/bin/systemctl':
   reads+=1
   if scenario=='missing-unit':return ''
   if scenario=='already-stopped' or closed and scenario!='timeout':return 'ActiveState=inactive\nMainPID=0\nControlGroup=\n'
   pid='99' if scenario=='changed-unit' and reads>1 else '42'
   group='/other' if scenario=='wrong-group' else '/system.slice/mucodesandbox-browser.service'
   return f'ActiveState=active\nMainPID={pid}\nControlGroup={group}\n'
  assert command==['/usr/bin/wmctrl','-lp']
  rows=['0x000001 0 999 host unrelated-title-sentinel']
  if scenario!='no-owned-window':rows += [f'0x{index:06x} 0 42 guest private-title-sentinel' for index in range(2,11 if scenario=='many-windows' else 3)]
  return '\n'.join(rows)
 def run(command,**options):
  global closed
  calls.append(command);assert command==['/usr/bin/wmctrl','-ic','0x000002'];assert options['stdout']==subprocess.DEVNULL and options['stderr']==subprocess.DEVNULL;closed=True
 def sleep(_seconds):
  global clock
  clock+=1
 capture=io.StringIO();error=None
 with unittest.mock.patch.object(subprocess,'check_output',output),unittest.mock.patch.object(subprocess,'run',run),unittest.mock.patch.object(pathlib.Path,'read_text',return_value='42\n43\n'),unittest.mock.patch.object(time,'sleep',sleep),unittest.mock.patch.object(time,'monotonic',lambda:clock),contextlib.redirect_stdout(capture):
  try:exec(compile(program,'production-normal-stop','exec'),{})
  except SystemExit as value:assert value.code==0
  except (RuntimeError,TimeoutError) as value:error=value
 assert 'title-sentinel' not in capture.getvalue()
 assert not any(command==['/usr/bin/wmctrl','-ic','0x000001'] for command in calls)
 if scenario in ['owned-window','already-stopped']:
  assert error is None
  assert json.loads(capture.getvalue())=={'version':1,'browser':'closed' if scenario=='owned-window' else 'already-stopped'}
 else:
  assert error is not None
  if scenario!='timeout':assert not closed
 checks.append({'name':scenario,'passed':True})
print(json.dumps({'productionHelper':True,'realGuest':False,'checks':checks}))
