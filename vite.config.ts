import { defineConfig } from 'vite';
import { retainedFrameUpdatesPlugin } from './scripts/retained-frame-updates.ts';
import react from '@vitejs/plugin-react';
import { nativeFrameEncodingPlugin } from './scripts/native-frame-encoding.ts';

export default defineConfig({ plugins: [react(), nativeFrameEncodingPlugin(), retainedFrameUpdatesPlugin()], optimizeDeps: {exclude:['@novnc/novnc']}, build: { outDir: 'dist' } });
