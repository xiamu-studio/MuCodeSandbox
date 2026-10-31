"""Run production preparation and its actual entry tail on host files.
Linux ownership, permissions, service/DEB decoding and exclusive rename use the
same explicit adapters as the existing recovery tests. No browser is executed.
"""
import os,sys,pathlib,hashlib,json,io,contextlib
helper=pathlib.Path(__file__).with_name('windows-browser-repair.py').read_text(encoding='utf-8')
boundary="if len(sys.argv)>1 and sys.argv[1]=='worker':worker();raise SystemExit(0)"
assert helper.count(boundary)==1
helper=helper.split(boundary)[0]
def change(before,after):
 global helper
 assert helper.count(before)==1,before
 helper=helper.replace(before,after)
change("active=root/'.browser-repair'","active=root/LABEL")
change("self.name.startswith(('.browser-repair-prep-','.browser-repair-done-'))","self.name.startswith(('.browser-candidate-','.browser-repair-prep-','.browser-repair-done-'))")
change('ACTIVE=active,EXPECTED=EXPECTED)','ACTIVE=active,EXPECTED=EXPECTED,REPAIR_LABEL=LABEL,REPAIR_RETAINED=LABEL+\'-retained\',REPAIR_NEW_ONLY=True,REPAIR_STOP_BROWSER=False,REPAIR_KEEP_ARCHIVE=True)')
change("answer=namespace['repair_windows_browser'](io.BytesIO(DATA),begin)","""program=pathlib.Path(os.environ['MU_CANDIDATE_BEGIN' if begin else 'MU_CANDIDATE_RESUME']).read_text(encoding='utf-8')
        marker=\"if repair_present(ROOT/'.browser-repair'):\"
        assert program.count(marker)==1
        tail=program[program.index(marker):]
        namespace['sys']=types.SimpleNamespace(stdin=types.SimpleNamespace(buffer=io.BytesIO(DATA)))
        answers=[]
        namespace['print']=lambda value:answers.append(value)
        exec(compile(tail,'actual-candidate-entry','exec'),namespace)
        assert len(answers)==1
        answer=json.loads(answers[0])""")
exec(compile(helper,'existing-recovery-adapters','exec'),globals())
VERSION='156.0.8078.47';LABEL='.browser-candidate-'+VERSION
EXPECTED.update(version=VERSION,packageVersion=VERSION+'-1',binarySha256=hashlib.sha256(b'approved synthetic executable').hexdigest(),sandboxSha256=hashlib.sha256(b'approved synthetic sandbox').hexdigest())
if len(sys.argv)>1 and sys.argv[1]=='worker':worker();raise SystemExit(0)
root=pathlib.Path(sys.argv[3]);results=[];kills=0;original_run=run
def run(directory,fault='',occurrence=1,begin=True):
 global kills
 answer=original_run(directory,fault,occurrence,begin)
 if fault:kills+=1
 return answer
def fixture(name):
 directory,before=prepare(root,name,False);old=directory/'components/chrome-155.0.8059.84';old.mkdir();(old/'chrome').write_bytes(b'original active browser remains usable')
 receipt=directory/'components/.browser-repair-done-original';receipt.mkdir();(receipt/'journal.bin').write_bytes(b'old unrelated repair receipt must remain untouched')
 selection=directory/'components/.browser-selected.json';selection.write_bytes(b'original protected selector, unchanged')
 return directory,before,snapshot(old),snapshot(receipt),selection.read_bytes()
def unchanged_originals(state):
 directory,profile,old,receipt,selection=state
 assert snapshot(directory/'profile')==profile
 assert snapshot(directory/'components/chrome-155.0.8059.84')==old
 assert snapshot(directory/'components/.browser-repair-done-original')==receipt
 assert (directory/'components/.browser-selected.json').read_bytes()==selection
def finished(state):
 directory=state[0];unchanged_originals(state)
 target=directory/('components/chrome-'+VERSION);assert (target/'chrome').read_bytes()==b'approved synthetic executable';assert (target/'chrome-sandbox').read_bytes()==b'approved synthetic sandbox'
 assert not (directory/'components'/LABEL).exists();receipts=list((directory/'components').glob(LABEL+'-done-*'));assert len(receipts)==1
 assert {p.name for p in receipts[0].iterdir()}=={'archive.deb','journal.bin'}
 assert (receipts[0]/'archive.deb').read_bytes()==DATA
 assert not list((directory/'components').glob(LABEL+'-retained-*'))
state=fixture('prepared-and-idempotent');answer=run(state[0]);assert answer['code']==0 and answer['stopped']==0 and answer['answer']['version']==VERSION;finished(state)
before=snapshot(state[0]);answer=run(state[0],begin=False);assert answer['code']==0 and answer['stopped']==0 and answer['answer']['state']=='repaired';assert snapshot(state[0])==before
results.append(dict(case='side-by-side-and-idempotent',passed=True,activeComponentAndProfilePreserved=True,serviceStops=0))
before=snapshot(state[0]);assert run(state[0])['code']==2;assert snapshot(state[0])==before;results.append(dict(case='existing-destination-never-replaced',passed=True))
for name,point,occurrence in [('initial-frame','journal-half-written',1),('initial-plan','initialization-durable',1),('active','active-published',1),('archive-prefix','archive-prefix-written',1),('archive-frame','journal-half-written',2),('archive-ready','archive-ready',1),('file-prefix','candidate-file-prefix',1),('extracted','candidate-extracted',1),('candidate-frame','journal-half-written',3),('prepared','candidate-prepared',1),('published','new-component-published',1),('published-frame','journal-half-written',4),('publication','publication-durable',1),('receipt','receipt-published',1)]:
 state=fixture(name);run(state[0],point,occurrence);begin=not (state[0]/'components'/LABEL).exists() and point!='receipt-published';answer=run(state[0],begin=begin);assert answer['code']==0 and answer['stopped']==0,(name,answer);finished(state);results.append(dict(case=name,passed=True,realKilledProcess=True,freshProcessResume=True,activeComponentAndProfilePreserved=True,serviceStops=0))
for name,mutation in [('unknown-file','unknown'),('changed-prefix','changed'),('replaced-candidate','replace'),('hardlink','hardlink'),('unknown-slot','slot'),('replaced-archive','archive'),('corrupt-journal','journal'),('foreign-target','target')]:
 state=fixture(name);run(state[0],'candidate-prepared');slot=state[0]/'components'/LABEL;candidate=slot/'candidate'
 if mutation=='unknown':(candidate/'foreign').write_bytes(b'unknown bytes')
 elif mutation=='changed':(candidate/'chrome').write_bytes(b'changed')
 elif mutation=='replace':os.rename(candidate,state[0]/'retained');candidate.mkdir()
 elif mutation=='hardlink':os.link(candidate/'chrome',state[0]/'retained-link')
 elif mutation=='slot':(slot/'unknown').write_bytes(b'unknown bytes')
 elif mutation=='archive':os.rename(slot/'archive.deb',state[0]/'retained-archive');(slot/'archive.deb').write_bytes(DATA)
 elif mutation=='journal':(slot/'journal.bin').write_bytes(b'x'*16384)
 elif mutation=='target':(state[0]/('components/chrome-'+VERSION)).mkdir()
 before=snapshot(state[0]);answer=run(state[0],begin=False);assert answer['code']==2,(name,answer);assert snapshot(state[0])==before;unchanged_originals(state);results.append(dict(case=name,passed=True,allChangedBytesPreserved=True,activeComponentAndProfilePreserved=True))
state=fixture('prior-repair-pending');pending=state[0]/'components/.browser-repair';pending.mkdir();(pending/'private').write_bytes(b'original recovery data');before=snapshot(state[0]);assert run(state[0])['code']==2;assert snapshot(state[0])==before;unchanged_originals(state);results.append(dict(case='prior-repair-pending',passed=True,actualEntryRefused=True))
print(json.dumps(dict(complete=True,checks=results,realProcessKills=kills,actualCandidateEntry=True,actualHostFiles=True,actualKernelFileLocks=True,posixOwnerModeSyncAndRenameAdapters=True,serviceStopAdapter=True,debDecoderAdapter=True,realLinux=False,realVm=False,browserExecuted=False)))
