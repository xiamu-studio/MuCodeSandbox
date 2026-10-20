import path from 'node:path';
import {homedir} from 'node:os';
import {existsSync} from 'node:fs';

export function windowsPreviewRoot(){return path.join(process.env.LOCALAPPDATA??homedir(),'MuCodeSandbox-WindowsPreview');}
export function windowsAppDirectory(override?:string){return path.resolve(override??process.env.MU_WINDOWS_APP_DIR??path.join(windowsPreviewRoot(),'app'));}
export function windowsRuntimeDirectory(override?:string,appDirectory=windowsAppDirectory()){
 const selected=override??process.env.MU_WINDOWS_DATA_DIR;if(selected)return path.resolve(selected);
 // Retain directories used by the first management preview. New CLI and UI
 // entry points otherwise share the same root; no existing VM is relocated.
 const legacy=path.join(appDirectory,'hyperv');return existsSync(legacy)?legacy:path.resolve(windowsPreviewRoot());
}
