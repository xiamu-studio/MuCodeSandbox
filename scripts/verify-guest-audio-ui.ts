import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { WebSocket, WebSocketServer } from 'ws';
import { encodeAudioPacket, GUEST_AUDIO_FORMAT, GUEST_AUDIO_PCM_BYTES } from '../shared/guest-audio.ts';

// Local fixture PCM only. Real host AudioContext and output graph; no VM or input capture.
const root = path.resolve(import.meta.dirname, '..');
const results = path.join(root, 'test-results', 'guest-audio'); await mkdir(results, { recursive: true });
const entry = '/audio-proof-entry.tsx';
const vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'guest-audio-proof',
  resolveId(id) { if (id === entry) return entry; },
  load(id) { if (id === entry) return `import React from 'react'; import {createRoot} from 'react-dom/client'; import GuestAudio from '/src/GuestAudio.tsx'; createRoot(document.getElementById('root')).render(<GuestAudio id="audio-fixture" connected={true}/>);`; },
  configureServer(server) { server.middlewares.use('/audio-proof.html', (_request, response) => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Local audio proof</title></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`;
    void server.transformIndexHtml('/audio-proof.html', html).then(transformed => { response.setHeader('Content-Type', 'text/html'); response.end(transformed); }, error => { response.statusCode = 500; response.end(String(error)); });
  }); },
}] });
await vite.listen(); const address = vite.httpServer!.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: process.argv.includes('--headless'), ignoreDefaultArgs: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 700, height: 250 } });
page.setDefaultTimeout(8000);
const errors: string[] = [], peers = new Set<WebSocket>(); let issued = 0, streams = 0, closed = 0;
page.on('pageerror', error => errors.push(error.message));
const wss = new WebSocketServer({ noServer: true });
vite.httpServer!.on('upgrade', (request, socket, head) => {
  if (request.url?.startsWith('/guest-audio?')) wss.handleUpgrade(request, socket, head, peer => {
    peers.add(peer); streams++; peer.send(JSON.stringify(GUEST_AUDIO_FORMAT));
    let sequence = 0;
    const timer = setInterval(() => {
      if (peer.readyState !== WebSocket.OPEN) return;
      const pcm = new Uint8Array(GUEST_AUDIO_PCM_BYTES), view = new DataView(pcm.buffer);
      for (let frame = 0; frame < GUEST_AUDIO_FORMAT.framesPerPacket; frame++) {
        const sample = Math.round(Math.sin((sequence * GUEST_AUDIO_FORMAT.framesPerPacket + frame) / 48000 * Math.PI * 880) * 819);
        view.setInt16(frame * 4, sample, true); view.setInt16(frame * 4 + 2, sample, true);
      }
      peer.send(encodeAudioPacket(sequence++, pcm), { binary: true });
    }, 20);
    peer.once('close', () => { clearInterval(timer); peers.delete(peer); closed++; });
  });
});
await page.route('**/api/environments/audio-fixture/guest-audio-ticket', async route => {
  issued++; await route.fulfill({ json: { ticket: 'local-audio-proof' } });
});
await page.addInitScript(() => {
  const Original = window.AudioContext;
  (window as any).__audioProof = [];
  class ObservedAudioContext extends Original {
    constructor(options?: AudioContextOptions) {
      super(options);
      const analyser = this.createAnalyser(); analyser.fftSize = 2048;
      const observationGain = this.createGain(); observationGain.gain.value = 0;
      analyser.connect(observationGain).connect(this.destination);
      const record = { context: this, analyser, sourceStarts: 0, sourceStops: 0, destinationConnections: 0 };
      (window as any).__audioProof.push(record);
      const create = this.createBufferSource.bind(this);
      this.createBufferSource = () => {
        const source = create(), start = source.start.bind(source), stop = source.stop.bind(source), connect = source.connect.bind(source);
        // A native analyser branch observes the same source; the product still connects to native destination.
        connect(analyser);
        source.start = (...args: Parameters<AudioBufferSourceNode['start']>) => { record.sourceStarts++; start(...args); };
        source.stop = (...args: Parameters<AudioBufferSourceNode['stop']>) => { record.sourceStops++; stop(...args); };
        source.connect = ((destination: AudioNode, output?: number, input?: number) => { if (destination === this.destination) record.destinationConnections++; return connect(destination, output, input); }) as typeof source.connect;
        return source;
      };
    }
  }
  window.AudioContext = ObservedAudioContext;
});
try {
  await page.goto(`${origin}/audio-proof.html`);
  const button = page.getByRole('button', { name: '开启声音', exact: true }); await button.waitFor();
  assert.equal(issued, 0); assert.equal(streams, 0);
  assert.equal(await page.evaluate(() => (window as any).__audioProof.length), 0);
  await button.click(); await page.getByRole('button', { name: '关闭声音', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const record = (window as any).__audioProof[0]; if (!record || record.context.state !== 'running') return false;
    const samples = new Float32Array(record.analyser.fftSize); record.analyser.getFloatTimeDomainData(samples);
    return record.destinationConnections > 0 && samples.some(value => Math.abs(value) > .005);
  });
  const playing = await page.evaluate(() => {
    const record = (window as any).__audioProof[0], samples = new Float32Array(record.analyser.fftSize); record.analyser.getFloatTimeDomainData(samples);
    return { state: record.context.state, sampleRate: record.context.sampleRate, destinationChannels: record.context.destination.channelCount, destinationConnections: record.destinationConnections, sourceStarts: record.sourceStarts, peak: Math.max(...samples.map(Math.abs)) };
  });
  assert.ok(playing.peak > .005); assert.ok(playing.sourceStarts > 0); assert.equal(playing.state, 'running');
  await page.screenshot({ path: path.join(results, 'host-playback.png') });
  await page.getByRole('button', { name: '关闭声音', exact: true }).click();
  await button.waitFor(); await page.waitForFunction(() => (window as any).__audioProof[0].context.state === 'closed');
  const deadline = Date.now() + 2000; while (!closed) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(peers.size, 0); assert.deepEqual(errors, []);
  const stopped = await page.evaluate(() => { const record = (window as any).__audioProof[0]; return { state: record.context.state, sourceStops: record.sourceStops }; });
  assert.ok(stopped.sourceStops > 0);
  const report = { passed: true, fixturePCM: true, nativeHostAudioContext: true, headed: !process.argv.includes('--headless'), physicalAudibilityConfirmed: false,
    claims: ['default off creates no AudioContext or transport', 'click resumes native AudioContext', 'real PCM reaches native analyser and destination graph', 'toggle off closes context and stops queued sources', 'toggle off closes output-only transport'], issued, streams, closed, playing, stopped, errors };
  await writeFile(path.join(results, 'host-playback.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(path.join(results, 'host-playback-failure.json'), JSON.stringify({ error: String(error), errors, body: await page.locator('body').innerText(), issued, streams, closed,
    contexts: await page.evaluate(() => ((window as any).__audioProof ?? []).map((record: any) => { const data = new Float32Array(record.analyser.fftSize); record.analyser.getFloatTimeDomainData(data); return { state: record.context.state, time: record.context.currentTime, sourceStarts: record.sourceStarts, sourceStops: record.sourceStops, destinationConnections: record.destinationConnections, peak: Math.max(...data.map(Math.abs)) }; })) }, null, 2));
  throw error;
} finally {
  await browser.close(); for (const peer of peers) peer.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await vite.close();
}
