import { decodeAudioPacket, GUEST_AUDIO_FORMAT } from '../shared/guest-audio.ts';

/** A bounded scheduler; construction/resume must happen in the user's playback click. */
export class GuestAudioPlayer {
  readonly context: AudioContext;
  readonly sources = new Set<AudioBufferSourceNode>();
  nextTime = 0;
  sequence = 0;
  closed = false;
  constructor(context: AudioContext) { this.context = context; }

  push(packet: ArrayBuffer) {
    if (this.closed || this.context.state !== 'running') throw new Error('音频播放已停止');
    const decoded = decodeAudioPacket(packet);
    if (decoded.sequence !== this.sequence) throw new Error('音频数据顺序无效');
    this.sequence = (this.sequence + 1) >>> 0;
    const now = this.context.currentTime;
    if (!this.nextTime || this.nextTime < now + 0.01) this.nextTime = now + 0.06;
    if (this.nextTime - now > 0.25 || this.sources.size >= 16) throw new Error('音频接收延迟过高，请重新开启播放');
    const buffer = this.context.createBuffer(GUEST_AUDIO_FORMAT.channels, GUEST_AUDIO_FORMAT.framesPerPacket, GUEST_AUDIO_FORMAT.sampleRate);
    decoded.channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
    const source = this.context.createBufferSource();
    source.buffer = buffer; source.connect(this.context.destination); this.sources.add(source);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    source.start(this.nextTime); this.nextTime += buffer.duration;
  }

  async close() {
    if (this.closed) return; this.closed = true;
    for (const source of this.sources) { try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); }
    this.sources.clear();
    await this.context.close().catch(() => {});
  }
}
