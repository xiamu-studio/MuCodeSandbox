import {z} from 'zod';
import {windowsDiskSize} from '../../../shared/windows-disk.ts';

// This is only the guest-side building block. It is deliberately not exposed
// as an API or scheduled task until the native maintenance journal, exclusive
// ownership and offline VHDX compaction transaction are in place.
export function windowsRootTrimScript(diskGiB:number):string {
 windowsDiskSize.parse(diskGiB);
 return `import json,os,stat,subprocess
if os.geteuid()!=0:raise RuntimeError('Root maintenance privilege required')
env={'LC_ALL':'C','LANG':'C','PATH':'/usr/sbin:/usr/bin:/sbin:/bin'}
def output(args):return subprocess.check_output(args,env=env,text=True,stderr=subprocess.DEVNULL,timeout=30).strip()
def layout():
 fs=json.loads(output(['/usr/bin/findmnt','--json','--output','SOURCE,FSTYPE,TARGET','/']))['filesystems']
 if len(fs)!=1 or fs[0]['target']!='/' or fs[0]['fstype']!='ext4':raise RuntimeError('Unsupported root filesystem')
 device=os.path.realpath(fs[0]['source'])
 if device!='/dev/sda1':raise RuntimeError('Unexpected root device')
 disk=os.stat('/dev/sda');root=os.stat(device);mount=os.stat('/')
 if not stat.S_ISBLK(disk.st_mode) or not stat.S_ISBLK(root.st_mode) or root.st_rdev!=mount.st_dev:raise RuntimeError('Root device identity changed')
 size=int(output(['/usr/sbin/blockdev','--getsize64','/dev/sda']))
 if size!=${diskGiB}*2**30:raise RuntimeError('Virtual disk capacity changed')
 if int(open('/sys/class/block/sda/queue/discard_max_bytes').read().strip())<=0:raise RuntimeError('Disk discard unavailable')
 return (disk.st_rdev,root.st_rdev,size)
before=layout()
tool=os.stat('/usr/sbin/fstrim')
if not stat.S_ISREG(tool.st_mode) or tool.st_uid!=0 or tool.st_mode&0o022:raise RuntimeError('Untrusted discard utility')
os.sync()
subprocess.run(['/usr/sbin/fstrim','/'],env=env,check=True,timeout=120,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if layout()!=before:raise RuntimeError('Root device changed during discard')
print(json.dumps({'device':'/dev/sda1','diskBytes':before[2],'discardCompleted':True}))
`;
}

const receipt=z.object({device:z.literal('/dev/sda1'),diskBytes:z.number().int().positive().safe(),discardCompleted:z.literal(true)}).strict();
export function parseWindowsRootTrimReceipt(source:string,diskGiB:number){
 windowsDiskSize.parse(diskGiB);const value=receipt.parse(JSON.parse(source));
 if(value.diskBytes!==diskGiB*2**30)throw Error('Discard receipt capacity changed');
 return value;
}
