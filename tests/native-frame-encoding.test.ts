import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { nativeFrameEncodingSource } from '../scripts/native-frame-encoding.ts';

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
