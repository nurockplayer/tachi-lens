import { crx } from '@crxjs/vite-plugin'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { resolve as pathResolve, basename } from 'path'
import { type Plugin, defineConfig } from 'vite'
import manifest from './manifest.json'

// chrome-extension:// serves module scripts as application/octet-stream,
// failing strict MIME checking. This plugin inlines all popup JS chunks
// into a single regular <script> tag, avoiding module scripts entirely.
const inlinePopupPlugin = (): Plugin => ({
  name: 'inline-popup',
  apply: 'build',
  writeBundle() {
    const htmlPath = pathResolve('dist/src/popup/index.html')
    const assetsDir = pathResolve('dist/assets')
    if (!existsSync(htmlPath)) return

    const available = existsSync(assetsDir) ? readdirSync(assetsDir) : []
    let html = readFileSync(htmlPath, 'utf-8')

    // Collect referenced files (main module script + modulepreload chunks)
    const needed: string[] = []
    const scriptMatch = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*>/)
    if (scriptMatch?.[1]) needed.push(basename(scriptMatch[1]))
    for (const m of html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"[^>]*>/g)) {
      if (m[1]) needed.push(basename(m[1]))
    }

    // Load all chunks, stripping import/export
    const loaded = new Set<string>()
    const parts: string[] = []

    const loadChunk = (file: string, stack = new Set<string>()): void => {
      if (stack.has(file) || loaded.has(file)) return
      if (!available.includes(file)) return

      const filePath = pathResolve(assetsDir, file)
      if (!existsSync(filePath)) return

      let code = readFileSync(filePath, 'utf-8')
      for (const m of code.matchAll(/^import\s+.*?from\s+['"]\.\/([^'"]+)['"];?\s*$/gm)) {
        if (m[1] && !stack.has(m[1]) && !loaded.has(m[1])) {
          loadChunk(m[1], new Set([...stack, file]))
        }
      }
      if (loaded.has(file)) return
      loaded.add(file)
      parts.push(
        '\n// ' + file + '\n' +
        code
          .replace(/^(import|export)\s+.*;\s*$/gm, '')
          .replace(/^export\s+default\s+/gm, ''),
      )
    }

    for (const f of needed) loadChunk(f)

    // Remove module-related tags, insert inline script
    html = html
      .replace(/<script type="module"[^>]*src="[^"]*"[^>]*><\/script>/g, '')
      .replace(/<link rel="modulepreload"[^>]*>/g, '')
      .replace('</body>', '<script>\n' + parts.join('') + '\n</script>\n</body>')

    writeFileSync(htmlPath, html)
    console.log(
      '[inline-popup] %d chunks -> inline (%s KB)',
      loaded.size,
      ((html.length / 1024) | 0).toString(),
    )
  },
})

export default defineConfig(({ mode }) => ({
  base: '',
  plugins: [react(), crx({ manifest }), inlinePopupPlugin()],
  resolve: {
    alias: {
      '@': pathResolve(__dirname, 'src'),
    },
  },
  build: {
    target: 'esnext',
    minify: false,
    sourcemap: mode !== 'production',
    modulePreload: false,
  },
}))
