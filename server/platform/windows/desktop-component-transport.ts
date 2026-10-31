import {createHash} from 'node:crypto';
import type {DesktopAppId} from '../../../shared/guest-desktop.ts';
import {AppError} from '../../errors.ts';
import {windowsDesktopAsset} from './desktop-assets.ts';
import {windowsDesktopComponentProgram} from './desktop-component.ts';

export const DESKTOP_COMPONENT_PROGRAM_LIMIT=2*1024*1024;
export const DESKTOP_COMPONENT_ARCHIVE_LIMIT=256*1024*1024;

// Keep the Windows SSH command short. The independently hashed program and
// bounded archive are binary stdin frames; component code still checks every
// archive/file digest. Publish stdout only after the entire frame is checked.
export const WINDOWS_DESKTOP_FRAME_BOOTSTRAP=String.raw`import sys,struct,hashlib,types
def exact(n):
 parts=[]
 while n:
  part=sys.stdin.buffer.read(min(n,65536))
  if not part:raise ValueError('Truncated frame')
  parts.append(part);n-=len(part)
 return b''.join(parts)
class Output:
 def __init__(self):self.parts=[];self.size=0
 def write(self,text):
  self.size+=len(text.encode('utf8'))
  if self.size>8192:raise ValueError('Output limit')
  self.parts.append(text);return len(text)
 def flush(self):pass
class Payload:
 def __init__(self,source,count):self.source=source;self.remaining=count
 def read(self,n=-1):
  if n is None:n=-1
  if type(n) is not int:raise ValueError('Invalid read')
  n=self.remaining if n<0 else min(n,self.remaining);parts=[];left=n
  while left:
   part=self.source.read(min(left,65536))
   if not part:raise ValueError('Truncated payload')
   parts.append(part);left-=len(part)
  self.remaining-=n;return b''.join(parts)
original_in=sys.stdin;original_out=sys.stdout
try:
 if len(sys.argv)!=2 or len(sys.argv[1])!=64 or any(c not in '0123456789abcdef' for c in sys.argv[1]):raise ValueError('Program identity')
 header=exact(16)
 if header[:8]!=b'MUCDSK01':raise ValueError('Protocol')
 size,count=struct.unpack('>II',header[8:])
 if not 0<size<=2097152 or count>268435456:raise ValueError('Frame limits')
 program=exact(size)
 if hashlib.sha256(program).hexdigest()!=sys.argv[1]:raise ValueError('Program identity')
 payload=Payload(original_in.buffer,count);output=Output();sys.stdin=types.SimpleNamespace(buffer=payload);sys.stdout=output
 exec(compile(program,'mu-desktop-component','exec'),{'__name__':'__main__'})
 while payload.remaining:payload.read(min(payload.remaining,65536))
 if original_in.buffer.read(1):raise ValueError('Trailing frame bytes')
 sys.stdout=original_out;sys.stdin=original_in;original_out.write(''.join(output.parts));original_out.flush()
except BaseException:
 sys.stdout=original_out;sys.stdin=original_in;sys.stderr.write('Desktop component input or execution could not be verified\n');raise SystemExit(78)
`;

export function frameWindowsDesktopProgram(program:string,archive:Uint8Array=new Uint8Array()){
 if(typeof program!=='string'||program.length>DESKTOP_COMPONENT_PROGRAM_LIMIT||!(archive instanceof Uint8Array))throw new AppError('桌面组件输入格式无法核对',400,'DESKTOP_COMPONENT_INPUT');
 const code=Buffer.from(program,'utf8');
 if(!code.length||code.length>DESKTOP_COMPONENT_PROGRAM_LIMIT||archive.byteLength>DESKTOP_COMPONENT_ARCHIVE_LIMIT)throw new AppError('桌面组件输入超过限定大小',400,'DESKTOP_COMPONENT_INPUT');
 const programSha256=createHash('sha256').update(code).digest('hex'),header=Buffer.alloc(16);header.write('MUCDSK01',0,'ascii');header.writeUInt32BE(code.length,8);header.writeUInt32BE(archive.byteLength,12);
 return {command:['/usr/bin/python3','-I','-c',WINDOWS_DESKTOP_FRAME_BOOTSTRAP,programSha256],inputBytes:Buffer.concat([header,code,archive]),programSha256,programBytes:code.length,archiveBytes:archive.byteLength};
}

export function windowsDesktopComponentInvocation(id:DesktopAppId,mode:'inspect'|'install',archive?:Uint8Array){
 if(mode!=='inspect'&&mode!=='install')throw new AppError('桌面组件操作无法核对',400,'DESKTOP_COMPONENT_INPUT');
 const asset=windowsDesktopAsset(id);
 if(mode==='inspect'?archive!==undefined:!(archive instanceof Uint8Array)||archive.byteLength!==asset.bytes)throw new AppError('桌面组件归档长度无法核对',400,'DESKTOP_COMPONENT_INPUT');
 const framed=frameWindowsDesktopProgram(windowsDesktopComponentProgram(id,mode),archive);
 return {...framed,command:mode==='install'?['sudo','-n',...framed.command]:framed.command};
}
