#!/usr/bin/env node
// Post-build: bundle all popup JS chunks into a single inline <script> tag.
// chrome-extension:// pages serve module scripts with wrong MIME types,
// so we convert module scripts to a regular <script> by inlining.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { resolve, basename } from 'path'

const DIST = resolve('dist')
const POPUP_HTML = resolve(DIST, 'src/popup/index.html')

if (!existsSync(POPUP_HTML)) {
  process.exit(0)
}

const ASSETS = resolve(DIST, 'assets')
const existing = existsSync(ASSETS) ? readdirSync(ASSETS) : []

let html = readFileSync(POPUP_HTML, 'utf-8')

// Skip if already inlined (no module script tags)
if (!html.includes('type="module"')) {
  process.exit(0)
}

// Collect all referenced chunk files
const needed = []
const scriptMatch = html.match(/<script[^>]*src="([^"]+)"[^>]*>/)
if (scriptMatch?.[1]) needed.push(basename(scriptMatch[1]))
for (const m of html.matchAll(/href="(?!\/\/)([^"]+\.js)"[^>]*>/g)) {
  const file = basename(m[1])
  if (!needed.includes(file)) needed.push(file)
}

// Load chunks, strip imports/exports, resolve dependency order
const loaded = new Set()
const parts = []

const loadChunk = (file, stack = new Set()) => {
  if (stack.has(file) || loaded.has(file)) return
  if (!existing.includes(file)) return
  const filePath = resolve(ASSETS, file)
  if (!existsSync(filePath)) return

  let code = readFileSync(filePath, 'utf-8')
  for (const dep of code.matchAll(/^import\s+.*?from\s+['"]\.\/([^'"]+)['"];?\s*$/gm)) {
    if (dep[1] && !stack.has(dep[1]) && !loaded.has(dep[1])) {
      loadChunk(dep[1], new Set([...stack, file]))
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

for (const f of needed) loadChunk(f, new Set())

const inlineCode = parts.join('')

// Replace module HTML with inline script
html = html
  .replace(/<script[^>]*type="module"[^>]*>.*?<\/script>/gs, '')
  .replace(/<link[^>]+modulepreload[^>]*>/g, '')
  .replace(/crossorigin/g, '')
  .replace('</body>', '<script>\n' + inlineCode + '\n</script>\n</body>')

writeFileSync(POPUP_HTML, html)
console.log('[inline-popup] ' + loaded.size + ' chunks inlined')
