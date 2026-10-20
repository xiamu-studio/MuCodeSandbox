import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {realpath} from 'node:fs/promises';
import {AppError} from '../../errors.ts';

// Windows closes the pipe when its owner exits, including after a crash. No
// stale PID file can cause two controllers to open the same encrypted store.
export async function acquireWindowsServiceLock(directory:string){
 const identity=(await realpath(directory)).toLowerCase();
 const pipe='\\\\.\\pipe\\MuCodeSandbox-'+createHash('sha256').update(identity).digest('hex');
 const server=createServer(socket=>socket.destroy());
 try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});}
 catch(error){server.close();if(['EADDRINUSE','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw new AppError('此 Windows 工作区已在运行，请使用已打开的窗口',409,'ALREADY_RUNNING');throw error;}
 return ()=>new Promise<void>(resolve=>server.close(()=>resolve()));
}
