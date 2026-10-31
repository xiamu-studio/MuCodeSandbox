// Shared only by Windows' fresh installer and approved-component recovery.
// The caller owns a pinned, root-controlled private work directory. Vendor
// maintainer scripts and package desktop/updater integration are never run.
export const WINDOWS_COMPONENT_PACKAGE_PYTHON=String.raw`
def component_digest(path):
    digest=hashlib.sha256()
    with path.open('rb') as source:
        while True:
            block=source.read(1048576)
            if not block:break
            digest.update(block)
    return digest.hexdigest()

def component_archive(archive,expected,role):
    if role not in ['chrome','display']:raise RuntimeError('Unknown component role')
    info=archive.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size!=expected['bytes'] or component_digest(archive)!=expected['sha256']:
        raise RuntimeError('Component checksum mismatch')
    if subprocess.check_output(['/usr/bin/dpkg-deb','-f',str(archive),'Architecture'],text=True).strip()!='amd64':raise RuntimeError('Wrong component architecture')
    if role=='chrome' and subprocess.check_output(['/usr/bin/dpkg-deb','-f',str(archive),'Version'],text=True).strip()!=expected['packageVersion']:raise RuntimeError('Wrong browser version')

def component_entries(archive,expected,role):
    process=subprocess.Popen(['/usr/bin/dpkg-deb','--fsys-tarfile',str(archive)],stdout=subprocess.PIPE)
    count,total,path_bytes=0,0,0;seen=set()
    try:
        with tarfile.open(fileobj=process.stdout,mode='r|') as contents:
            for item in contents:
                name=pathlib.PurePosixPath(item.name)
                if name.is_absolute() or '..' in name.parts or chr(92) in item.name or ':' in item.name:raise RuntimeError('Unsafe component path')
                if role=='chrome':
                    if name.parts[:3]!=('opt','google','chrome') or len(name.parts)<=3:continue
                    relative=pathlib.PurePosixPath(*name.parts[3:])
                else:
                    mapping={'opt/TurboVNC/bin/Xvnc':'bin/Xvnc','usr/share/doc/turbovnc-'+expected['version']+'/LICENSE.txt':'LICENSE.txt'}
                    if str(name) not in mapping:continue
                    relative=pathlib.PurePosixPath(mapping[str(name)])
                if not(item.isfile() or item.isdir()) or str(relative) in seen or item.size<0:raise RuntimeError('Unexpected component link or duplicate')
                path_bytes+=len(str(relative).encode());count+=1;total+=item.size;seen.add(str(relative))
                if len(str(relative).encode())>1024 or path_bytes>2097152 or count>20000 or total>1073741824:raise RuntimeError('Component payload exceeds bounds')
                stream=contents.extractfile(item) if item.isfile() else None
                try:yield relative,item,stream
                finally:
                    if stream is not None:stream.close()
        if process.wait()!=0:raise RuntimeError('Component extraction failed')
    finally:
        process.stdout.close()
        if process.poll() is None:process.kill();process.wait()

def component_record(expected,binary_hash):
    return json.dumps(dict(archiveSha256=expected['sha256'],binarySha256=binary_hash,architecture='amd64',version=expected['version']),sort_keys=True).encode()

def extract_windows_component(archive,payload,expected,role):
    component_archive(archive,expected,role)
    payload.mkdir(mode=0o755,exist_ok=True)
    if any(payload.iterdir()):raise RuntimeError('Component extraction directory must be empty')
    for relative,item,source in component_entries(archive,expected,role):
        destination=payload/relative;destination.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
        if item.isdir():destination.mkdir(exist_ok=True,mode=0o755)
        else:
            with destination.open('xb') as output:
                shutil.copyfileobj(source,output);output.flush();os.fsync(output.fileno())
            os.chmod(destination,item.mode&0o755)
    main=payload/('chrome' if role=='chrome' else 'bin/Xvnc')
    if not main.is_file() or main.is_symlink():raise RuntimeError('Missing component executable')
    binary_hash=component_digest(main)
    if role=='chrome' and expected.get('binarySha256') is not None and binary_hash!=expected['binarySha256']:raise RuntimeError('Browser executable checksum mismatch')
    if role=='display' and binary_hash!=expected['binarySha256']:raise RuntimeError('Display executable checksum mismatch')
    os.chmod(main,0o755)
    if role=='chrome':
        helper=payload/'chrome-sandbox'
        if not helper.is_file() or helper.is_symlink():raise RuntimeError('Missing browser sandbox helper')
        if expected.get('sandboxSha256') is not None and component_digest(helper)!=expected['sandboxSha256']:raise RuntimeError('Browser sandbox helper checksum mismatch')
        os.chmod(helper,0o4755)
    record=payload/'.mu-component.json'
    with record.open('xb') as output:
        output.write(component_record(expected,binary_hash));output.flush();os.fsync(output.fileno())
    os.chmod(record,0o644)
    return binary_hash

def verify_windows_component(archive,payload,expected,role,partial=False):
    component_archive(archive,expected,role)
    root_info=payload.lstat()
    if not stat.S_ISDIR(root_info.st_mode):raise RuntimeError('Unsafe component payload root')
    actual_files=set();actual_dirs=set();sandbox_hash=hashlib.sha256()
    for base,dirs,files in os.walk(payload,followlinks=False):
        for name in dirs+files:
            path=pathlib.Path(base)/name;info=path.lstat();relative=str(path.relative_to(payload)).replace(os.sep,'/')
            if stat.S_ISDIR(info.st_mode):actual_dirs.add(relative)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink==1:actual_files.add(relative)
            else:raise RuntimeError('Component payload link or special file')
    allowed_dirs=set();allowed_files=set();main_hash=hashlib.sha256();found_main=False
    for relative,item,source in component_entries(archive,expected,role):
        name=str(relative);allowed_dirs.update(str(parent) for parent in relative.parents if str(parent)!='.')
        if item.isdir():allowed_dirs.add(name);continue
        allowed_files.add(name);path=payload/relative
        try:info=path.lstat()
        except FileNotFoundError:
            if not partial:raise RuntimeError('Component payload is incomplete')
            info=None
        if info is not None and (not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>item.size or not partial and info.st_size!=item.size):raise RuntimeError('Component payload type or length changed')
        existing=path.open('rb') if info is not None else None
        try:
            remaining=info.st_size if info is not None else 0
            while True:
                block=source.read(1048576)
                if not block:break
                if name==('chrome' if role=='chrome' else 'bin/Xvnc'):main_hash.update(block);found_main=True
                if role=='chrome' and name=='chrome-sandbox':sandbox_hash.update(block)
                check=min(remaining,len(block))
                if check and existing.read(check)!=block[:check]:raise RuntimeError('Component payload bytes changed')
                remaining-=check
            if remaining:raise RuntimeError('Component payload was truncated')
        finally:
            if existing is not None:existing.close()
    if not found_main:raise RuntimeError('Approved component has no executable')
    if role=='chrome' and expected.get('binarySha256') is not None and main_hash.hexdigest()!=expected['binarySha256']:raise RuntimeError('Browser executable checksum mismatch')
    if role=='chrome' and expected.get('sandboxSha256') is not None and sandbox_hash.hexdigest()!=expected['sandboxSha256']:raise RuntimeError('Browser sandbox helper checksum mismatch')
    record=payload/'.mu-component.json';expected_record=component_record(expected,main_hash.hexdigest());allowed_files.add(record.name)
    try:
        info=record.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>len(expected_record):raise RuntimeError('Component record type or bound changed')
        actual=record.read_bytes()
    except FileNotFoundError:
        if not partial:raise RuntimeError('Component record missing')
        actual=None
    if actual is not None and (len(actual)>len(expected_record) or expected_record[:len(actual)]!=actual or not partial and actual!=expected_record):raise RuntimeError('Component record changed')
    if not actual_files<=allowed_files or not actual_dirs<=allowed_dirs or not partial and (actual_files!=allowed_files or actual_dirs!=allowed_dirs):raise RuntimeError('Unexpected component payload inventory')
    return main_hash.hexdigest()
`;
