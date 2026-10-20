import path from 'node:path';
import {spawnWindowsTerminal} from '../../server/platform/windows/terminal-process.ts';
const terminal=spawnWindowsTerminal(path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-Command',"[Console]::WriteLine('MU_OWNER_READY');Start-Sleep -Seconds 30"],{cwd:process.cwd(),env:process.env,cols:80,rows:24,useConpty:true,useConptyDll:true});
let reported=false;
terminal.onData(data=>{if(data.includes('\x1b[c'))terminal.write('\x1b[?1;2c');if(data.includes('MU_OWNER_READY')&&!reported){reported=true;process.send?.({workerPid:terminal.pid});}});
