import os,pathlib,hashlib,subprocess,tarfile,shutil,stat,json,io,sys,types
source=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8');root=pathlib.Path(sys.argv[2]);version='155.0.8059.84';main=b'synthetic approved component executable';helper=b'synthetic sandbox helper'
def archive_bytes(entries):
 output=io.BytesIO()
 with tarfile.open(fileobj=output,mode='w') as archive:
  for name,data,kind in entries:
   info=tarfile.TarInfo(name);info.mode=0o755
   if kind=='link':info.type=tarfile.SYMTYPE;info.linkname='/outside-profile'
   elif kind=='hardlink':info.type=tarfile.LNKTYPE;info.linkname='outside-profile'
   else:info.size=len(data)
   archive.addfile(info,io.BytesIO(data) if kind=='file' else None)
 return output.getvalue()
class Decoder:
 def __init__(self,data,code):self.stdout=io.BytesIO(data);self.code=code;self.done=False
 def wait(self):self.done=True;return self.code
 def poll(self):return self.code if self.done else None
 def kill(self):self.done=True
def snapshot(directory):return {str(f.relative_to(directory)):hashlib.sha256(f.read_bytes()).hexdigest() for f in directory.rglob('*') if f.is_file()}
results=[]
for case in ['chrome','display','wrong-architecture','wrong-version','wrong-digest','wrong-bytes','wrong-binary-digest','wrong-sandbox-digest','symlink','hardlink','traversal','absolute','backslash','drive','duplicate','missing-main','missing-helper','record-collision','long-path','payload-bound','decoder-failed','partial-prefix','changed-prefix','unknown-file','record-changed','file-hardlink']:
 directory=root/case;directory.mkdir();profile=directory/'profile';profile.mkdir();(profile/'keep.txt').write_bytes(b'original browser profile and projects');before_profile=snapshot(profile);role='display' if case=='display' else 'chrome'
 entries=[('opt/google/chrome/chrome',main,'file'),('opt/google/chrome/chrome-sandbox',helper,'file'),('opt/google/chrome/resources/a.pak',b'approved resource','file')]
 if role=='display':entries=[('opt/TurboVNC/bin/Xvnc',main,'file'),('usr/share/doc/turbovnc-'+version+'/LICENSE.txt',b'license','file')]
 if case=='symlink':entries.append(('opt/google/chrome/link',b'','link'))
 if case=='hardlink':entries.append(('opt/google/chrome/link',b'','hardlink'))
 if case=='traversal':entries.append(('opt/google/chrome/../outside',b'x','file'))
 if case=='absolute':entries.append(('/outside',b'x','file'))
 if case=='backslash':entries.append(('opt/google/chrome/..'+chr(92)+'outside',b'x','file'))
 if case=='drive':entries.append(('C:/outside',b'x','file'))
 if case=='duplicate':entries.append(entries[0])
 if case=='missing-main':entries=entries[1:]
 if case=='missing-helper':entries=[entries[0],entries[2]]
 if case=='record-collision':entries.append(('opt/google/chrome/.mu-component.json',b'foreign record','file'))
 if case=='long-path':entries.append(('opt/google/chrome/'+('x'*1025),b'x','file'))
 data=archive_bytes(entries)
 if case=='payload-bound':
  info=tarfile.TarInfo('opt/google/chrome/bomb');info.size=1073741825;data=info.tobuf()+b'\0'*1024
 archive=directory/'archive.deb';archive.write_bytes(data);expected=dict(version=version,packageVersion=version+'-1',bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),binarySha256=hashlib.sha256(main).hexdigest(),sandboxSha256=hashlib.sha256(helper).hexdigest())
 if case=='wrong-digest':expected['sha256']='a'*64
 if case=='wrong-bytes':expected['bytes']+=1
 if case=='wrong-binary-digest':expected['binarySha256']='b'*64
 if case=='wrong-sandbox-digest':expected['sandboxSha256']='c'*64
 decoders=[];calls=[]
 def checked(args,text=False):
  assert args[:2]==['/usr/bin/dpkg-deb','-f'] and args[2]==str(archive),args;calls.append(args)
  return ('arm64' if case=='wrong-architecture' else 'amd64')+'\n' if args[-1]=='Architecture' else ('wrong' if case=='wrong-version' else expected['packageVersion'])+'\n'
 def popen(args,stdout=None):
  assert args==['/usr/bin/dpkg-deb','--fsys-tarfile',str(archive)],args;calls.append(args);process=Decoder(data,1 if case=='decoder-failed' else 0);decoders.append(process);return process
 namespace=dict(os=os,pathlib=pathlib,hashlib=hashlib,subprocess=types.SimpleNamespace(check_output=checked,Popen=popen,PIPE=subprocess.PIPE),tarfile=tarfile,shutil=shutil,stat=stat,json=json)
 exec(compile(source,'unchanged-windows-component-package','exec'),namespace);payload=directory/'candidate';rejected=False
 try:namespace['extract_windows_component'](archive,payload,expected,role)
 except Exception:rejected=True
 extraction_bad=case not in ['chrome','display','partial-prefix','changed-prefix','unknown-file','record-changed','file-hardlink']
 assert rejected==extraction_bad,(case,rejected)
 if not extraction_bad:
  assert namespace['verify_windows_component'](archive,payload,expected,role)==hashlib.sha256(main).hexdigest(),case
  if case=='partial-prefix':(payload/'chrome').write_bytes(main[:4]);(payload/'resources/a.pak').unlink()
  if case=='changed-prefix':(payload/'chrome').write_bytes(b'wrong prefix')
  if case=='unknown-file':(payload/'unclaimed.txt').write_bytes(b'unknown bytes')
  if case=='record-changed':(payload/'.mu-component.json').write_bytes(b'not the generated record')
  if case=='file-hardlink':os.link(payload/'chrome',directory/'retained-link')
  before=snapshot(payload);refused=False
  try:namespace['verify_windows_component'](archive,payload,expected,role,True)
  except Exception:refused=True
  assert refused==(case in ['changed-prefix','unknown-file','record-changed','file-hardlink']),(case,refused)
  assert snapshot(payload)==before,('Verification changed bytes',case)
 assert snapshot(profile)==before_profile,('Profile changed',case)
 assert all(p.stdout.closed and p.done for p in decoders),('Decoder handle leak',case)
 results.append(dict(case=case,passed=True,decoderCalls=len(calls),profilePreserved=True))
print(json.dumps(dict(complete=True,checks=results,actualArchiveParsing=True,actualFiles=True,actualHardlinks=True,decoderAdapter=True,realDebPackage=False,realLinux=False,vendorScriptsExecuted=False)))
