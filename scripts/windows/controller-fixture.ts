import {readFile} from 'node:fs/promises';
import {HyperVRuntime} from '../../server/platform/windows/runtime.ts';
import {windowsConfigSchema,PROBE_PORT} from '../../server/platform/windows/config.ts';
import {LAB_PROBE_HOSTS} from './local-fixtures.ts';

// Disposable owner for the real controller-death experiment. All destinations
// are the local acceptance endpoints; no production measurement is invoked.
const [root,file]=process.argv.slice(2),c=windowsConfigSchema.parse(JSON.parse(await readFile(file,'utf8'))),runtime=new HyperVRuntime(root);
try{
  await runtime.start(c);
  const session=await runtime.session(c,async()=>Promise.all(LAB_PROBE_HOSTS.map(async receiver=>{
    const output=await runtime.management(c,['sudo','-n','-H','-u','mu-probe','--','env','-i','PATH=/usr/bin:/bin','curl','-q','--fail','--silent','--show-error','--max-time','3','--cacert','/etc/mucodesandbox/lab-ca.crt','--proxy',`socks5h://127.0.0.1:${PROBE_PORT}`,'--noproxy','',`https://${receiver}/`],{timeoutMs:10000});
    return {receiver,ip:JSON.parse(output).ip};
  })));
  await runtime.connect(c);await session.open();process.send?.({active:true,pid:process.pid});
  const timer=setInterval(()=>{void session.tick().catch(error=>{clearInterval(timer);process.send?.({error:String(error)});});},8000);
}catch(error){process.send?.({error:String(error)});await runtime.stop(c);process.exitCode=1;process.disconnect?.();}
