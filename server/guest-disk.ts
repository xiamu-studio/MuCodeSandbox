import { z } from 'zod';

export function growGuestRootScript(diskGiB: number) {
  z.number().int().min(10).max(256).parse(diskGiB);
  return `import json,os,stat,subprocess,tempfile
assert os.geteuid()==0
environment=dict(os.environ,LC_ALL='C',LANG='C',PATH='/usr/sbin:/usr/bin:/sbin:/bin')
def output(args):
 return subprocess.check_output(args,env=environment,text=True).strip()
filesystem=json.loads(output(['findmnt','--json','--output','SOURCE,FSTYPE,TARGET','/']))['filesystems']
if len(filesystem)!=1 or filesystem[0]['target']!='/' or filesystem[0]['fstype']!='ext4':
 raise RuntimeError('Recovery requires the supported ext4 root filesystem')
device=os.path.realpath(filesystem[0]['source'])
metadata=os.stat(device)
if device!='/dev/vda1' or not stat.S_ISBLK(metadata.st_mode):
 raise RuntimeError('Recovery requires the primary VZ root partition')
disk_bytes=int(output(['blockdev','--getsize64','/dev/vda']))
if disk_bytes!=${diskGiB}*2**30:
 raise RuntimeError('Actual primary disk size differs from the requested capacity')
memory=json.loads(output(['findmnt','--json','--output','FSTYPE','--target','/run']))['filesystems']
if len(memory)!=1 or memory[0]['fstype']!='tmpfs':
 raise RuntimeError('Recovery temporary files must be held in memory')
before=os.statvfs('/')
# growpart needs scratch space even when the root disk has no writable blocks.
with tempfile.TemporaryDirectory(prefix='mu-disk-recovery-',dir='/run') as temporary:
 environment['TMPDIR']=temporary
 result=subprocess.run(['growpart','/dev/vda','1'],env=environment,text=True,capture_output=True)
 if result.returncode!=0 and not (result.returncode==1 and result.stdout.startswith('NOCHANGE:')):
  raise RuntimeError('growpart failed: '+result.stdout+result.stderr)
 resized=subprocess.run(['resize2fs',device],env=environment,text=True,capture_output=True,check=True)
after=os.statvfs('/')
print(json.dumps({'diskBytes':disk_bytes,'device':device,'beforeFilesystemBytes':before.f_blocks*before.f_frsize,'afterFilesystemBytes':after.f_blocks*after.f_frsize,'availableBytes':after.f_bavail*after.f_frsize,'growpart':result.stdout,'resize2fs':resized.stdout+resized.stderr,'scratchInMemory':True}))
`;
}
