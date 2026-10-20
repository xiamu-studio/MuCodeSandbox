import path from 'node:path';
import {installedBrokerPath,startBroker} from '../server/platform/windows/broker.ts';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';
import {HyperVRuntime} from '../server/platform/windows/runtime.ts';
import {createWindowsService} from '../server/platform/windows/service.ts';

const broker=await startBroker(await installedBrokerPath());
let service:Awaited<ReturnType<typeof createWindowsService>>|undefined;
try{
 const runtimeRoot=windowsRuntimeDirectory();service=await createWindowsService({rootDir:path.resolve(import.meta.dirname,'..'),runtimeRoot,runtime:new HyperVRuntime(runtimeRoot,undefined,broker)});
 console.log('Windows 普通用户管理预览；Hyper-V 由受限代理处理：');console.log(service.launchUrl());
 let closing:Promise<void>|undefined;const close=()=>closing??=(async()=>{try{await service!.close();}finally{await broker.call('shutdown').catch(()=>{});}})();
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void close().catch(()=>{process.exitCode=1;});});
}catch(error){await service?.close().catch(()=>{});await broker.call('shutdown').catch(()=>{});throw error;}
