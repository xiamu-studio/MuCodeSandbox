import {z} from 'zod';import {AppError} from '../../errors.ts';import type {RunOptions} from '../../process.ts';import type {HyperVRuntime} from './runtime.ts';import type {WindowsConfig} from './config.ts';
import {createHash} from 'node:crypto';import {leaseRules,LEASE_HELPER} from '../../guest-lease.ts';import {vmIdentity,NET_UID,PROBE_UID} from './config.ts';
import {windowsDiskSize,windowsDiskGrowthInfo,windowsDiskIdentifier} from '../../../shared/windows-disk.ts';
const GiB=2**30;
export function armWindowsDiskMaintenanceScript(config:WindowsConfig){
 const rules=leaseRules(vmIdentity(config.id).host,NET_UID,PROBE_UID,NET_UID),sha=(value:string)=>createHash('sha256').update(value).digest('hex');
 return `import os,stat,json,subprocess,tempfile,hashlib,uuid,fcntl
assert os.geteuid()==0
root='/run/mucodesandbox-lease'
memory=json.loads(subprocess.check_output(['findmnt','--json','--output','FSTYPE','--target','/run'],text=True))['filesystems']
if len(memory)!=1 or memory[0]['fstype']!='tmpfs':raise RuntimeError('Maintenance state requires memory storage')
for path,expected in [('/etc/mucodesandbox/lease.nft','${sha(rules)}'),('/usr/local/libexec/mu-network-lease','${sha(LEASE_HELPER)}')]:
 s=os.lstat(path)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022 or hashlib.sha256(open(path,'rb').read()).hexdigest()!=expected:raise RuntimeError('Maintenance lease files changed')
try:os.mkdir(root,0o700)
except FileExistsError:pass
s=os.lstat(root)
if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o077:raise RuntimeError('Unsafe maintenance state directory')
lock=os.open(root+'/lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
try:
 s=os.fstat(lock)
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_mode&0o077:raise RuntimeError('Unsafe maintenance lock')
 fcntl.flock(lock,fcntl.LOCK_EX)
 subprocess.run(['/usr/sbin/nft','flush','set','inet','mu_lease','permit'],check=True,capture_output=True)
 boot=open('/proc/sys/kernel/random/boot_id').read().strip()
 fd,pending=tempfile.mkstemp(prefix='disk-maintenance-',dir=root)
 try:
  with os.fdopen(fd,'w') as output:json.dump({'session':'disk-maintenance-'+str(uuid.uuid4()),'boot':boot,'state':'closed','deadline':0},output);output.flush();os.fsync(output.fileno())
  os.replace(pending,root+'/state')
 finally:
  if os.path.exists(pending):os.unlink(pending)
 data=json.loads(subprocess.check_output(['/usr/sbin/nft','-j','list','set','inet','mu_lease','permit'],text=True))
 if any(item.get('set',{}).get('elem') for item in data['nftables']):raise RuntimeError('Maintenance permission did not close')
finally:os.close(lock)
print(json.dumps({'closed':True,'volatileState':True}))
`;
}
async function armMaintenance(runtime:MaintenanceRuntime,config:WindowsConfig,options:RunOptions){const proof=z.object({closed:z.literal(true),volatileState:z.literal(true)}).strict().parse(JSON.parse(await runtime.management(config,['sudo','-n','python3','-'],{...options,input:armWindowsDiskMaintenanceScript(config),timeoutMs:15000,maxBytes:4096,onOutput:undefined})));return proof;}
export function windowsRootGrowthScript(targetGiB:number,review=false){windowsDiskSize.parse(targetGiB);return `import json,os,stat,subprocess,tempfile,shutil
assert os.geteuid()==0
environment=dict(os.environ,LC_ALL='C',LANG='C',PATH='/usr/sbin:/usr/bin:/sbin:/bin')
def output(args):return subprocess.check_output(args,env=environment,text=True,stderr=subprocess.DEVNULL).strip()
fs=json.loads(output(['findmnt','--json','--output','SOURCE,FSTYPE,TARGET','/']))['filesystems']
if len(fs)!=1 or fs[0]['target']!='/' or fs[0]['fstype']!='ext4':raise RuntimeError('Only the supported ext4 root can grow')
device=os.path.realpath(fs[0]['source'])
if device!='/dev/sda1' or not stat.S_ISBLK(os.stat(device).st_mode):raise RuntimeError('Only the primary Hyper-V root partition can grow')
disk_bytes=int(output(['blockdev','--getsize64','/dev/sda']))
if disk_bytes!=${targetGiB}*2**30:raise RuntimeError('Actual Hyper-V disk capacity changed')
def geometry():
 table=json.loads(output(['sfdisk','--json','/dev/sda']))['partitiontable']
 if table['device']!='/dev/sda' or table['unit']!='sectors' or table['sectorsize'] not in [512,4096]:raise RuntimeError('Unsupported primary partition table')
 roots=[part for part in table['partitions'] if part['node']==device]
 if len(roots)!=1:raise RuntimeError('Root partition identity changed')
 start=roots[0]['start']*table['sectorsize'];size=int(output(['blockdev','--getsize64',device]))
 if size!=roots[0]['size']*table['sectorsize'] or start<2**20 or start>2*2**30 or size>disk_bytes-start:raise RuntimeError('Root partition geometry is inconsistent')
 return start,size
start,partition=geometry()
run=json.loads(output(['findmnt','--json','--output','FSTYPE','--target','/run']))['filesystems']
if len(run)!=1 or run[0]['fstype']!='tmpfs':raise RuntimeError('Growth temporary files require memory storage')
def filesystem_bytes():
 fields=dict(line.split(':',1) for line in output(['dumpe2fs','-h',device]).splitlines() if ':' in line)
 return int(fields['Block count'])*int(fields['Block size'])
before=filesystem_bytes()
for utility in ['growpart','resize2fs','dumpe2fs','sfdisk']:
 if not shutil.which(utility,path=environment['PATH']):raise RuntimeError('Disk growth utilities are missing')
${review?`
if before>partition or partition>disk_bytes:raise RuntimeError('Root filesystem geometry changed')
print(json.dumps({'diskBytes':disk_bytes,'device':device,'beforeFilesystemBytes':before,'filesystemBytes':before,'partitionBytes':partition,'partitionStartBytes':start,'scratchInMemory':True}))
raise SystemExit(0)` : ''}
with tempfile.TemporaryDirectory(prefix='mu-windows-disk-',dir='/run') as temporary:
 environment['TMPDIR']=temporary
 grown=subprocess.run(['growpart','/dev/sda','1'],env=environment,text=True,capture_output=True)
 if grown.returncode!=0 and not(grown.returncode==1 and grown.stdout.startswith('NOCHANGE:')):raise RuntimeError('Root partition growth was not confirmed')
 subprocess.run(['resize2fs',device],env=environment,text=True,capture_output=True,check=True)
after=filesystem_bytes();after_start,partition=geometry()
if after_start!=start or after<before or after>partition or partition-after>32*2**20 or disk_bytes-start-partition>32*2**20:raise RuntimeError('Root filesystem growth is incomplete: '+json.dumps({'start':start,'partition':partition,'filesystem':after,'disk':disk_bytes}))
os.sync()
print(json.dumps({'diskBytes':disk_bytes,'device':device,'beforeFilesystemBytes':before,'filesystemBytes':after,'partitionBytes':partition,'partitionStartBytes':start,'scratchInMemory':True}))
`;}
export const windowsFilesystemGrowth=z.object({diskBytes:z.number().int().positive().safe(),device:z.literal('/dev/sda1'),beforeFilesystemBytes:z.number().int().positive().safe(),filesystemBytes:z.number().int().positive().safe(),partitionBytes:z.number().int().positive().safe(),partitionStartBytes:z.number().int().min(2**20).max(2*GiB),scratchInMemory:z.literal(true)}).strict();
type MaintenanceRuntime=Pick<HyperVRuntime,'broker'|'state'|'stop'|'disconnect'|'startDiskReview'|'startDiskMaintenance'|'inspectGuard'|'management'>;
export async function growWindowsDisk(runtime:MaintenanceRuntime,config:WindowsConfig,targetGiB:number,options:RunOptions={}){
 windowsDiskSize.parse(targetGiB);if(!runtime.broker)throw new AppError('请使用 Windows 普通用户权限代理入口扩容磁盘',409,'FEATURE_UNAVAILABLE');
 if(targetGiB<config.diskGiB)throw new AppError('磁盘容量不能缩小',400,'DISK_GROWTH_SIZE');
 if((await runtime.state(config)).state!=='Off')throw new AppError('请先确认环境已经停止',409,'DISK_GROWTH_STATE');
 const status=windowsDiskGrowthInfo.parse(await runtime.broker.call('disk-growth-status',{id:config.id}));
 if(targetGiB<status.registeredGiB||status.pending&&targetGiB!==status.targetGiB)throw new AppError('请先继续原定容量的扩容，磁盘不能缩小',409,'DISK_GROWTH_PENDING');
 if(!status.pending&&targetGiB===status.registeredGiB){if(config.diskGiB===targetGiB)throw new AppError('请填写大于当前容量的数值',400,'DISK_GROWTH_SIZE');return{diskGiB:targetGiB,reconciled:true};}
 await runtime.disconnect(config.id);
 if(!status.pending){
  const current={...config,diskGiB:status.actualGiB};
  try{await runtime.startDiskReview(current,options);await armMaintenance(runtime,current,options);const guard=await runtime.inspectGuard(current);if(guard.leaseActive||guard.remainingMs!==0)throw Error('Disk review requires a verified closed business network');const reviewed=windowsFilesystemGrowth.parse(JSON.parse(await runtime.management(current,['sudo','-n','python3','-'],{...options,input:windowsRootGrowthScript(status.actualGiB,true),timeoutMs:30000,maxBytes:16384,onOutput:undefined})));if(reviewed.diskBytes!==status.actualGiB*GiB||reviewed.filesystemBytes>reviewed.partitionBytes||reviewed.partitionStartBytes+reviewed.partitionBytes>reviewed.diskBytes)throw Error('Unsupported root geometry');options.signal?.throwIfAborted();}
  finally{await runtime.stop(current);}
 }
 const expanded={...config,diskGiB:targetGiB};let filesystem:z.infer<typeof windowsFilesystemGrowth>|undefined;
 try{
  options.signal?.throwIfAborted();
  const result=z.object({grown:z.literal(true),diskGiB:windowsDiskSize,pending:z.boolean()}).strict().parse(await runtime.broker.call('grow-disk',{id:config.id,targetGiB},{signal:options.signal,timeoutMs:180000}));
  if(result.diskGiB!==targetGiB||!result.pending)throw Error('Unexpected growth journal receipt');
  await runtime.startDiskMaintenance(expanded,options);options.signal?.throwIfAborted();await armMaintenance(runtime,expanded,options);
  const guard=await runtime.inspectGuard(expanded);if(guard.leaseActive||guard.remainingMs!==0)throw Error('Maintenance requires a verified closed business network');
  filesystem=windowsFilesystemGrowth.parse(JSON.parse(await runtime.management(expanded,['sudo','-n','python3','-'],{...options,input:windowsRootGrowthScript(targetGiB),timeoutMs:120000,maxBytes:16384,onOutput:undefined})));
  if(filesystem.diskBytes!==targetGiB*GiB||filesystem.filesystemBytes<filesystem.beforeFilesystemBytes||filesystem.filesystemBytes>filesystem.partitionBytes||filesystem.partitionBytes-filesystem.filesystemBytes>32*2**20||filesystem.partitionStartBytes+filesystem.partitionBytes>filesystem.diskBytes||filesystem.diskBytes-filesystem.partitionStartBytes-filesystem.partitionBytes>32*2**20)throw Error('Filesystem growth capacity did not match the requested disk');
  const after=await runtime.inspectGuard(expanded);if(after.leaseActive||after.remainingMs!==0)throw Error('Maintenance business network changed');options.signal?.throwIfAborted();
 }finally{await runtime.stop(expanded);}
 options.signal?.throwIfAborted();if(!filesystem)throw Error('Filesystem growth not confirmed');
 const complete=z.object({completed:z.literal(true),diskGiB:windowsDiskSize,platformId:z.uuid(),diskIdentifier:windowsDiskIdentifier}).strict().parse(await runtime.broker.call('finish-disk-growth',{id:config.id,targetGiB,filesystemBytes:filesystem.filesystemBytes,partitionStartBytes:filesystem.partitionStartBytes},{signal:options.signal,timeoutMs:60000}));
 if(complete.diskGiB!==targetGiB||complete.platformId!==status.platformId||complete.diskIdentifier!==status.diskIdentifier)throw Error('Disk growth final identity changed');
 return{diskGiB:targetGiB,reconciled:false,filesystem};
}
