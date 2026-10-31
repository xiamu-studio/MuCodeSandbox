"""Run production desktop preparation functions on real synthetic Windows files.
POSIX metadata, dirfd, flock and renameat2 use the same explicit adapters as the
agent component tests. No installed client, package script, sudo or VM runs.
"""
import sys,pathlib,io,tarfile,json,hashlib,stat,os as native,ast
fixture=pathlib.Path(__file__).with_name('windows-agent-component.py').read_text(encoding='utf8')
exec(compile(fixture.split('def expect_refused')[0],'shared-component-test-adapters','exec'),globals())
generated=ast.parse(pathlib.Path(sys.argv[3]).read_text(encoding='utf8'))
catalog=json.loads(generated.body[-1].value.args[0].args[0].args[0].args[0].value)
assert catalog['architecture']=='amd64' and len(catalog['files'])=={'grok-bot':102,'claude-desktop':3908}[catalog['id']] and all(type(v['executable']) is bool for v in catalog['files'].values())
prefix=catalog['prefix']
results.append('fixed-production-catalog-json-bools')
header=bytearray(64);header[:6]=b'\x7fELF\x02\x01';header[18:20]=bytes([62,0])
contents={'bin/grok-bot':bytes(header)+b'SYNTHETIC AMD64 CLIENT'*512,'chrome-sandbox':bytes(header)+b'SYNTHETIC HELPER','resources/messages/en.json':b'{"synthetic":true}'}
def deb(files=contents,extra=None):
 data=io.BytesIO()
 with tarfile.open(fileobj=data,mode='w:xz',format=tarfile.USTAR_FORMAT) as archive:
  for name,raw in files.items():
   entry=tarfile.TarInfo(prefix+name);entry.size=len(raw);archive.addfile(entry,io.BytesIO(raw))
  if extra:
   entry=tarfile.TarInfo(prefix+extra);entry.size=1;archive.addfile(entry,io.BytesIO(b'x'))
 control=io.BytesIO()
 with tarfile.open(fileobj=control,mode='w:gz'):pass
 result=b'!<arch>\n'
 for name,raw in [('debian-binary',b'2.0\n'),('control.tar.gz',control.getvalue()),('data.tar.xz',data.getvalue())]:
  result+=((name+'/').ljust(16)+'0'.ljust(12)+'0'.ljust(6)+'0'.ljust(6)+'100644'.ljust(8)+str(len(raw)).ljust(10)+'`\n').encode()+raw+(b'\n' if len(raw)%2 else b'')
 return result
raw=deb();selected=dict(id=catalog['id'],version='1.2.3',architecture='amd64',bytes=len(raw),sha256=digest(raw),prefix=prefix,executable='bin/grok-bot',sandbox='chrome-sandbox',files={n:dict(bytes=len(b),sha256=digest(b),executable=n in ['bin/grok-bot','chrome-sandbox']) for n,b in contents.items()})
Fixture.stage=property(lambda f:f.parent/('.desktop-'+catalog['id']+'-1.2.3.installing'))
Fixture.final=property(lambda f:f.parent/('desktop-'+catalog['id']+'-1.2.3'))
def run(f,mode='install',blob=raw,asset=selected):return f.execute(mode,blob,asset)
def refused(f,blob=raw,asset=selected):
 try:run(f,'install',blob,asset)
 except Exception:return
 raise AssertionError('Invalid desktop component accepted')
def tree(root):return {str(p.relative_to(root)):digest(p.read_bytes()) for p in root.rglob('*') if p.is_file()}
f=Fixture('desktop-fresh');assert run(f,'inspect')['state']=='missing';assert run(f)['state']=='verified';assert run(f,'inspect')['state']=='verified';assert tree(f.final)['bin\\grok-bot' if native.name=='nt' else 'bin/grok-bot']==digest(contents['bin/grok-bot']);before=tree(f.final);assert run(f,blob=b'not read')['state']=='verified';assert tree(f.final)==before;results.append('fresh-full-tree-idempotent')
for point in ['.archive.deb','grok-bot','en.json','chrome-sandbox','.mu-component.json','before-publication','after-publication']:
 f=Fixture('desktop-death-'+point.replace('.','-'));f.stop=point
 if point=='before-publication':
  original=f.rename
  def killed(*args):raise Crash('Synthetic death before publication')
  f.rename=killed
 try:run(f)
 except Crash:pass
 else:raise AssertionError('Expected interruption '+point)
 if point=='before-publication':f.rename=original
 assert run(f,'inspect')['state']==('verified' if point=='after-publication' else 'pending');f.stop=None;assert run(f)['state']=='verified';results.append('resume-'+point)
for case in ['unknown-stage','changed-prefix','changed-final','missing-final-record','hardlink','unsafe-owner','unsafe-mode','space','busy','nonroot','destination-race','bad-archive','extra-archive-byte','tar-traversal','tar-unknown','tar-duplicate','wrong-elf','wrong-arch','wrong-client','wrong-prefix']:
 f=Fixture('desktop-'+case)
 if case in ['unknown-stage','changed-prefix']:
  f.stop='grok-bot'
  try:run(f)
  except Crash:pass
  f.stop=None
  target=f.stage/'notes.txt' if case=='unknown-stage' else f.stage/'bin/grok-bot';target.write_bytes(b'KEEP CHANGED DATA');before=tree(f.stage);refused(f);assert tree(f.stage)==before
 elif case in ['changed-final','missing-final-record','hardlink','unsafe-owner','unsafe-mode']:
  assert run(f)['state']=='verified'
  if case=='changed-final':(f.final/'resources/messages/en.json').write_bytes(b'KEEP CHANGED RESOURCE')
  if case=='missing-final-record':(f.final/'.mu-component.json').unlink()
  if case=='hardlink':native.link(f.final/'bin/grok-bot',f.root/'retained-client-link')
  if case=='unsafe-owner':f.owners[f.parent]=2001
  if case=='unsafe-mode':f.modes[f.final/'bin/grok-bot']=0o777
  before=tree(f.final);assert run(f,'inspect')['state']=='untrusted';refused(f);assert tree(f.final)==before
 elif case=='space':f.space=1;refused(f);assert not f.final.exists()
 elif case=='busy':f.busy=True;assert run(f)['state']=='busy';assert not f.stage.exists()
 elif case=='nonroot':f.user=2001;refused(f);assert not f.parent.exists()
 elif case=='destination-race':f.race=True;refused(f);assert (f.final/'unrelated.txt').read_bytes()==b'KEEP FOREIGN DESTINATION';assert f.stage.exists()
 elif case=='bad-archive':refused(f,raw[:-1]+bytes([raw[-1]^1]));assert not f.final.exists()
 elif case=='extra-archive-byte':refused(f,raw+b'x');assert not f.final.exists()
 elif case=='wrong-arch':refused(f,asset={**selected,'architecture':'arm64'});assert not f.parent.exists()
 elif case=='wrong-client':refused(f,asset={**selected,'id':'unreviewed-client'});assert not f.parent.exists()
 elif case=='wrong-prefix':refused(f,asset={**selected,'prefix':'usr/lib/claude-desktop/' if prefix=='opt/Grok Bot/' else 'opt/Grok Bot/'});assert not f.parent.exists()
 elif case=='wrong-elf':
  arm={**contents,'bin/grok-bot':contents['bin/grok-bot'][:18]+bytes([183,0])+contents['bin/grok-bot'][20:]};blob=deb(arm);asset={**selected,'bytes':len(blob),'sha256':digest(blob),'files':{**selected['files'],'bin/grok-bot':{**selected['files']['bin/grok-bot'],'sha256':digest(arm['bin/grok-bot'])}}};refused(f,blob,asset);assert not f.final.exists()
 else:
  blob=deb(extra='../outside' if case=='tar-traversal' else 'unknown' if case=='tar-unknown' else 'bin/grok-bot');refused(f,blob,{**selected,'bytes':len(blob),'sha256':digest(blob)});assert not f.final.exists() and not (f.root/'outside').exists()
 results.append(case)
production_source=source
for replaced in [False,True]:
 f=Fixture('cached-directory-replaced' if replaced else 'cached-directory-reused')
 original_mkdir=f.mkdir
 def mkdir(name,mode=0o777,dir_fd=None):
  if name=='replacement-trigger':
   native.rename(f.parent/'cached',f.parent/'held-original');(f.parent/'cached').mkdir()
  else:original_mkdir(name,mode,dir_fd)
 f.mkdir=mkdir
 source=production_source+'''
def main(asset,mode):
 pins=DesktopPins()
 try:
  parent=pins.path(['opt','mucodesandbox','windows'],True);os.mkdir('cached',0o755,dir_fd=parent);fd=pins.child(parent,'cached');count=len(pins.handles)
  for _ in range(1000):need(pins.child(parent,'cached')==fd)
  need(len(pins.handles)==count)
  if mode=='install':
   os.mkdir('replacement-trigger',0o755,dir_fd=parent)
   try:pins.child(parent,'cached')
   except Refused:return {'state':'replacement-refused'}
   raise AssertionError('A replacement directory reused the original binding')
  return {'state':'reused-without-extra-handles'}
 finally:pins.close()
'''
 assert f.execute('install' if replaced else 'inspect',b'',selected)['state']==('replacement-refused' if replaced else 'reused-without-extra-handles')
 results.append('cached-name-replacement-refused' if replaced else 'cached-handle-count-bounded')
source=production_source
print(json.dumps(dict(complete=True,checks=results,actualOrdinaryFiles=True,actualHardLinks=True,syntheticFixedDeb=True,posixMetadataDirfdLockRenameAdapters=True,executedClient=False,executedPackageScript=False,actualLinux=False,actualHyperV=False,projectAndCredentialSentinelsPreserved=True)))
