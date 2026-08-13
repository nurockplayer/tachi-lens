// Unit tests for the deterministic risk classifier.
// Run with: node --test scripts/classify-risk.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyChangedFiles, isStaticPath, normalizePath } from './classify-risk.mjs'

test('normalizePath trims, strips leading ./ and trailing CR, unifies slashes', () => {
  assert.equal(normalizePath('  ./src/foo.ts  '), 'src/foo.ts')
  assert.equal(normalizePath('./README.md'), 'README.md')
  assert.equal(normalizePath('docs\\agents\\x.md'), 'docs/agents/x.md')
  assert.equal(normalizePath('src/foo.ts\r'), 'src/foo.ts')
  assert.equal(normalizePath(''), '')
  assert.equal(normalizePath(null), '')
})

test('isStaticPath accepts markdown anywhere and files under docs/', () => {
  assert.equal(isStaticPath('README.md'), true)
  assert.equal(isStaticPath('src/content/twitch-selectors-notes.md'), true)
  assert.equal(isStaticPath('docs/agents/governance.md'), true)
  assert.equal(isStaticPath('docs/sub/deep/plan.md'), true)
  assert.equal(isStaticPath('AGENTS.MD'), true)
  assert.equal(isStaticPath('docs/notes.txt'), true)
})

test('isStaticPath rejects runtime-affecting files', () => {
  assert.equal(isStaticPath('src/background/service-worker.ts'), false)
  assert.equal(isStaticPath('manifest.json'), false)
  assert.equal(isStaticPath('package.json'), false)
  assert.equal(isStaticPath('pnpm-lock.yaml'), false)
  assert.equal(isStaticPath('public/_locales/en/messages.json'), false)
  assert.equal(isStaticPath('scripts/check-popup.mjs'), false)
  assert.equal(isStaticPath('.github/workflows/ci.yml'), false)
  assert.equal(isStaticPath('e2e/translation-happy-path.spec.ts'), false)
  assert.equal(isStaticPath('vite.config.ts'), false)
})

test('classifies a docs-only change as docs/skip', () => {
  assert.deepEqual(classifyChangedFiles(['README.md']), {
    tier: 'docs',
    e2e: 'skip',
    reasons: [],
  })
  assert.deepEqual(
    classifyChangedFiles(['docs/agents/governance.md', 'docs/releases/v0.2.0.md']),
    { tier: 'docs', e2e: 'skip', reasons: [] },
  )
  assert.deepEqual(classifyChangedFiles(['src/content/twitch-selectors-notes.md']), {
    tier: 'docs',
    e2e: 'skip',
    reasons: [],
  })
})

test('classifies any runtime-affecting file as runtime/run', () => {
  for (const file of [
    'src/background/service-worker.ts',
    'manifest.json',
    'package.json',
    'public/_locales/en/messages.json',
    'scripts/check-popup.mjs',
    '.github/workflows/ci.yml',
  ]) {
    assert.deepEqual(classifyChangedFiles([file]), {
      tier: 'runtime',
      e2e: 'run',
      reasons: [file],
    })
  }
})

test('classifies a mixed docs+source change as runtime/run and lists only runtime files', () => {
  assert.deepEqual(classifyChangedFiles(['README.md', 'src/foo.ts']), {
    tier: 'runtime',
    e2e: 'run',
    reasons: ['src/foo.ts'],
  })
})

test('fails safe to runtime/run on an empty change set', () => {
  const result = classifyChangedFiles([])
  assert.equal(result.tier, 'runtime')
  assert.equal(result.e2e, 'run')
})

test('normalizes ./ prefixes before classifying', () => {
  assert.deepEqual(classifyChangedFiles(['./README.md']), {
    tier: 'docs',
    e2e: 'skip',
    reasons: [],
  })
  assert.deepEqual(classifyChangedFiles(['./src/foo.ts']), {
    tier: 'runtime',
    e2e: 'run',
    reasons: ['src/foo.ts'],
  })
})

test('rejects a non-array input', () => {
  assert.throws(() => classifyChangedFiles(undefined), /must be an array/)
  assert.throws(() => classifyChangedFiles(null), /must be an array/)
  assert.throws(() => classifyChangedFiles('src/foo.ts'), /must be an array/)
})
