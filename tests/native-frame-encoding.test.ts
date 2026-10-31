import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { nativeFrameEncodingSource } from '../scripts/native-frame-encoding.ts';
import { retainedFrameUpdatesSource } from '../scripts/retained-frame-updates.ts';

const original = await readFile(new URL('../node_modules/@novnc/novnc/core/base64.js', import.meta.url), 'utf8');
const candidate = nativeFrameEncodingSource(original);

function encoder(source: string, native: boolean) {
  const context = vm.createContext({ Buffer });
  // The browser-compatible intrinsic and its counter are isolated from Node's
  // global prototypes. Check the actual dependency rather than a copied codec.
  vm.runInContext(`globalThis.nativeUses=0;
    Uint8Array.prototype.toBase64=${native ? 'function(){nativeUses++;return Buffer.from(this.buffer,this.byteOffset,this.byteLength).toString("base64");}' : 'undefined'};
    globalThis.codec=(()=>{${source.replace(/import \* as Log from '[^']+';/, 'const Log={Error(){}};').replace('export default', 'return')}})();`, context);
  return { context, encode(expression: string): string { return vm.runInContext(`codec.encode(${expression})`, context); } };
}

test('native frame conversion preserves JPEG bytes, Base64 padding and subarray boundaries', () => {
  const fast = encoder(candidate, true), legacy = encoder(original, false);
  for (const length of [0, 1, 2, 3, 4, 255, 256, 65536, 1048577]) {
    const expression = `Uint8Array.from({length:${length}},(_,i)=>(i*37+251)%256)`;
    const expected = Buffer.from(Array.from({length},(_,i)=>(i*37+251)%256)).toString('base64');
    assert.equal(fast.encode(expression), expected);
    assert.equal(legacy.encode(expression), expected);
  }
  assert.equal(fast.encode('new Uint8Array([99,0,255,65,77]).subarray(1,4)'), 'AP9B');
  assert.equal(vm.runInContext('nativeUses', fast.context), 10);
});

test('ordinary arrays and browsers without the intrinsic retain the existing codec', () => {
  for (const native of [false, true]) {
    const codec = encoder(candidate, native);
    assert.equal(codec.encode('[0,255,65]'), 'AP9B');
    assert.equal(codec.encode('new Uint8Array([0,255,65])'), 'AP9B');
    assert.equal(vm.runInContext('nativeUses', codec.context), native ? 1 : 0);
  }
  assert.throws(() => nativeFrameEncodingSource('upstream changed'), /encoder changed/);
});

const rfbOriginal = await readFile(new URL('../node_modules/@novnc/novnc/core/rfb.js', import.meta.url), 'utf8');
function retainedViewer() {
  // Execute the actual pinned class and wire encoders. Only DOM construction
  // and decoding/drawing endpoints are adapted; no copied RFB implementation.
  const context = vm.createContext({EventTargetMixin: class {}, Log: {Debug(){}, Info(){}, Warn(){}, Error(){}}});
  const source = retainedFrameUpdatesSource(rfbOriginal).replace(/^import .*;\r?\n/gm, '').replace('export default class RFB', 'class RFB');
  vm.runInContext(source + '\nglobalThis.RFB=RFB;', context);
  const client = vm.runInContext('Object.create(RFB.prototype)', context);
  const packets: number[][] = [], output: number[] = [], drawing: unknown[] = [];
  client._sock = {sQpush8: (n:number) => output.push(Number(n) & 255), sQpush16: (n:number) => output.push(n >> 8 & 255,n & 255),
    flush: () => {packets.push(output.splice(0));}, rQshift8: () => 0};
  client._rfbConnectionState = 'connected'; client._updatesPaused = false;
  client._supportsContinuousUpdates = false; client._enabledContinuousUpdates = false;
  client._fbWidth = 1920; client._fbHeight = 1080; client._FBU = {rects: 0};
  client._display = {_damage: (...rect:number[]) => drawing.push(rect), flip: () => drawing.push('flip')};
  return {client, packets, drawing};
}
const completeFrame = [3,0,0,0,0,0,7,128,4,56];

test('Retained viewer pauses requests without dropping an in-flight framebuffer update, then requests a full frame on the same session', () => {
  const {client,packets} = retainedViewer(), socket = client._sock, decoder = {};
  let decoded = 0; client._decoders = decoder; client._framebufferUpdate = () => {decoded++; return true;};
  client.updatesPaused = true;
  assert.equal(client._normalMsg(), true); assert.equal(decoded,1); assert.deepEqual(packets,[]);
  client.updatesPaused = false;
  assert.deepEqual(packets,[completeFrame]);
  client._normalMsg();
  assert.deepEqual(packets[1],[3,1,0,0,0,0,7,128,4,56]);
  assert.equal(decoded,2); assert.equal(client._sock,socket); assert.equal(client._decoders,decoder);
});

test('Continuous framebuffer updates are disabled while hidden and resumed with a full refresh', () => {
  const {client,packets} = retainedViewer();
  client._supportsContinuousUpdates = true; client._enabledContinuousUpdates = true;
  client.updatesPaused = true; client.updatesPaused = true;
  assert.deepEqual(packets,[[150,0,0,0,0,0,7,128,4,56]]);
  client._updateContinuousUpdates(); assert.equal(packets.length,1);
  client.updatesPaused = false;
  assert.deepEqual(packets.slice(1),[[150,1,0,0,0,0,7,128,4,56],completeFrame]);
});

test('Manual redraw repaints the retained buffer and requests full pixels without reopening a connection', () => {
  const {client,packets,drawing} = retainedViewer(), socket = client._sock;
  client.refreshFrame();
  assert.deepEqual(drawing,[[0,0,1920,1080],'flip']); assert.deepEqual(packets,[completeFrame]);
  assert.equal(client._sock,socket);
  client.updatesPaused=true; client.refreshFrame(); assert.equal(packets.length,1);
  client._rfbConnectionState='disconnected'; client.updatesPaused=false; client.refreshFrame(); assert.equal(packets.length,1);
});

test('Retained viewer extension refuses changed or ambiguous upstream update boundaries', () => {
  assert.throws(() => retainedFrameUpdatesSource('changed dependency'), /Pinned noVNC/);
  assert.throws(() => retainedFrameUpdatesSource(rfbOriginal + '\n        this._viewOnly = false;'), /Pinned noVNC/);
});
