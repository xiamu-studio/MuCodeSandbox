import {GuestAudioPlayer as BasePlayer} from '../guest-audio-player.ts';

// Windows SSH/renderer callbacks can arrive in bursts. Resynchronize to live
// output rather than keeping stale sound; retain the shared packet validation.
export class GuestAudioPlayer extends BasePlayer {
 resyncs=0;
 override push(packet:ArrayBuffer){
  if(!this.closed&&this.context.state==='running'&&(this.nextTime-this.context.currentTime>.18||this.sources.size>=10)){
   for(const source of this.sources){try{source.stop();}catch{}source.disconnect();}
   this.sources.clear();this.nextTime=0;this.resyncs++;
  }
  super.push(packet);
 }
}
