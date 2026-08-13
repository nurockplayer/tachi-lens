// Unit tests for the deterministic risk classifier.
// Run with: node --test scripts/classify-risk.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classifyChangedFiles, collectChangedFiles, isStaticPath, normalizePath } from './classify-risk.mjs'

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

// --- rename-safety regression (Codex P2) ---
// A runtime file renamed into docs/ or to a Markdown path must never classify
// as docs-only. These exercise the real `git diff --no-renames` invocation so
// the source path is guaranteed to surface alongside the destination.

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'classify-risk-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  return dir
}

function write(dir, rel, content = '') {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

function commit(dir, message) {
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', message], { cwd: dir })
}

test('runtime file renamed into docs/*.md classifies runtime (both paths seen)', () => {
  const dir = makeRepo()
  try {
    write(dir, 'src/foo.ts', 'export const x = 1\n')
    write(dir, 'docs/a.md', '# old\n')
    commit(dir, 'c1')
    execFileSync('git', ['mv', 'src/foo.ts', 'docs/foo.md'], { cwd: dir })
    commit(dir, 'rename src -> docs')

    const files = collectChangedFiles('HEAD~1', { cwd: dir })
    assert.ok(files.includes('src/foo.ts'), `expected source path, got: ${files.join(', ')}`)
    assert.ok(files.includes('docs/foo.md'), `expected destination path, got: ${files.join(', ')}`)
    const result = classifyChangedFiles(files)
    assert.equal(result.tier, 'runtime')
    assert.equal(result.e2e, 'run')
    assert.ok(result.reasons.includes('src/foo.ts'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runtime file renamed to a Markdown path classifies runtime', () => {
  const dir = makeRepo()
  try {
    write(dir, 'src/foo.ts', 'export const x = 1\n')
    commit(dir, 'c1')
    execFileSync('git', ['mv', 'src/foo.ts', 'README.md'], { cwd: dir })
    commit(dir, 'rename src -> README.md')

    const files = collectChangedFiles('HEAD~1', { cwd: dir })
    assert.ok(files.includes('src/foo.ts'), `expected source path, got: ${files.join(', ')}`)
    assert.ok(files.includes('README.md'), `expected destination path, got: ${files.join(', ')}`)
    const result = classifyChangedFiles(files)
    assert.equal(result.tier, 'runtime')
    assert.equal(result.e2e, 'run')
    assert.ok(result.reasons.includes('src/foo.ts'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('docs Markdown renamed within docs/static space classifies docs', () => {
  const dir = makeRepo()
  try {
    write(dir, 'docs/a.md', '# old\n')
    commit(dir, 'c1')
    execFileSync('git', ['mv', 'docs/a.md', 'docs/b.md'], { cwd: dir })
    commit(dir, 'rename docs')

    const files = collectChangedFiles('HEAD~1', { cwd: dir })
    assert.ok(files.includes('docs/a.md'), `expected source path, got: ${files.join(', ')}`)
    assert.ok(files.includes('docs/b.md'), `expected destination path, got: ${files.join(', ')}`)
    assert.deepEqual(classifyChangedFiles(files), { tier: 'docs', e2e: 'skip', reasons: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
