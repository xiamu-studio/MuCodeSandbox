import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const version=process.argv[2]??'2.1.296';
if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid version');
const root=path.resolve(import.meta.dirname,'..','test-results/client-environment-audit');
const dir=path.join(root,'packages',version),receipt=JSON.parse(await readFile(path.join(dir,'receipt.json'),'utf8'));
const binary=await readFile(path.join(dir,receipt.binary));
if(createHash('sha256').update(binary).digest('hex')!==receipt.sha256)throw Error('Executable differs from verified package');
const groups={
 virtualization:['systemd-detect-virt','/sys/class/dmi/id','/sys/devices/virtual/dmi','/sys/firmware/devicetree','/sys/hypervisor','hypervisor','virtio','Virtualization.framework','QEMU','KVM','VMware','VirtualBox'],
 containers:['/.dockerenv','/proc/self/cgroup','/proc/1/cgroup','isDocker','isContainer','isWsl','WSL_DISTRO_NAME','WSL_INTEROP','container'],
 system:['/etc/os-release','/proc/cpuinfo','/proc/meminfo','/proc/version','/etc/machine-id','os.arch','os.platform','os.release','os.hostname','process.arch','process.platform','platformVersion','uname','machineId','deviceId'],
 metadata:['envInfo','environmentInfo','environmentMetadata','runtimeMetadata','userAgent','clientVersion','telemetry','DISABLE_TELEMETRY','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','DISABLE_ERROR_REPORTING','docker','sshSession','SSH_CONNECTION'],
};
const hits=[];
for(const[group,needles]of Object.entries(groups))for(const needle of needles){
 let offset=0,count=0;const contexts=[];
 while((offset=binary.indexOf(Buffer.from(needle),offset))>=0){
  count++;if(contexts.length<12){const start=Math.max(0,offset-260),end=Math.min(binary.length,offset+needle.length+400);
   const text=binary.subarray(start,end).toString('utf8').replace(/[^\x09\x0a\x0d\x20-\x7e]/g,'·');
   contexts.push({offset,text});
  }offset+=needle.length;if(count>=256)break;
 }
 hits.push({group,needle,count,countCapped:count>=256,contexts});
}
const report={checkedAt:new Date().toISOString(),version,sha256:receipt.sha256,
 scope:'Literal search of the unmodified verified native ELF. Presence does not establish invocation or data transmission; absence does not prove no equivalent compiled check.',hits};
await mkdir(path.join(root,'static'),{recursive:true,mode:0o700});
await writeFile(path.join(root,'static',`${version}.json`),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({version,sha256:receipt.sha256,hits:hits.filter(h=>h.count).map(({group,needle,count,countCapped})=>({group,needle,count,countCapped}))},null,2));
