import path from 'node:path';
import {createWindowsService} from '../server/platform/windows/service.ts';

// A source preview only. The Mac Electron entry and release target are unchanged.
const service=await createWindowsService({rootDir:path.resolve(import.meta.dirname,'..'),
 dataDir:process.env.MU_WINDOWS_APP_DIR,runtimeRoot:process.env.MU_WINDOWS_DATA_DIR});
console.log('Windows 管理预览（仅本机；关闭此进程会停止其环境）：');
console.log(service.launchUrl());
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void service.close().catch(()=>{process.exitCode=1;});});
