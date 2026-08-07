#!/usr/bin/env node
// Post-check: CLAUDE.md and AGENTS.md must stay byte-for-byte identical.
// Both files encode the same agent-facing project rules; tool-neutral
// worker/controller terminology lives in both, so a divergence signals
// one entrypoint has drifted out of sync.

import { readFileSync } from 'fs'
import { resolve } from 'path'

const files = ['CLAUDE.md', 'AGENTS.md'].map((name) =>
  readFileSync(resolve(name), 'utf-8'),
)

if (files[0] !== files[1]) {
  console.error('[check-agent-docs] FAIL: CLAUDE.md and AGENTS.md differ.')
  console.error('[check-agent-docs] Run `cmp CLAUDE.md AGENTS.md` to locate the divergence, then re-sync both files.')
  process.exit(1)
}

console.log('[check-agent-docs] OK: CLAUDE.md and AGENTS.md are identical.')
