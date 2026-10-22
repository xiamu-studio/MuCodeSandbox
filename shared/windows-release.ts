// Windows releases are independent of the shipping Mac package version.
export const WINDOWS_SOURCE_VERSION='0.4.66-preview.7';
export interface WindowsRelease {version:string;fileVersion:string;parts:[number,number,number,number]}
export function windowsRelease(value:unknown):WindowsRelease{
 if(typeof value!=='string')throw Error('Invalid Windows release');
 const match=/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})(?:-preview\.([1-9]\d{0,4}))?$/.exec(value);
 if(!match)throw Error('Invalid Windows release');const parts=match.slice(1,4).map(Number);if(parts.some(value=>value>65535))throw Error('Windows release exceeds file version bounds');
 const revision=match[4]?Number(match[4]):65535;if(match[4]&&revision>65534)throw Error('Windows preview revision exceeds its bounds');
 return {version:value,fileVersion:[...parts,revision].join('.'),parts:[parts[0],parts[1],parts[2],revision]};
}
export function compareWindowsReleases(left:string,right:string){const a=windowsRelease(left).parts,b=windowsRelease(right).parts;for(let index=0;index<a.length;index++){if(a[index]!==b[index])return a[index]<b[index]?-1:1;}return 0;}
