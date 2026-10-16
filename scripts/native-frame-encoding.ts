import type { Plugin } from 'vite';

// Keep noVNC's existing encoder as the compatibility path. The native operation
// produces the same Base64 bytes without building a large rope of JS strings.
export function nativeFrameEncodingSource(source: string): string {
  const marker = 'encode(data) {';
  if (source.split(marker).length !== 2) throw new Error('Pinned noVNC Base64 encoder changed; review the frame optimization');
  return source.replace(marker, `${marker}
        if (data instanceof Uint8Array && typeof Uint8Array.prototype.toBase64 === 'function') {
            return Uint8Array.prototype.toBase64.call(data);
        }
`);
}

export function nativeFrameEncodingPlugin(): Plugin {
  return {
    name: 'mu-native-frame-encoding',
    enforce: 'pre',
    transform(source, id) {
      const file = id.split('?')[0].replaceAll('\\', '/');
      if (!file.endsWith('/node_modules/@novnc/novnc/core/base64.js')) return;
      return { code: nativeFrameEncodingSource(source), map: null };
    },
  };
}
