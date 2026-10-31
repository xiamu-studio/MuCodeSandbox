import os,sys,pathlib,hashlib,subprocess,tarfile,shutil,stat,json,io,struct,re,uuid,contextlib,ctypes,types,time

def tar_bytes():
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode='w') as archive:
        for name,data in [('chrome',b'approved synthetic executable'),('chrome-sandbox',b'approved synthetic sandbox'),('resources/a.pak',b'approved synthetic resource'*8192)]:
            item=tarfile.TarInfo('opt/google/chrome/'+name);item.mode=0o755;item.size=len(data);archive.addfile(item,io.BytesIO(data))
    return output.getvalue()

DATA=tar_bytes();VERSION=os.environ.get('MU_BROWSER_REPAIR_FIXTURE_VERSION','155.0.8059.84')
assert VERSION in ['155.0.8059.84','156.0.8078.47']
EXPECTED=dict(version=VERSION,packageVersion=VERSION+'-1',architecture='amd64',bytes=len(DATA),sha256=hashlib.sha256(DATA).hexdigest())

def snapshot(directory,ignore_lock=False):
    return {str(file.relative_to(directory)):hashlib.sha256(file.read_bytes()).hexdigest() for file in directory.rglob('*') if file.is_file() and not(ignore_lock and file==directory/'state/browser-install.lock')}

class FixturePath(type(pathlib.Path())):
    # Actual Windows files and identities; Linux owner/mode metadata is adapted.
    # Windows cannot express the Linux root/setuid/directory-fsync contracts.
    def lstat(self):
        info=super().lstat();values={key:getattr(info,key) for key in dir(info) if key.startswith('st_')}
        mode=0o755 if stat.S_ISDIR(info.st_mode) else 0o644
        if stat.S_ISDIR(info.st_mode) and self.name.startswith(('.browser-repair-prep-','.browser-repair-done-')) or self.name=='.browser-repair':mode=0o700
        if self.name in ['archive.deb','journal.bin','browser-install.lock']:mode=0o600
        if self.name=='chrome-sandbox':mode=0o4755
        if self.name=='chrome':mode=0o755
        kind=stat.S_IFMT(info.st_mode)
        if getattr(info,'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',1024):kind=stat.S_IFLNK
        values['st_mode']=kind|mode;values['st_uid']=0
        return types.SimpleNamespace(**values)

class Decoder:
    def __init__(self):self.stdout=io.BytesIO(DATA);self.done=False
    def wait(self):self.done=True;return 0
    def poll(self):return 0 if self.done else None
    def kill(self):self.done=True

exclusive_rename=__import__('runpy').run_path(str(pathlib.Path(__file__).with_name('windows_exclusive_rename.py')))['exclusive_rename']

def rename_adapter_tests(root):
    import threading
    from ctypes import wintypes
    assert os.name=='nt'
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,wintypes.LPVOID,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
    kernel.CreateFileW.restype=wintypes.HANDLE
    kernel.CloseHandle.argtypes=[wintypes.HANDLE];kernel.CloseHandle.restype=wintypes.BOOL
    def hold(folder):
        handle=kernel.CreateFileW(str(folder),0x80000000,3,None,3,0x02000000,None)
        if handle==ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
        return handle
    checks=[]
    for name in ['released','persistent','destination-appeared']:
        source=root/(name+'-source');target=root/(name+'-target');source.mkdir();(source/'original').write_bytes(b'original bytes')
        handle=hold(source);timer=None
        try:
            try:os.rename(source,target)
            except PermissionError as error:assert error.winerror in (5,32,33)
            else:raise AssertionError('Real Windows handle did not prevent directory rename')
            if name=='released':
                timer=threading.Timer(0.08,lambda:kernel.CloseHandle(handle));timer.start();exclusive_rename(source,target);timer.join();handle=None
                assert not source.exists() and (target/'original').read_bytes()==b'original bytes'
            elif name=='persistent':
                started=time.monotonic()
                try:exclusive_rename(source,target)
                except PermissionError:pass
                else:raise AssertionError('Persistent sharing denial was ignored')
                assert time.monotonic()-started<1 and (source/'original').read_bytes()==b'original bytes' and not target.exists()
            else:
                def appear():target.mkdir();(target/'foreign').write_bytes(b'foreign bytes')
                timer=threading.Timer(0.04,appear);timer.start()
                try:exclusive_rename(source,target)
                except FileExistsError:pass
                else:raise AssertionError('New destination was overwritten')
                timer.join();assert (source/'original').read_bytes()==b'original bytes' and (target/'foreign').read_bytes()==b'foreign bytes'
            checks.append(dict(case=name,passed=True))
        finally:
            if timer:timer.join()
            if handle is not None:kernel.CloseHandle(handle)
    source=root/'identity-source';target=root/'identity-target';source.mkdir();(source/'original').write_bytes(b'original identity bytes')
    actual=source.stat()
    try:exclusive_rename(source,target,(actual.st_dev,actual.st_ino+1))
    except RuntimeError:pass
    else:raise AssertionError('Changed source authority was accepted')
    assert source.exists() and not target.exists() and (source/'original').read_bytes()==b'original identity bytes'
    checks.append(dict(case='original-source-identity-required',passed=True))
    print(json.dumps(dict(complete=True,checks=checks,actualWindowsSharingHandles=True,adapterOnly=True,originalProgramChanged=False)))

def worker():
    directory=pathlib.Path(sys.argv[4]);fault=sys.argv[5];occurrence=int(sys.argv[6]);begin=sys.argv[7]=='begin'
    root=FixturePath(directory/'components');state=FixturePath(directory/'state');target=root/('chrome-'+VERSION);active=root/'.browser-repair'
    def checked(args,text=False,timeout=None):
        if args==['/usr/bin/dpkg','--print-architecture']:return 'amd64\n'
        assert args[:2]==['/usr/bin/dpkg-deb','-f'] and args[-1] in ['Architecture','Version'],args
        return 'amd64\n' if args[-1]=='Architecture' else EXPECTED['packageVersion']+'\n'
    def popen(args,stdout=None):
        assert args[:2]==['/usr/bin/dpkg-deb','--fsys-tarfile'],args
        return Decoder()
    def fstat(fd):
        info=os.fstat(fd);values={key:getattr(info,key) for key in dir(info) if key.startswith('st_')};values['st_uid']=0
        values['st_mode']=stat.S_IFMT(info.st_mode)|0o600;return types.SimpleNamespace(**values)
    os_api=types.SimpleNamespace(**{key:getattr(os,key) for key in dir(os) if not key.startswith('__')})
    os_api.fstat=fstat;os_api.geteuid=lambda:0;os_api.O_NOFOLLOW=getattr(os,'O_NOFOLLOW',0);os_api.O_DIRECTORY=getattr(os,'O_DIRECTORY',0)
    journal_opens=[]
    def fixture_open(file,flags,*args,**kwargs):
        if str(file)==str(active/'journal.bin'):journal_opens.append(str(file))
        return os.open(file,flags|getattr(os,'O_BINARY',0),*args,**kwargs)
    os_api.open=fixture_open
    def fixture_fsync(fd):
        try:os.fsync(fd)
        except OSError as error:
            if os.name!='nt' or error.errno!=9:raise
            # Linux permits fsync of read-only file handles; Windows does not.
    os_api.fsync=fixture_fsync
    namespace=dict(os=os_api,sys=sys,pathlib=types.SimpleNamespace(Path=FixturePath,PurePosixPath=pathlib.PurePosixPath),hashlib=hashlib,subprocess=types.SimpleNamespace(check_output=checked,Popen=popen,PIPE=subprocess.PIPE),tarfile=tarfile,shutil=shutil,stat=stat,json=json,struct=struct,re=re,uuid=uuid,contextlib=contextlib,ctypes=ctypes,ROOT=root,STATE=state,TARGET=target,ACTIVE=active,EXPECTED=EXPECTED)
    namespace['REPAIR_APPROVED_RECIPES']=[dict(EXPECTED,version=version,packageVersion=version+'-1') for version in ['155.0.8059.84','156.0.8078.47']]
    exec(compile(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'),'unchanged-component-package','exec'),namespace)
    exec(compile(pathlib.Path(sys.argv[3]).read_text(encoding='utf-8'),'unchanged-browser-repair','exec'),namespace)
    namespace['repair_sync']=lambda directory:None
    namespace['repair_rename']=exclusive_rename
    class FileLock:
        LOCK_EX=1;LOCK_NB=2
        @staticmethod
        def flock(fd,mode):
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(fd,msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    namespace['fcntl']=FileLock
    stop=[];namespace['windows_stop_browser']=lambda:stop.append('verified-stop-adapter')
    seen={}
    def step(name):
        seen[name]=seen.get(name,0)+1
        if fault==name and seen[name]==occurrence:
            print('FAULT_READY',flush=True)
            while True:time.sleep(1)
    namespace['repair_step']=step
    requested=directory/'expected-pending.json'
    if requested.exists():namespace['REPAIR_EXPECT_PENDING']=json.loads(requested.read_bytes())
    if fault=='candidate-file-prefix':
        def interrupted_copy(source,output):
            output.write(source.read(4));output.flush();os.fsync(output.fileno());step('candidate-file-prefix')
        namespace['shutil']=types.SimpleNamespace(copyfileobj=interrupted_copy)
    try:
        answer=namespace['repair_windows_browser'](io.BytesIO(DATA),begin)
        print(json.dumps(dict(answer=answer,stopped=len(stop),steps=seen)),flush=True)
    except Exception as error:
        import traceback
        print(json.dumps(dict(error=type(error).__name__,message=str(error),trace=traceback.format_exc(),activeJournalOpens=len(journal_opens),stopped=len(stop))),flush=True);raise SystemExit(2)

def run(directory,fault='',occurrence=1,begin=True):
    command=[sys.executable,'-I',__file__,'worker',sys.argv[1],sys.argv[2],str(directory),fault,str(occurrence),'begin' if begin else 'resume']
    # Exact production program executes in a separate process for every resume.
    process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    output=[];killed=False
    for line in process.stdout:
        if line.strip()=='FAULT_READY':
            process.kill();killed=True;break
        output.append(line)
    tail,errors=process.communicate(timeout=20);output.append(tail)
    if fault:
        assert killed,(fault,output,errors)
        assert process.returncode!=0
        return dict(killed=True,code=process.returncode)
    try:result=json.loads(''.join(output).strip())
    except Exception:raise AssertionError((output,errors,process.returncode))
    return dict(code=process.returncode,**result)

def prepare(root,name,with_old=True):
    directory=root/name;directory.mkdir();components=directory/'components';components.mkdir();profile=directory/'profile';profile.mkdir();(profile/'website.db').write_bytes(b'user profile retained');(profile/'project.txt').write_bytes(b'user project retained')
    if VERSION!='155.0.8059.84':(components/'browser-selection.json').write_text(json.dumps(dict(schema=1,version=VERSION,archiveSha256=EXPECTED['sha256'])))
    if with_old:
        old=components/('chrome-'+VERSION);old.mkdir();(old/'corrupted-old-browser').write_bytes(b'original component is preserved, even when corrupt')
    return directory,snapshot(profile)

def assert_finished(directory,before,with_old=True):
    assert snapshot(directory/'profile')==before
    components=directory/'components';target=components/('chrome-'+VERSION)
    assert (target/'chrome').read_bytes()==b'approved synthetic executable'
    assert not (components/'.browser-repair').exists()
    receipts=list(components.glob('.browser-repair-done-*'));assert len(receipts)==1
    assert {entry.name for entry in receipts[0].iterdir()}=={'journal.bin'}
    retained=list(components.glob('.browser-component-retained-*'));assert len(retained)==int(with_old)
    if with_old:assert (retained[0]/'corrupted-old-browser').read_bytes()==b'original component is preserved, even when corrupt'

if len(sys.argv)>1 and sys.argv[1]=='rename-adapter-test':rename_adapter_tests(pathlib.Path(sys.argv[2]));raise SystemExit(0)
if len(sys.argv)>1 and sys.argv[1]=='worker':worker();raise SystemExit(0)
root=pathlib.Path(sys.argv[3]);results=[]
if os.environ.get('MU_BROWSER_REPAIR_FIXTURE_POLICY_ONLY')=='1':
    assert VERSION=='156.0.8078.47'
    for case in ['missing-selection','changed-selection','pending-absent','pending-unexpected','pending-wrong','pending-matching','other-version-receipt','foreign-receipt']:
        directory,before=prepare(root,case);components=directory/'components';requested=directory/'expected-pending.json';kills=case in ['pending-unexpected','pending-wrong','pending-matching']
        if case in ['other-version-receipt','foreign-receipt']:
            receipt=components/('.browser-repair-done-'+'0'*32);receipt.mkdir();journal=receipt/'journal.bin';journal.write_bytes(b'\0'*16384);(receipt/'archive.deb').write_bytes(b'Unrelated old receipt archive preserved')
            identity=lambda file:[str(file.stat().st_dev),str(file.stat().st_ino)]
            recipe=dict(EXPECTED,version='155.0.8059.84' if case=='other-version-receipt' else '157.0.0.0',packageVersion='155.0.8059.84-1' if case=='other-version-receipt' else '157.0.0.0-1')
            data=dict(schema=1,epoch='0'*32,root=identity(components),slot=identity(receipt),journal=identity(journal),archive=['1','2'],candidate=['1','3'],old=None,recipe=recipe,phase='published');raw=json.dumps(data,sort_keys=True,separators=(',',':')).encode();journal.write_bytes(struct.pack('>8sQQ32s',b'MUCRP001',1,len(raw),hashlib.sha256(raw).digest())+raw+b'\0'*(16384-56-len(raw)))
            if case=='other-version-receipt':assert run(directory)['code']==0
            # A first ordinary recovery may create only its known empty lock.
            # Every other original or newly appearing byte remains compared.
            unchanged=snapshot(directory,True);answer=run(directory,begin=False);assert answer['code']==(0 if case=='other-version-receipt' else 2),(case,answer);assert snapshot(directory,True)==unchanged,(case,'foreign receipt bytes changed');assert (directory/'state/browser-install.lock').read_bytes()==b'';assert snapshot(directory/'profile')==before
            if case=='other-version-receipt':assert answer['answer']==dict(state='none') and (components/('chrome-'+VERSION)/'chrome').read_bytes()==b'approved synthetic executable'
            results.append(dict(case=case,passed=True,profilePreserved=True,unknownReceiptBytesPreserved=True,otherApprovedRecipeSkipped=case=='other-version-receipt'));continue
        if kills:run(directory,'active-published')
        if case=='missing-selection':(components/'browser-selection.json').unlink()
        elif case=='changed-selection':(components/'browser-selection.json').write_text(json.dumps(dict(schema=1,version='155.0.8059.84',archiveSha256=EXPECTED['sha256'])))
        elif case=='pending-absent':requested.write_text(json.dumps('f'*32))
        elif case=='pending-unexpected':requested.write_text('null')
        elif case=='pending-wrong':requested.write_text(json.dumps('f'*32))
        elif case=='pending-matching':
            raw=(components/'.browser-repair/journal.bin').read_bytes();size=struct.unpack('>8sQQ32s',raw[:56])[2];epoch=json.loads(raw[56:56+size])['epoch'];requested.write_text(json.dumps(epoch))
        unchanged=snapshot(components);answer=run(directory,begin=case!='pending-matching');success=case=='pending-matching'
        assert answer['code']==(0 if success else 2),(case,answer)
        if success:assert_finished(directory,before)
        else:
            assert snapshot(components)==unchanged and snapshot(directory/'profile')==before;assert answer['stopped']==0
            if case in ['missing-selection','changed-selection']:assert not (directory/'state').exists()
        results.append(dict(case=case,passed=True,profilePreserved=True,refused=not success,realProcessKill=kills))
    print(json.dumps(dict(complete=True,version=VERSION,checks=results,realProcessKills=3,actualFiles=True,syntheticRecipe=True,rootMutationEpochPinned=True,realLinux=False,realVm=False)));raise SystemExit(0)
for label,point,count in [('initial-frame-torn','journal-half-written',1),('initial-plan-durable','initialization-durable',1),('active','active-published',1),('archive-prefix','archive-prefix-written',1),('archive-frame-torn','journal-half-written',2),('archive-ready','archive-ready',1),('candidate-prefix','candidate-file-prefix',1),('candidate-extracted','candidate-extracted',1),('candidate-frame-torn','journal-half-written',3),('candidate-prepared','candidate-prepared',1),('old-retained','old-component-retained',1),('new-published','new-component-published',1),('published-frame-torn','journal-half-written',4),('publication-durable','publication-durable',1),('receipt-published','receipt-published',1)]:
    directory,before=prepare(root,label);interrupted=run(directory,point,count);resumed=run(directory,begin=not (directory/'components/.browser-repair').exists() and point!='receipt-published')
    assert resumed['code']==0,(label,resumed)
    assert resumed['answer']['state']=='repaired',(label,resumed)
    assert_finished(directory,before)
    results.append(dict(case=label,passed=True,realProcessKill=interrupted['killed'],freshProcessResume=True,profilePreserved=True,previousComponentRetained=True))

for label,mutation in [('unknown-candidate','unknown'),('changed-candidate','changed'),('replaced-candidate','replace'),('candidate-hardlink','hardlink'),('unknown-slot-file','slot'),('replaced-archive','archive'),('both-journal-frames-corrupt','journal'),('foreign-target','target')]:
    directory,before=prepare(root,label);run(directory,'candidate-prepared');slot=directory/'components/.browser-repair';candidate=slot/'candidate'
    if mutation=='unknown':(candidate/'foreign.txt').write_bytes(b'unknown user bytes')
    elif mutation=='changed':(candidate/'chrome').write_bytes(b'unknown changed bytes')
    elif mutation=='replace':os.rename(candidate,directory/'candidate-retained');candidate.mkdir()
    elif mutation=='hardlink':os.link(candidate/'chrome',directory/'hardlink-retained')
    elif mutation=='slot':(slot/'foreign.txt').write_bytes(b'unknown user bytes')
    elif mutation=='archive':os.rename(slot/'archive.deb',directory/'archive-retained');(slot/'archive.deb').write_bytes(DATA)
    elif mutation=='journal':(slot/'journal.bin').write_bytes(b'x'*16384)
    elif mutation=='target':os.rename(directory/'components'/('chrome-'+VERSION),directory/'original-retained');(directory/'components'/('chrome-'+VERSION)).mkdir()
    unchanged=snapshot(directory);refused=run(directory)
    assert refused['code']==2,(label,refused)
    assert snapshot(directory)==unchanged,(label,'refusal changed bytes')
    assert snapshot(directory/'profile')==before
    results.append(dict(case=label,passed=True,refused=True,allBytesPreserved=True,profilePreserved=True))

directory,before=prepare(root,'without-old',False);answer=run(directory);assert answer['code']==0,answer;assert_finished(directory,before,False);results.append(dict(case='without-old',passed=True,profilePreserved=True))
directory,before=prepare(root,'reset-conflict');(directory/'state').mkdir();(directory/'state/browser-reset.json').write_bytes(b'durable reset intent');unchanged=snapshot(directory);answer=run(directory);assert answer['code']==2 and snapshot(directory)==unchanged;results.append(dict(case='reset-conflict',passed=True,allBytesPreserved=True,profilePreserved=True))
directory,before=prepare(root,'legacy-install-conflict');(directory/'state').mkdir();(directory/'state/browser-install-transaction.json').write_bytes(b'legacy ARM64 transaction preserved');unchanged=snapshot(directory);answer=run(directory);assert answer['code']==2 and snapshot(directory)==unchanged;results.append(dict(case='legacy-install-conflict',passed=True,allBytesPreserved=True,profilePreserved=True))
directory,before=prepare(root,'receipt-unknown-cache');run(directory,'receipt-published');receipt=next((directory/'components').glob('.browser-repair-done-*'));(receipt/'unclaimed.txt').write_bytes(b'unknown bytes retained');unchanged=snapshot(directory);answer=run(directory,begin=False);assert answer['code']==0 and answer['answer']['cleanupWarning'] is True and snapshot(directory)==unchanged;results.append(dict(case='receipt-unknown-cache',passed=True,committedWithCleanupWarning=True,allBytesPreserved=True,profilePreserved=True))
directory,before=prepare(root,'retention-quota');assert run(directory)['code']==0;assert run(directory)['code']==0;unchanged=snapshot(directory);assert run(directory)['code']==2 and snapshot(directory)==unchanged;assert snapshot(directory/'profile')==before;results.append(dict(case='retention-quota',passed=True,allBytesPreserved=True,profilePreserved=True))
directory,before=prepare(root,'kernel-lock-contention');process=subprocess.Popen([sys.executable,'-I',__file__,'worker',sys.argv[1],sys.argv[2],str(directory),'active-published','1','begin'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
    assert process.stdout.readline().strip()=='FAULT_READY';unchanged=snapshot(directory,True);answer=run(directory);assert answer['code']==2 and snapshot(directory,True)==unchanged,answer
finally:process.kill();process.communicate(timeout=20)
assert (directory/'state/browser-install.lock').read_bytes()==b'';assert run(directory)['code']==0;assert_finished(directory,before);results.append(dict(case='kernel-lock-contention',passed=True,actualConcurrentProcesses=True,profilePreserved=True))
directory,before=prepare(root,'journal-parent-link');run(directory,'candidate-prepared');active=directory/'components/.browser-repair';retained=directory/'unclaimed-active';os.rename(active,retained)
if os.name=='nt':
    quote=lambda value:"'"+str(value).replace("'","''")+"'"
    subprocess.run([str(pathlib.Path(os.environ.get('SystemRoot',r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'),'-NoProfile','-NonInteractive','-Command',"New-Item -ItemType Junction -Path "+quote(active)+" -Target "+quote(retained)+" -ErrorAction Stop | Out-Null"],check=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
else:os.symlink(retained,active,target_is_directory=True)
unchanged=snapshot(directory);answer=run(directory);assert answer['code']==2 and answer['activeJournalOpens']==0,answer;assert snapshot(directory)==unchanged and snapshot(directory/'profile')==before;results.append(dict(case='journal-parent-link',passed=True,actualDirectoryLink=True,journalNeverOpened=True,allBytesPreserved=True,profilePreserved=True))
print(json.dumps(dict(complete=True,version=VERSION,checks=results,realProcessKills=18,actualFiles=True,actualHardlinks=True,actualDirectoryLink=True,actualFileFsync=True,actualKernelFileLock=True,actualKernelLockContention=True,linuxOwnerModeAndDirectorySyncAdapter=True,linuxReadonlyFsyncAdapter=os.name=='nt',exclusiveRenameAdapter=True,serviceStopAdapter=True,decoderAdapter=True,syntheticRecipe=True,realDebPackage=False,realLinux=False,realVm=False)))
