import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nativeFrameEncodingPlugin } from './scripts/native-frame-encoding.ts';

export default defineConfig({ plugins: [react(), nativeFrameEncodingPlugin()], build: { outDir: 'dist' } });
