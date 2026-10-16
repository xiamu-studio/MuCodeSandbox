import { mkdtemp,writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createService } from '../server/service.ts';
const root=path.resolve(import.meta.dirname,'..');
const owned=await mkdtemp(path.join(homedir(),'.mu-usability-preview-'));
process.env.MU_LIMA_PATH=path.join(homedir(),'.mucodesandbox/tools/lima/bin/limactl');
const service=await createService({rootDir:root,dataDir:owned,port:0});
await service.manager.create({name:'越南线路 · 测试环境',description:'本机独立线路 · 尚未启动',cpus:2,memoryGiB:2,diskGiB:10,
  network:{mode:'http',host:'127.0.0.1',port:24897,username:'',strict:true,transparent:true,noProxy:'localhost,127.0.0.1,::1'},identity:{locale:'zh-TW',timezone:'Asia/Taipei'}});
await service.manager.create({name:'日常开发',description:'先配置线路，再启用强制防护',cpus:2,memoryGiB:2,diskGiB:20});
await writeFile(path.join(root,'test-results/usability-preview-private.json'),JSON.stringify({owned,pid:process.pid,url:service.url,launchUrl:service.launchUrl()}),{mode:0o600});
console.log(JSON.stringify({owned,pid:process.pid,url:service.url,privateLinkFile:'test-results/usability-preview-private.json',vmStarted:false}));
const shutdown=()=>void service.close().then(()=>process.exit(0));
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
