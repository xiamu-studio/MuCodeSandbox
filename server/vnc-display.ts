import { createConnection, type Socket } from 'node:net';
import { createCipheriv } from 'node:crypto';

export function vncChallenge(password:string,challenge:Buffer) {
  if(!/^[A-Za-z0-9_-]{8}$/.test(password)||challenge.length!==16)throw new Error('Invalid VNC authentication');
  const key=Buffer.from([...Buffer.from(password)].map(byte=>{let reversed=0;for(let i=0;i<8;i++)reversed=(reversed<<1)|((byte>>i)&1);return reversed;}));
  // Three equal DES-EDE keys are equivalent to the DES challenge required by VncAuth.
  const cipher=createCipheriv('des-ede3',Buffer.concat([key,key,key]),null);cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge),cipher.final()]);
}
class Reader {
  buffer=Buffer.alloc(0); pending?:{size:number;resolve:(b:Buffer)=>void;reject:(e:Error)=>void};failure?:Error;
  socket:Socket;
  constructor(socket:Socket){this.socket=socket;socket.on('data',chunk=>{if(this.buffer.length+chunk.length>1_000_000){this.fail(new Error('VNC response too large'));socket.destroy();return;}this.buffer=Buffer.concat([this.buffer,chunk]);this.flush();});socket.on('error',e=>this.fail(e));socket.on('close',()=>this.fail(new Error('VNC connection closed')));}
  fail(e:Error){this.failure=e;this.pending?.reject(e);this.pending=undefined;}
  flush(){if(this.pending&&this.buffer.length>=this.pending.size){const p=this.pending;this.pending=undefined;const b=this.buffer.subarray(0,p.size);this.buffer=this.buffer.subarray(p.size);p.resolve(b);}}
  read(size:number):Promise<Buffer>{if(this.failure)return Promise.reject(this.failure);if(size<0||size>1_000_000||this.pending)return Promise.reject(new Error('Invalid VNC response'));return new Promise((resolve,reject)=>{this.pending={size,resolve,reject};this.flush();});}
}
function desktopRequest(width:number,height:number,screenId:number,flags:number){const b=Buffer.alloc(24);b[0]=251;b.writeUInt16BE(width,2);b.writeUInt16BE(height,4);b[6]=1;b.writeUInt32BE(screenId,8);b.writeUInt16BE(width,16);b.writeUInt16BE(height,18);b.writeUInt32BE(flags,20);return b;}
export async function resizeVncDisplay(socketPath:string,password:string,width:number,height:number) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<320||height<240||width>8192||height>8192||width*height>16_000_000)throw new Error('Invalid display dimensions');
  const socket=createConnection({path:socketPath}),reader=new Reader(socket);
  const timer=setTimeout(()=>{reader.fail(new Error('Display resize timeout'));socket.destroy();},6000);
  try {
    const version=(await reader.read(12)).toString();if(version!=='RFB 003.008\n')throw new Error('Unsupported VNC version');socket.write(version);
    const count=(await reader.read(1))[0];if(count<1||count>32)throw new Error('Invalid VNC security offer');
    const types=await reader.read(count);if(!types.includes(2))throw new Error('VNC authentication required');socket.write(Buffer.from([2]));
    socket.write(vncChallenge(password,await reader.read(16)));if((await reader.read(4)).readUInt32BE(0)!==0)throw new Error('VNC authentication failed');
    socket.write(Buffer.from([1]));const initial=await reader.read(24),nameLength=initial.readUInt32BE(20);if(nameLength>4096)throw new Error('Invalid desktop name');await reader.read(nameLength);
    const bytes=initial[4]/8;if(![2,4].includes(bytes))throw new Error('Unsupported VNC pixel format');
    const enc=Buffer.alloc(12);enc[0]=2;enc.writeUInt16BE(2,2);enc.writeInt32BE(-308,4);enc.writeInt32BE(0,8);socket.write(enc);
    const request=()=>{const b=Buffer.alloc(10);b[0]=3;b.writeUInt16BE(1,6);b.writeUInt16BE(1,8);socket.write(b);};request();
    let requested=false;
    for(let message=0;message<20;message++) {
      const type=(await reader.read(1))[0];
      if(type===2)continue;
      if(type===3){const h=await reader.read(7),size=h.readUInt32BE(3);if(size>65536)throw new Error('Unexpected clipboard data');await reader.read(size);continue;}
      if(type!==0)throw new Error('Unexpected VNC message');
      const header=await reader.read(3),rectangles=header.readUInt16BE(1);if(rectangles>32)throw new Error('Too many VNC rectangles');
      let layout:{id:number;flags:number}|undefined;
      for(let r=0;r<rectangles;r++){
        const h=await reader.read(12),w=h.readUInt16BE(4),heightReply=h.readUInt16BE(6),encoding=h.readInt32BE(8);
        if(encoding===0){const size=w*heightReply*bytes;if(size>65536)throw new Error('Unexpected framebuffer data');await reader.read(size);}
        else if(encoding===-308){const meta=await reader.read(4),screens=meta[0];if(screens<1||screens>16)throw new Error('Invalid screen layout');const data=await reader.read(screens*16);layout={id:data.readUInt32BE(0),flags:data.readUInt32BE(12)};
          if(requested&&h.readUInt16BE(0)===1){if(h.readUInt16BE(2)!==0||w!==width||heightReply!==height)throw new Error('Display resize rejected');return {width:w,height:heightReply};}
        }else if(encoding!==-223)throw new Error('Unsupported VNC rectangle');
      }
      if(!requested&&layout){socket.write(desktopRequest(width,height,layout.id,layout.flags));requested=true;request();}
      else request();
    }
    throw new Error('Display resize was not confirmed');
  } finally {clearTimeout(timer);socket.destroy();}
}
