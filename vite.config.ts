import { crx } from '@crxjs/vite-plugin'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { type Plugin, defineConfig } from 'vite'
import manifest from './manifest.json'

// CRXJS + Vite adds `crossorigin` to module scripts, which breaks
// chrome-extension:// pages. This plugin strips crossorigin attributes.
const stripCrossorigin = (): Plugin => ({
  name: 'strip-crossorigin',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      return html.replaceAll('crossorigin ', '').replaceAll('crossorigin', '')
    },
  },
})

export default defineConfig(({ mode }) => ({
  base: '',
  plugins: [react(), stripCrossorigin(), crx({ manifest })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    target: 'esnext',
    minify: false,
    sourcemap: mode !== 'production',
  },
}))
