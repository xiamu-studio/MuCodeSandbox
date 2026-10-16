import { WebSocket } from 'ws';
import { audioFormatMatches, decodeAudioPacket } from '../shared/guest-audio.ts';

export interface GuestAudioSignalProof {
  packets: number; samples: number; nonzeroSamples: number; peak: number; rms: number;
  sampleRate: number; channels: number; estimatedFrequencyHz: number | null;
  signalPresent: boolean; expectedToneDetected: boolean;
}

/** A short bounded receipt. Only aggregate measurements leave memory; raw audio is discarded. */
export function collectGuestAudioSignal(input: {
  endpoint: string; origin: string; ticket: string; startTone(): Promise<unknown>; durationMs?: number;
}): Promise<GuestAudioSignalProof> {
  const endpoint = new URL('/guest-audio', input.endpoint);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.searchParams.set('ticket', input.ticket);
  const durationMs = input.durationMs ?? 3500;
  if (!Number.isFinite(durationMs) || durationMs < 2200 || durationMs > 6000) throw new Error('Audio proof duration must be between 2.2 and 6 seconds');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { origin: input.origin, handshakeTimeout: 5000 });
    let formatted = false, done = false, packets = 0, samples = 0, nonzeroSamples = 0, peak = 0, squares = 0;
    let crossingCount = 0, toneSamples = 0, last = 0;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (error: Error) => { if (done) return; done = true; clearTimeout(timer); socket.terminate(); reject(error); };
    timer = setTimeout(() => fail(new Error('Guest audio format did not arrive')), 5000);
    socket.on('error', fail);
    socket.on('close', () => { if (!done) fail(new Error('Guest audio ended before its signal receipt')); });
    socket.on('message', (data, binary) => {
      if (done) return;
      try {
        if (!formatted) {
          if (binary || !audioFormatMatches(JSON.parse(data.toString()))) throw new Error('Guest audio format mismatch');
          formatted = true; clearTimeout(timer);
          void input.startTone().catch(error => fail(error instanceof Error ? error : new Error(String(error))));
          timer = setTimeout(() => {
            if (done) return; done = true; socket.close();
            const estimatedFrequencyHz = toneSamples > 4800 ? Math.round(crossingCount / (toneSamples / 48000) * 10) / 10 : null;
            const rms = samples ? Math.sqrt(squares / samples) : 0;
            const signalPresent = nonzeroSamples > 4800 && peak > .01 && rms > .001;
            resolve({ packets, samples, nonzeroSamples, peak, rms, sampleRate: 48000, channels: 2, estimatedFrequencyHz, signalPresent,
              expectedToneDetected: signalPresent && estimatedFrequencyHz !== null && Math.abs(estimatedFrequencyHz - 440) < 8 });
          }, durationMs);
          return;
        }
        if (!binary) throw new Error('Unexpected guest audio control frame');
        const decoded = decodeAudioPacket(Uint8Array.from(data as Buffer).buffer);
        if (decoded.sequence !== (packets >>> 0)) throw new Error('Guest audio packet discontinuity');
        packets++;
        // Count crossings over packets with audible energy, excluding the silent warm-up/tail.
        const left = decoded.channels[0];
        const audible = left.some(sample => Math.abs(sample) > .005);
        if (audible) {
          toneSamples += left.length;
          for (const sample of left) { if (last <= 0 && sample > 0) crossingCount++; last = sample; }
        } else { last = 0; }
        for (const channel of decoded.channels) for (const sample of channel) {
          samples++; if (sample !== 0) nonzeroSamples++; peak = Math.max(peak, Math.abs(sample)); squares += sample * sample;
        }
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}
