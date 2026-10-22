import type {TransferZone} from './guest-exchange.ts';

export interface WindowsTransferDirectory {kind:'directory';zone:TransferZone;name:string;path:string;relativePath:string}
export function windowsDirectoryNameIssue(name:string){
 if(!name.trim())return '请输入文件夹名称';
 if(/[\\/\x00-\x1f\x7f]/.test(name)||/[\uD800-\uDFFF]/u.test(name))return '名称不能包含路径、控制字符或不完整的 Unicode 字符';
 if(name.startsWith('.')||/\.(?:part|tmp|crdownload)$/.test(name))return '请使用文件列表中可见的名称，不能以点开头或使用临时文件后缀';
 if(new TextEncoder().encode(name).length>180)return '文件夹名称最多 180 个 UTF-8 字节';
 return null;
}
