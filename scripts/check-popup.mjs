#!/usr/bin/env node
// Post-build check: popup HTML must not contain inline <script> tags (no `src` attribute).
// Inline scripts violate Chrome Extension MV3 default CSP on some pages,
// and the popup should rely on module scripts emitted by Vite + CRXJS.

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const POPUP_HTML = resolve('dist/src/popup/index.html')

if (!existsSync(POPUP_HTML)) {
  process.exit(0)
}

const html = readFileSync(POPUP_HTML, 'utf-8')

// Match <script> without a src attribute
if (/<script(?!\s[^>]*src=)[^>]*>/i.test(html)) {
  console.error('[check-popup] FAIL: popup HTML contains inline script — CSP violation risk.')
  process.exit(1)
}

console.log('[check-popup] OK: no inline scripts in popup HTML.')
