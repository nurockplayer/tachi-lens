// Unit tests for release-metadata.mjs (validateMetadata, classifyPrerelease,
// planPublish). Run with: node --test scripts/release-metadata.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyPrerelease,
  planPublish,
  validateMetadata,
} from './release-metadata.mjs'

function makeRepo({ version, versionName, manifestVersion, notes = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'release-metadata-'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'tachi-lens', version }),
  )
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      // Chrome numeric version is independent of the display version_name; a
      // stable numeric default keeps fixtures focused on the rule under test.
      version: manifestVersion ?? '1.2.3.4',
      version_name: versionName,
    }),
  )
  if (notes) {
    mkdirSync(join(dir, 'docs', 'releases'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'releases', `v${versionName}.md`), '# notes')
  }
  return dir
}

test('validateMetadata accepts matching package/manifest version with notes', () => {
  const dir = makeRepo({ version: '0.2.0-beta.2', versionName: '0.2.0-beta.2' })
  try {
    const identity = validateMetadata(dir)
    assert.equal(identity.version, '0.2.0-beta.2')
    assert.equal(identity.tag, 'v0.2.0-beta.2')
    assert.equal(identity.prerelease, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validateMetadata throws on version_name mismatch', () => {
  const dir = makeRepo({ version: '0.2.0', versionName: '0.2.0-beta.2' })
  try {
    assert.throws(() => validateMetadata(dir), /version mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validateMetadata throws when release notes are missing', () => {
  const dir = makeRepo({
    version: '0.2.0-beta.2',
    versionName: '0.2.0-beta.2',
    notes: false,
  })
  try {
    assert.throws(() => validateMetadata(dir), /missing release notes/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validateMetadata throws on a 5-segment Chrome manifest.version', () => {
  const dir = makeRepo({
    version: '0.2.0-beta.2',
    versionName: '0.2.0-beta.2',
    manifestVersion: '1.2.3.4.5',
  })
  try {
    assert.throws(() => validateMetadata(dir), /invalid Chrome manifest.version/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validateMetadata throws on a non-numeric Chrome manifest.version', () => {
  const dir = makeRepo({
    version: '0.2.0-beta.2',
    versionName: '0.2.0-beta.2',
    manifestVersion: '0.2.0-beta.2',
  })
  try {
    assert.throws(() => validateMetadata(dir), /invalid Chrome manifest.version/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validateMetadata throws when a Chrome manifest.version segment exceeds 65535', () => {
  const dir = makeRepo({
    version: '0.2.0-beta.2',
    versionName: '0.2.0-beta.2',
    manifestVersion: '0.1.0.70000',
  })
  try {
    assert.throws(() => validateMetadata(dir), /exceeds 65535/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('classifyPrerelease marks beta and rc versions as prerelease', () => {
  assert.equal(classifyPrerelease('0.2.0-beta.2'), true)
  assert.equal(classifyPrerelease('1.0.0-rc.1'), true)
  assert.equal(classifyPrerelease('2.0.0-alpha.0'), true)
})

test('classifyPrerelease leaves stable versions as full releases', () => {
  assert.equal(classifyPrerelease('0.2.0'), false)
  assert.equal(classifyPrerelease('1.0.0'), false)
  assert.equal(classifyPrerelease('2.3.4'), false)
})

test('planPublish returns publish when the tag does not exist yet', () => {
  assert.equal(
    planPublish({ version: '0.2.0', headSha: 'a', tagSha: '', releaseExists: '' }),
    'publish',
  )
  assert.equal(
    planPublish({ version: '0.2.0', headSha: 'a', tagSha: null, releaseExists: false }),
    'publish',
  )
})

test('planPublish returns noop when the tag matches head and the Release exists', () => {
  assert.equal(
    planPublish({ version: '0.2.0', headSha: 'a', tagSha: 'a', releaseExists: 'true' }),
    'noop',
  )
  assert.equal(
    planPublish({ version: '0.2.0', headSha: 'a', tagSha: 'a', releaseExists: true }),
    'noop',
  )
})

test('planPublish returns resume when the tag matches head but the Release is missing', () => {
  assert.equal(
    planPublish({ version: '0.2.0', headSha: 'a', tagSha: 'a', releaseExists: '' }),
    'resume',
  )
  assert.equal(
    planPublish({ version: '0.2.0', headSha: 'a', tagSha: 'a', releaseExists: 'false' }),
    'resume',
  )
})

test('planPublish returns fail when the tag points at a different commit', () => {
  assert.equal(
    planPublish({ version: '0.2.0', headSha: 'a', tagSha: 'other', releaseExists: 'true' }),
    'fail',
  )
  assert.equal(
    planPublish({ version: '0.2.0', headSha: 'a', tagSha: 'other', releaseExists: '' }),
    'fail',
  )
})

test('planPublish rejects a missing version or headSha', () => {
  assert.throws(() => planPublish({ version: '', headSha: 'a' }), /version/)
  assert.throws(() => planPublish({ version: '0.2.0', headSha: '' }), /headSha/)
})
