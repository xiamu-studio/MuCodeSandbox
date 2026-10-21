import path from 'node:path';import {randomUUID} from 'node:crypto';import {readFile,writeFile} from 'node:fs/promises';
import {windowsRuntimeDirectory} from '../server/platform/windows/paths.ts';import {secureWindowsDirectory} from '../server/platform/windows/credentials.ts';
import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';import {run} from '../server/process.ts';
const directory=path.join(windowsRuntimeDirectory(),'ledger-audit-'+randomUUID());await secureWindowsDirectory(directory);
const script=path.resolve('scripts/windows/audit-ledger.ps1'),body=`& '${script.replaceAll("'","''")}' -Directory '${directory.replaceAll("'","''")}' -OwnerPid ${process.pid}`,encoded=Buffer.from(body,'utf16le').toString('base64');
await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop';$p=Start-Process -FilePath '${powershellPath()}' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -Verb RunAs -WindowStyle Hidden -Wait -PassThru;if($p.ExitCode -ne 0){throw 'Read-only registry audit failed'}`),{timeoutMs:120000});
await writeFile('.mu-data/windows-run/ledger-audit.json',JSON.stringify({directory},null,2));
console.log(await readFile(path.join(directory,'audit.json'),'utf8'));
