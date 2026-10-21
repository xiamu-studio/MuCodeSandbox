import {readFile,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {WINDOWS_SOURCE_VERSION,windowsRelease} from '../../../shared/windows-release.ts';
const metadata=new URL('../../../windows-release.json',import.meta.url);
export async function installedWindowsRelease(file:URL=metadata){
 const pkg=fileURLToPath(import.meta.url).endsWith('.ts')?null:JSON.parse(await readFile(new URL('../../../../package.json',import.meta.url),'utf8'));
 try{const entry=await lstat(file);if(!entry.isFile()||entry.isSymbolicLink()||entry.size>4096)throw Error('Windows release metadata changed');const saved=JSON.parse(await readFile(file,'utf8'));const release=windowsRelease(saved.version);if(saved.format!==1||saved.fileVersion!==release.fileVersion||Object.keys(saved).some(key=>!['format','version','fileVersion'].includes(key))||pkg?.name==='mucodesandbox-windows-preview'&&pkg.version!==release.version)throw Error('Windows release metadata changed');return release;}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  if(file.href!==metadata.href||pkg?.name==='mucodesandbox-windows-preview')throw Error('Windows release metadata is missing');
  return windowsRelease(WINDOWS_SOURCE_VERSION);
 }
}
export const VERSION=(await installedWindowsRelease()).version;
