#!/usr/bin/env node
// Post-build: bundle popup JS + all its chunk dependencies into a single
// inline script. This avoids chrome-extension:// module script MIME type
// issues where .js files get application/octet-stream.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { resolve, basename } from 'path'

const DIST = resolve('dist')
const POPUP_HTML = resolve(DIST, 'src/popup/index.html')

if (!existsSync(POPUP_HTML)) {
  console.error('Popup HTML not found at', POPUP_HTML)
  process.exit(1)
}

const ASSETS = resolve(DIST, 'assets')
const availableFiles = readdirSync(ASSETS)

let html = readFileSync(POPUP_HTML, 'utf-8')

// Collect all needed JS files (main script + preload chunks)
const neededFiles = new Set()
const scriptSrcMatch = html.match(/<script type="module"[^>]*src="([^"]+)"[^>]*>/)
const preloadMatches = html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"[^>]*>/g)

if (scriptSrcMatch) neededFiles.add(basename(scriptSrcMatch[1]))
for (const m of preloadMatches) neededFiles.add(basename(m[1]))

// Read all chunk files and concatenate, stripping import/export statements
let combinedJs = ''
const loaded = new Set()

const loadChunk = (fileName, alreadyLoaded = new Set()) => {
  if (alreadyLoaded.has(fileName)) return
  const filePath = resolve(ASSETS, fileName)

  if (!existsSync(filePath)) {
    console.warn('  skip missing:', fileName)
    return
  }

  let code = readFileSync(filePath, 'utf-8')

  // Find imports from other chunks we need to load first
  const importRegex = /^import\s+(?:\{[^}]*\}\s+from\s+)?['"]\.\/([^'"]+)['"];?\s*$/gm
  const deps = []
  for (const m of code.matchAll(importRegex)) {
    deps.push(m[1])
  }

  // Load dependencies first (DFS)
  for (const dep of deps) {
    if (!alreadyLoaded.has(dep)) {
      loadChunk(dep, alreadyLoaded)
    }
  }

  if (loaded.has(fileName)) return
  loaded.add(fileName)

  // Strip import/export statements
  code = code.replace(/^import\s+.*?;\s*$/gm, '')
  code = code.replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
  code = code.replace(/^export\s+default\s+/gm, '')

  combinedJs += `\n// --- ${fileName} ---\n${code}\n`
  alreadyLoaded.add(fileName)
}

// Load all needed files
for (const f of neededFiles) {
  loadChunk(f, new Set())
}

// Remove module scripts and preloads from HTML
html = html.replace(/<script type="module"[^>]*src="[^"]*"[^>]*><\/script>/g, '')
html = html.replace(/<link rel="modulepreload"[^>]*>/g, '')

// Insert inline script
if (combinedJs.trim()) {
  html = html.replace('</body>',
    `<script>(function(){\n${combinedJs}\n})();</script>\n</body>`)
}

writeFileSync(POPUP_HTML, html)
console.log('  popup inlined:', Buffer.byteLength(html, 'utf-8').toLocaleString(), 'bytes')
console.log('  chunks merged:', loaded.size)
