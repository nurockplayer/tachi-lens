import { crx } from '@crxjs/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import manifest from './manifest.json'

export default defineConfig(({ mode }) => ({
  plugins: [react(), crx({ manifest })],
  build: {
    target: 'esnext',
    minify: false,
    sourcemap: mode !== 'production',
  },
}))
