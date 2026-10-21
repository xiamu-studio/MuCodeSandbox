import {spawn} from 'node:child_process';
import path from 'node:path';
import {powershellPath,powershellArgs} from './runtime.ts';
import {cleanWindowsEnvironment} from './broker.ts';

// Electron/Chromium descendants can retain inherited IPC handles after a forced
// browser-process exit. Pin OS process handles as an independent ownership gate.
export async function watchWindowsDesktopOwner(ownerPid:number,onExit:()=>void){
 if(!Number.isInteger(ownerPid)||ownerPid<1)throw Error('Desktop owner PID required');
 const source=`using System;using System.Runtime.InteropServices;public static class MuDesktopOwnerWait{[DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,int pid);[DllImport("kernel32.dll")]static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint timeout);[DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);public static void Run(int owner,int worker){IntPtr a=OpenProcess(0x101000,false,owner),b=OpenProcess(0x101000,false,worker);if(a==IntPtr.Zero||b==IntPtr.Zero)throw new Exception("Desktop process handle unavailable");try{Console.WriteLine("OWNER_WATCH_READY");Console.Out.Flush();if(WaitForMultipleObjects(2,new[]{a,b},false,0xffffffff)==0){Console.WriteLine("OWNER_EXITED");Console.Out.Flush();}}finally{CloseHandle(a);CloseHandle(b);}}}`;
 const script=`$ErrorActionPreference='Stop';Add-Type -TypeDefinition '${source}';[MuDesktopOwnerWait]::Run(${ownerPid},${process.pid})`;
 const child=spawn(powershellPath(),powershellArgs(script),{cwd:path.dirname(powershellPath()),env:cleanWindowsEnvironment(),stdio:['ignore','pipe','pipe'],windowsHide:true});child.stderr.resume();let stopping=false,ready=false,buffer='';
 let resolveReady!:(value:{stop:()=>void})=>void,rejectReady!:(error:Error)=>void;const result=new Promise<{stop:()=>void}>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const stop=()=>{stopping=true;if(child.exitCode===null)child.kill('SIGKILL');};const timeout=setTimeout(()=>{stop();rejectReady(Error('Desktop owner monitor did not initialize'));},10000);timeout.unref();
 child.stdout.on('data',bytes=>{buffer+=bytes.toString();if(buffer.length>4096){stop();rejectReady(Error('Invalid desktop owner monitor output'));return;}if(!ready&&buffer.includes('OWNER_WATCH_READY')){ready=true;clearTimeout(timeout);resolveReady({stop});}if(buffer.includes('OWNER_EXITED')&&!stopping){stopping=true;onExit();}});
 child.once('error',error=>{clearTimeout(timeout);if(!ready)rejectReady(error);else if(!stopping)onExit();});child.once('exit',()=>{clearTimeout(timeout);if(!ready)rejectReady(Error('Desktop owner monitor exited before initialization'));else if(!stopping)onExit();});return result;
}
