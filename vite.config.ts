import { crx } from '@crxjs/vite-plugin'
import react from '@vitejs/plugin-react'
import { resolve as pathResolve } from 'path'
import { defineConfig } from 'vite'
import manifest from './manifest.json'

export default defineConfig(({ mode }) => ({
  base: '',
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      '@': pathResolve(__dirname, 'src'),
    },
  },
  build: {
    target: 'esnext',
    minify: false,
    sourcemap: mode !== 'production',
    rollupOptions: {
      // The offscreen capture document is not reachable from the manifest, so
      // CRXJS has no manifest entry to emit it from. Declaring it here bundles
      // src/offscreen/index.html (and its capture.ts module) into the build;
      // the Service Worker references the emitted URL via OFFSCREEN_DOCUMENT_URL.
      input: {
        offscreen: pathResolve(__dirname, 'src/offscreen/index.html'),
      },
    },
  },
}))
