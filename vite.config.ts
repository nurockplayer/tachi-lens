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
    emptyOutDir: true,
  },
}))
