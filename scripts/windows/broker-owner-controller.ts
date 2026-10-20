import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {HyperVRuntime} from '../../server/platform/windows/runtime.ts';
import {startBroker,installedBrokerPath} from '../../server/platform/windows/broker.ts';
import {windowsConfigSchema} from '../../server/platform/windows/config.ts';
import {localFixtures,LAB_EXIT} from './local-fixtures.ts';

async function main(){
const [root,file,directory]=process.argv.slice(2),fixture=await localFixtures(directory,'C:\\Program Files\\Git\\usr\\bin\\openssl.exe');let broker:Awaited<ReturnType<typeof startBroker>>|undefined;
try{
broker=await startBroker(await installedBrokerPath());
const c=windowsConfigSchema.parse({...JSON.parse(await readFile(file,'utf8')),proxy:{mode:'http',address:'127.0.0.1',port:fixture.port},dns:fixture.dns}),runtime=new HyperVRuntime(root,undefined,broker);
await runtime.start(c);
await runtime.management(c,['sudo','tee','/etc/mucodesandbox/owner-lab-ca.crt'],{input:fixture.certificate});await runtime.management(c,['sudo','tee','/usr/local/share/ca-certificates/mu-local-fixture.crt'],{input:fixture.certificate});await runtime.management(c,['sudo','update-ca-certificates'],{timeoutMs:30000});
const session=await runtime.session(c,async()=>Promise.all(fixture.probeHosts.map(async receiver=>({receiver,ip:JSON.parse(await runtime.management(c,['sudo','-H','-u','mu-probe','--','curl','-q','--fail','--silent','--show-error','--max-time','4','--cacert','/etc/mucodesandbox/owner-lab-ca.crt','--proxy','socks5h://127.0.0.1:17402',`https://${receiver}/`])).ip}))));
await runtime.connect(c);await session.open();const vm=await runtime.state(c);process.send?.({active:true,id:c.id,platformId:vm.platformId,expected:LAB_EXIT});
setInterval(()=>{void session.tick().catch(error=>{process.send?.({error:error.message});});},8000);
}catch(error){await broker?.call('shutdown').catch(()=>{});await fixture.close();throw error;}
}
main().catch(error=>{const message=error instanceof Error?error.message:'Owner activation failed';process.send?.({error:message});console.error(message);process.exitCode=1;process.disconnect?.();});
