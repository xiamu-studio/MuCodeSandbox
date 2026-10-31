import {WINDOWS_CHROME} from './browser-assets.ts';
import {WINDOWS_BROWSER_RELEASES,approvedWindowsBrowserRelease,windowsBrowserReleaseRoot} from './browser-releases.ts';
import {WINDOWS_COMPONENT_PACKAGE_PYTHON} from './component-package.ts';
import {WINDOWS_BROWSER_RESET_HELPERS} from './browser-reset.ts';
import {AppError} from '../../errors.ts';

// This fence is read even when recovery remains disabled. An interrupted
// component publication must be resolved before the ordinary launcher runs.
export const WINDOWS_BROWSER_REPAIR_STATE_PYTHON=String.raw`import os,pathlib,stat
root=pathlib.Path('/opt/mucodesandbox/windows');current=pathlib.Path('/')
for part in root.parts[1:]:
 current=current/part
 try:info=current.lstat()
 except FileNotFoundError:print('none');raise SystemExit(0)
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('Unsafe browser component parent')
if os.path.lexists(root/'.browser-adoption'):raise RuntimeError('Browser version adoption needs recovery first')
print('pending' if os.path.lexists(root/'.browser-repair') else 'none')
`;

export function windowsBrowserRepairState(source:string):'none'|'pending'{const value=source.trim();if(value==='none'||value==='pending')return value;throw new AppError('无法核对浏览器组件恢复状态，请保持浏览器关闭',409,'BROWSER_REPAIR_STATE_INVALID');}

// Fixed Windows AMD64 component paths only. Neither profile nor project data
// is a transaction destination. All mutations run under the reset/install lock.
export const WINDOWS_BROWSER_REPAIR_PYTHON=String.raw`
REPAIR_SLOT_BYTES=8192
REPAIR_LABEL=globals().get('REPAIR_LABEL','.browser-repair')
REPAIR_RETAINED=globals().get('REPAIR_RETAINED','.browser-component-retained')
REPAIR_NEW_ONLY=globals().get('REPAIR_NEW_ONLY',False)
REPAIR_STOP_BROWSER=globals().get('REPAIR_STOP_BROWSER',True)
REPAIR_KEEP_ARCHIVE=globals().get('REPAIR_KEEP_ARCHIVE',False)
REPAIR_BASE_VERSION=${JSON.stringify(WINDOWS_CHROME.version)}

def repair_step(name):
    if name in ['active-published','archive-ready','candidate-prepared','new-component-published','publication-durable','receipt-published']:
        print('MU_WINDOWS_BROWSER_REPAIR '+name,flush=True)

def repair_write_all(fd,raw):
    pending=memoryview(raw)
    while pending:
        written=os.write(fd,pending)
        if written<1:raise RuntimeError('Component repair write made no progress')
        pending=pending[written:]

def repair_identity(info):return [str(info.st_dev),str(info.st_ino)]

def repair_sync(directory):
    fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)

def repair_directory(path,create=False,private=False):
    current=pathlib.Path(path.anchor)
    for part in path.parts[1:]:
        current=current/part
        if create:
            try:current.mkdir(mode=0o700 if current==path and private else 0o755);repair_sync(current.parent)
            except FileExistsError:pass
        info=current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise RuntimeError('Unsafe component repair directory')
    if private and stat.S_IMODE(info.st_mode)!=0o700:raise RuntimeError('Component repair directory is not private')
    return repair_identity(info)

def repair_object(path,kind,bound=None):
    info=path.lstat()
    if (kind=='directory' and not stat.S_ISDIR(info.st_mode) or kind=='file' and (not stat.S_ISREG(info.st_mode) or info.st_nlink!=1)) or info.st_uid!=0 or info.st_mode&0o022:
        raise RuntimeError('Unsafe component repair object')
    identity=repair_identity(info)
    if bound is not None and identity!=bound:raise RuntimeError('Component repair object was replaced')
    return identity

def repair_present(path):return os.path.lexists(path)

def repair_rename(source,destination):
    # Publication must never overwrite a destination discovered after planning.
    libc=ctypes.CDLL(None,use_errno=True)
    if not hasattr(libc,'renameat2'):raise RuntimeError('Exclusive component rename is unavailable')
    result=libc.renameat2(-100,os.fsencode(source),-100,os.fsencode(destination),1)
    if result!=0:raise OSError(ctypes.get_errno(),'Exclusive component rename failed')
    repair_sync(source.parent)
    if source.parent!=destination.parent:repair_sync(destination.parent)

def repair_frame(data,sequence):
    payload=json.dumps(data,sort_keys=True,separators=(',',':')).encode()
    if len(payload)>REPAIR_SLOT_BYTES-56:raise RuntimeError('Component repair journal exceeds its bound')
    return struct.pack('>8sQQ32s',b'MUCRP001',sequence,len(payload),hashlib.sha256(payload).digest())+payload+b'\0'*(REPAIR_SLOT_BYTES-56-len(payload))

def repair_pairs(items):
    value={}
    for key,item in items:
        if key in value:raise ValueError('Duplicate component repair field')
        value[key]=item
    return value

def repair_decode(raw):
    if len(raw)!=REPAIR_SLOT_BYTES:return None
    magic,sequence,size,digest=struct.unpack('>8sQQ32s',raw[:56])
    if magic!=b'MUCRP001' or sequence<1 or size>REPAIR_SLOT_BYTES-56:return None
    payload=raw[56:56+size]
    if hashlib.sha256(payload).digest()!=digest or any(raw[56+size:]):return None
    try:return sequence,json.loads(payload,object_pairs_hook=repair_pairs)
    except (UnicodeDecodeError,ValueError):return None

def repair_record(folder,allow_other_recipe=False):
    # Reject an unknown parent link before opening even a bounded journal.
    repair_directory(folder,private=True)
    journal=folder/'journal.bin';identity=repair_object(journal,'file')
    fd=os.open(journal,os.O_RDONLY|os.O_NOFOLLOW|getattr(os,'O_NONBLOCK',0))
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_nlink!=1 or repair_identity(info)!=identity or info.st_size!=REPAIR_SLOT_BYTES*2:raise RuntimeError('Component repair journal size changed')
        raw=os.read(fd,REPAIR_SLOT_BYTES*2)
        after=os.fstat(fd)
        stamp=lambda item:(item.st_dev,item.st_ino,item.st_mode,item.st_uid,item.st_nlink,item.st_size,item.st_mtime_ns,item.st_ctime_ns)
        if len(raw)!=info.st_size or stamp(info)!=stamp(after) or repair_object(journal,'file')!=identity:raise RuntimeError('Component repair journal changed during read')
    finally:os.close(fd)
    rows=[row for row in [repair_decode(raw[:REPAIR_SLOT_BYTES]),repair_decode(raw[REPAIR_SLOT_BYTES:])] if row is not None]
    if not rows:raise RuntimeError('No valid component repair journal frame')
    rows.sort(key=lambda row:row[0])
    if len(rows)==2 and (rows[1][0]!=rows[0][0]+1 or any(rows[0][1].get(key)!=rows[1][1].get(key) for key in ['epoch','root','slot','journal','archive','candidate','old','recipe'])):
        raise RuntimeError('Component repair journal frames disagree')
    sequence,data=rows[-1]
    fields={'schema','epoch','root','slot','journal','archive','candidate','old','recipe','phase'}
    recipes=globals().get('REPAIR_APPROVED_RECIPES',[EXPECTED]) if allow_other_recipe else [EXPECTED]
    if not isinstance(data,dict) or set(data)!=fields or type(data['schema']) is not int or data['schema']!=1 or not isinstance(data['epoch'],str) or not re.fullmatch('[a-f0-9]{32}',data['epoch']) or data['recipe'] not in recipes or data['phase'] not in ['receiving','archive-ready','prepared','published']:
        raise RuntimeError('Invalid component repair journal')
    for key in ['root','slot','journal','archive','candidate','old']:
        value=data[key]
        if key=='old' and value is None:continue
        if not isinstance(value,list) or len(value)!=2 or any(not isinstance(v,str) or not re.fullmatch('[0-9]{1,40}',v) for v in value):raise RuntimeError('Invalid component repair identity')
    if REPAIR_NEW_ONLY and data['old'] is not None:raise RuntimeError('Candidate preparation cannot replace an existing component')
    if data['root']!=repair_directory(ROOT) or data['slot']!=repair_directory(folder,private=True) or data['journal']!=repair_identity(info):raise RuntimeError('Component repair journal binding changed')
    return sequence,data

def repair_write(folder,sequence,data):
    repair_object(folder/'journal.bin','file',data['journal'])
    fd=os.open(folder/'journal.bin',os.O_RDWR|os.O_NOFOLLOW)
    try:
        if repair_identity(os.fstat(fd))!=data['journal']:raise RuntimeError('Component repair journal handle changed')
        raw=repair_frame(data,sequence);os.lseek(fd,((sequence-1)%2)*REPAIR_SLOT_BYTES,os.SEEK_SET)
        # A torn newer frame leaves the previous complete frame readable.
        repair_write_all(fd,raw[:64]);repair_step('journal-half-written');repair_write_all(fd,raw[64:]);os.fsync(fd)
    finally:os.close(fd)
    repair_step('journal-durable')

def repair_preflight():
    if os.geteuid()!=0:raise RuntimeError('Component repair requires root')
    selection=ROOT/'browser-selection.json'
    if repair_present(ROOT):repair_directory(ROOT)
    if not REPAIR_NEW_ONLY and not repair_present(selection) and EXPECTED['version']!=REPAIR_BASE_VERSION:raise RuntimeError('Missing selection cannot authorize a different browser component')
    if repair_present(ROOT/'.browser-adoption') and not globals().get('REPAIR_ADOPTION_OWNER',False):raise RuntimeError('Browser version adoption needs recovery first')
    if not REPAIR_NEW_ONLY and repair_present(selection):
        identity=repair_object(selection,'file');fd=os.open(selection,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            before=os.fstat(fd)
            if repair_identity(before)!=identity or not 0<before.st_size<=4096:raise RuntimeError('Browser selection cannot be verified before component repair')
            raw=os.read(fd,4097);after=os.fstat(fd)
            if len(raw)!=before.st_size or (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns) or repair_object(selection,'file')!=identity:raise RuntimeError('Browser selection changed before component repair')
            def pairs(items):
                value={}
                for key,item in items:
                    if key in value:raise RuntimeError('Duplicate browser selection field')
                    value[key]=item
                return value
            value=json.loads(raw.decode('utf-8'),object_pairs_hook=pairs)
            if not isinstance(value,dict) or set(value)!={'schema','version','archiveSha256'} or type(value['schema']) is not int or value['schema']!=1 or value['version']!=EXPECTED['version'] or value['archiveSha256']!=EXPECTED['sha256']:raise RuntimeError('Selected browser needs its matching component repair; in-place downgrade refused')
        finally:os.close(fd)
    repair_directory(ROOT,create=True);repair_directory(STATE,create=True)
    for name in ['browser-reset.json','browser-reset','browser-install-transaction.json','browser-upgrade.json','browser-upgrade','browser-install']:
        if repair_present(STATE/name):raise RuntimeError('Another browser transaction needs recovery first')
    if subprocess.check_output(['/usr/bin/dpkg','--print-architecture'],text=True,timeout=10).strip()!='amd64':raise RuntimeError('Component repair requires AMD64')

@contextlib.contextmanager
def repair_lock():
    repair_preflight();fd=os.open(STATE/'browser-install.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_nlink!=1:raise RuntimeError('Unsafe browser component lock')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        # Reset uses the same lock; recheck its durable intent after acquiring it.
        repair_preflight();yield fd
    finally:os.close(fd)

def repair_initialize():
    histories=set()
    for entry in ROOT.iterdir():
        for prefix in [REPAIR_LABEL+'-done-',REPAIR_LABEL+'-prep-',REPAIR_RETAINED+'-']:
            if entry.name.startswith(prefix):histories.add(entry.name[len(prefix):])
    if len(histories)>=2:raise RuntimeError('Retained component repair data needs review before another repair')
    old=repair_object(TARGET,'directory') if repair_present(TARGET) else None
    if REPAIR_NEW_ONLY and old is not None:raise RuntimeError('Candidate path already exists; use its recorded preparation')
    epoch=uuid.uuid4().hex;folder=ROOT/(REPAIR_LABEL+'-prep-'+epoch);folder.mkdir(mode=0o700);repair_sync(ROOT)
    (folder/'candidate').mkdir(mode=0o755)
    for name,size in [('archive.deb',0),('journal.bin',REPAIR_SLOT_BYTES*2)]:
        fd=os.open(folder/name,os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_NOFOLLOW,0o600)
        try:os.ftruncate(fd,size);os.fsync(fd)
        finally:os.close(fd)
    data=dict(schema=1,epoch=epoch,root=repair_directory(ROOT),slot=repair_directory(folder,private=True),journal=repair_object(folder/'journal.bin','file'),archive=repair_object(folder/'archive.deb','file'),candidate=repair_object(folder/'candidate','directory'),old=old,recipe=EXPECTED,phase='receiving')
    repair_write(folder,1,data);repair_sync(folder);repair_step('initialization-durable')
    repair_rename(folder,ACTIVE);repair_step('active-published');return 1,data

def repair_inventory(folder):
    if {entry.name for entry in folder.iterdir()}-{'journal.bin','archive.deb','candidate'}:raise RuntimeError('Unknown component repair files preserved')

def repair_receive(folder,data,source):
    archive=folder/'archive.deb';repair_object(archive,'file',data['archive'])
    fd=os.open(archive,os.O_RDWR|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        if repair_identity(info)!=data['archive'] or info.st_size>EXPECTED['bytes']:raise RuntimeError('Component archive identity or size changed')
        existing=info.st_size;size=0;digest=hashlib.sha256()
        while True:
            block=source.read(min(65536,EXPECTED['bytes']+1-size))
            if not block:break
            size+=len(block)
            if size>EXPECTED['bytes']:raise RuntimeError('Component archive exceeds its bound')
            digest.update(block);check=min(existing,len(block))
            if check and os.read(fd,check)!=block[:check]:raise RuntimeError('Interrupted component archive prefix changed')
            existing-=check
            if check<len(block):
                repair_write_all(fd,block[check:])
            repair_step('archive-prefix-written')
        if existing or size!=EXPECTED['bytes'] or digest.hexdigest()!=EXPECTED['sha256']:raise RuntimeError('Component archive is incomplete or changed')
        os.fsync(fd)
    finally:os.close(fd)
    component_archive(archive,EXPECTED,'chrome')

def repair_clear_candidate(folder,data):
    candidate=folder/'candidate';repair_object(candidate,'directory',data['candidate'])
    if not any(candidate.iterdir()):return
    verify_windows_component(folder/'archive.deb',candidate,EXPECTED,'chrome',partial=True)
    # Only archive-matching prefixes and the generated record are disposable.
    # Snapshot all identities before removing any file; never follow links.
    files=[];directories=[]
    for base,dirs,names in os.walk(candidate,topdown=False,followlinks=False):
        for name in names:
            file=pathlib.Path(base)/name;files.append((file,repair_object(file,'file')))
        for name in dirs:
            directory=pathlib.Path(base)/name;directories.append((directory,repair_object(directory,'directory')))
    for file,identity in files:
        repair_object(file,'file',identity);file.unlink();repair_step('candidate-prefix-removed')
    for directory,identity in directories:
        repair_object(directory,'directory',identity);directory.rmdir()
    repair_sync(candidate)

def repair_verify_tree(archive,candidate):
    verify_windows_component(archive,candidate,EXPECTED,'chrome')
    for base,dirs,files in os.walk(candidate,topdown=False,followlinks=False):
        for name in files:
            file=pathlib.Path(base)/name;repair_object(file,'file')
            fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
            try:os.fsync(fd)
            finally:os.close(fd)
        for name in dirs:repair_object(pathlib.Path(base)/name,'directory')
        repair_sync(pathlib.Path(base))
    if stat.S_IMODE((candidate/'chrome').lstat().st_mode)!=0o755 or stat.S_IMODE((candidate/'chrome-sandbox').lstat().st_mode)!=0o4755:raise RuntimeError('Browser executable permissions changed')

def repair_publish(folder,data):
    candidate=folder/'candidate';retained=ROOT/(REPAIR_RETAINED+'-'+data['epoch'])
    new_at_target=repair_present(TARGET) and repair_object(TARGET,'directory')==data['candidate']
    if new_at_target:
        if repair_present(candidate):raise RuntimeError('Both browser component locations exist')
    else:
        repair_object(candidate,'directory',data['candidate']);repair_verify_tree(folder/'archive.deb',candidate)
        if repair_present(TARGET):
            if data['old'] is None or repair_present(retained):raise RuntimeError('Unexpected browser component destination')
            repair_object(TARGET,'directory',data['old']);repair_rename(TARGET,retained);repair_step('old-component-retained')
        if data['old'] is not None:repair_object(retained,'directory',data['old'])
        elif repair_present(retained):raise RuntimeError('Unexpected retained browser component')
        repair_rename(candidate,TARGET);repair_step('new-component-published')
    if data['old'] is not None:repair_object(retained,'directory',data['old'])
    elif repair_present(retained):raise RuntimeError('Unexpected retained browser component')
    repair_verify_tree(folder/'archive.deb',TARGET)

def repair_cleanup(folder,data):
    # Publication already committed. Cleanup failure is a retained-cache warning,
    # never permission to remove an unknown object or roll back profile data.
    try:
        repair_inventory(folder);archive=folder/'archive.deb'
        if repair_present(archive):
            repair_object(archive,'file',data['archive'])
            if archive.lstat().st_size!=EXPECTED['bytes'] or component_digest(archive)!=EXPECTED['sha256']:raise RuntimeError('Published component cache changed')
            if not REPAIR_KEEP_ARCHIVE:archive.unlink();repair_sync(folder)
        if {entry.name for entry in folder.iterdir()}!=({'journal.bin','archive.deb'} if REPAIR_KEEP_ARCHIVE else {'journal.bin'}):raise RuntimeError('Unexpected completed component repair inventory')
        return False
    except (OSError,RuntimeError):return True

def repair_windows_browser(source,begin=True):
    with repair_lock():
        if 'REPAIR_EXPECT_PENDING' in globals():
            expected=REPAIR_EXPECT_PENDING
            if expected is None:
                if repair_present(ACTIVE):raise RuntimeError('Another component repair appeared after observation')
            else:
                if not repair_present(ACTIVE):raise RuntimeError('Observed component repair is no longer active')
                _,observed=repair_record(ACTIVE)
                if observed['epoch']!=expected:raise RuntimeError('Component repair transaction changed after observation')
        if repair_present(ACTIVE):sequence,data=repair_record(ACTIVE)
        elif begin:sequence,data=repair_initialize()
        else:
            # A kill after the receipt rename can leave only the known public
            # archive cache. Its recorded identity and digest still guard cleanup.
            for folder in ROOT.iterdir():
                if not re.fullmatch(re.escape(REPAIR_LABEL)+r'-done-[a-f0-9]{32}',folder.name):continue
                _,completed=repair_record(folder,True)
                if completed['phase']!='published':raise RuntimeError('Incomplete component repair receipt')
                if completed['recipe']!=EXPECTED:continue
                if not repair_present(TARGET) or repair_object(TARGET,'directory')!=completed['candidate']:continue
                if repair_present(folder/'archive.deb'):
                    repair_object(folder/'archive.deb','file',completed['archive']);repair_verify_tree(folder/'archive.deb',TARGET)
                    return dict(state='repaired',version=EXPECTED['version'],retainedPrevious=completed['old'] is not None,cleanupWarning=repair_cleanup(folder,completed))
            return dict(state='none')
        repair_inventory(ACTIVE)
        if REPAIR_STOP_BROWSER:windows_stop_browser()
        archive=ACTIVE/'archive.deb'
        if data['phase']=='receiving':
            repair_receive(ACTIVE,data,source);data['phase']='archive-ready';sequence+=1;repair_write(ACTIVE,sequence,data);repair_step('archive-ready')
        if data['phase']=='archive-ready':
            repair_object(archive,'file',data['archive']);component_archive(archive,EXPECTED,'chrome')
            repair_clear_candidate(ACTIVE,data);extract_windows_component(archive,ACTIVE/'candidate',EXPECTED,'chrome');repair_step('candidate-extracted')
            repair_verify_tree(archive,ACTIVE/'candidate');data['phase']='prepared';sequence+=1;repair_write(ACTIVE,sequence,data);repair_step('candidate-prepared')
        if data['phase']=='prepared':
            repair_object(archive,'file',data['archive']);repair_publish(ACTIVE,data)
            data['phase']='published';sequence+=1;repair_write(ACTIVE,sequence,data);repair_step('publication-durable')
        if data['phase']=='published':
            repair_object(archive,'file',data['archive']);repair_publish(ACTIVE,data)
            receipt=ROOT/(REPAIR_LABEL+'-done-'+data['epoch']);repair_rename(ACTIVE,receipt);repair_step('receipt-published')
            warning=repair_cleanup(receipt,data)
            return dict(state='repaired',version=EXPECTED['version'],retainedPrevious=data['old'] is not None,cleanupWarning=warning)
        raise RuntimeError('Unexpected component repair state')
`;

export function windowsBrowserRepairProgram(begin=true,version:string=WINDOWS_CHROME.version,pendingEpoch?:string|null){
 const release=approvedWindowsBrowserRelease(version);if(pendingEpoch!==undefined&&pendingEpoch!==null&&(typeof pendingEpoch!=='string'||!/^[a-f0-9]{32}$/.test(pendingEpoch)))throw new AppError('组件恢复事务身份无效',400,'BROWSER_REPAIR_INTENT');
 return `import os,sys,pathlib,hashlib,subprocess,tarfile,shutil,stat,json,struct,re,uuid,contextlib,fcntl,ctypes\nROOT=pathlib.Path('/opt/mucodesandbox/windows')\nSTATE=pathlib.Path('/var/lib/mucodesandbox')\nTARGET=pathlib.Path(${JSON.stringify(windowsBrowserReleaseRoot(version))})\nACTIVE=ROOT/'.browser-repair'\nEXPECTED=${JSON.stringify(release)}\nREPAIR_APPROVED_RECIPES=${JSON.stringify(WINDOWS_BROWSER_RELEASES)}\n${pendingEpoch===undefined?'':`REPAIR_EXPECT_PENDING=${pendingEpoch===null?'None':JSON.stringify(pendingEpoch)}\n`}${WINDOWS_COMPONENT_PACKAGE_PYTHON}\n${WINDOWS_BROWSER_RESET_HELPERS}\n${WINDOWS_BROWSER_REPAIR_PYTHON}\nprint(json.dumps(repair_windows_browser(sys.stdin.buffer,${begin?'True':'False'})))\n`;
}

// Keep SSH's Windows command line small; the trusted application supplies the
// length-framed program, followed by the pinned archive, through stdin.
export const WINDOWS_BROWSER_REPAIR_BOOTSTRAP=String.raw`import sys,struct
stream=sys.stdin.buffer
header=stream.read(4)
if len(header)!=4:raise RuntimeError('Missing component repair program')
size=struct.unpack('>I',header)[0]
if size<1 or size>262144:raise RuntimeError('Invalid component repair program bound')
program=stream.read(size)
if len(program)!=size:raise RuntimeError('Incomplete component repair program')
exec(compile(program,'trusted-windows-browser-repair','exec'))
`;

export function windowsBrowserRepairInput(archive:Uint8Array,begin=true,version:string=WINDOWS_CHROME.version,pendingEpoch?:string|null){
 const program=Buffer.from(windowsBrowserRepairProgram(begin,version,pendingEpoch));if(program.length>262144)throw Error('Component repair program exceeds its bound');
 const header=Buffer.alloc(4);header.writeUInt32BE(program.length);return Buffer.concat([header,program,archive]);
}
