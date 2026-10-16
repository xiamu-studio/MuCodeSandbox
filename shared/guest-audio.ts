/** The output bridge carries real PCM from the guest sink, never host capture. */
export const GUEST_AUDIO_FORMAT = {
  type: 'format', version: 1, sampleRate: 48_000, channels: 2,
  sampleFormat: 's16le', framesPerPacket: 960,
} as const;
export const GUEST_AUDIO_PCM_BYTES = GUEST_AUDIO_FORMAT.framesPerPacket * GUEST_AUDIO_FORMAT.channels * 2;
export const GUEST_AUDIO_PACKET_BYTES = GUEST_AUDIO_PCM_BYTES + 4;
export const GUEST_AUDIO_MAX_BUFFERED_BYTES = GUEST_AUDIO_PACKET_BYTES * 10;

export function audioFormatMatches(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const format = value as Record<string, unknown>;
  return Object.entries(GUEST_AUDIO_FORMAT).every(([key, expected]) => format[key] === expected);
}

export function encodeAudioPacket(sequence: number, pcm: Uint8Array): Uint8Array {
  if (pcm.byteLength !== GUEST_AUDIO_PCM_BYTES) throw new Error('Invalid guest audio frame length');
  const packet = new Uint8Array(GUEST_AUDIO_PACKET_BYTES);
  new DataView(packet.buffer).setUint32(0, sequence >>> 0, true);
  packet.set(pcm, 4);
  return packet;
}

export function decodeAudioPacket(packet: ArrayBuffer): { sequence: number; channels: Float32Array<ArrayBuffer>[] } {
  if (packet.byteLength !== GUEST_AUDIO_PACKET_BYTES) throw new Error('音频数据长度无效');
  const view = new DataView(packet);
  const channels = Array.from({ length: GUEST_AUDIO_FORMAT.channels }, () => new Float32Array(GUEST_AUDIO_FORMAT.framesPerPacket));
  for (let frame = 0; frame < GUEST_AUDIO_FORMAT.framesPerPacket; frame++) {
    for (let channel = 0; channel < GUEST_AUDIO_FORMAT.channels; channel++) {
      channels[channel][frame] = view.getInt16(4 + (frame * GUEST_AUDIO_FORMAT.channels + channel) * 2, true) / 32768;
    }
  }
  return { sequence: view.getUint32(0, true), channels };
}
