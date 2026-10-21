import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {prepareWindowsPackage} from './windows/package-runtime.ts';
const stage=await prepareWindowsPackage();await writeFile(path.resolve('.mu-data/windows-run/desktop-stage.json'),JSON.stringify(stage,null,2));
const child=spawn(stage.electron,[stage.app],{stdio:'inherit',env:{...process.env,MU_WINDOWS_NODE_EXE:stage.nodeExe},windowsHide:false});child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
