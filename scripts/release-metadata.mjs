#!/usr/bin/env node
// Release metadata validation and publication planning for the CD publisher
// (.github/workflows/publish-release.yml).
//
// This file is intentionally dependency-free (node built-ins only). It exports
// pure functions for unit tests and runs as a CLI in two modes:
//
//   node scripts/release-metadata.mjs          # validate + emit version/tag/
//                                              # prerelease/head_sha outputs
//   node scripts/release-metadata.mjs --plan   # emit the publish plan
//
// CLI output is written to $GITHUB_OUTPUT (NAME=VALUE lines) when that env var
// is set, otherwise to stdout. Failures write a reason to stderr and exit 1.
import { readFileSync, appendFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Chrome requires numeric manifest.version to be 1-4 dot-separated segments.
const CHROME_VERSION_RE = /^\d+(\.\d+){0,3}$/
const MAX_CHROME_SEGMENT = 65535

// Prerelease versions (beta/rc/alpha/...) carry a `-` suffix. Stable versions
// do not.
export function classifyPrerelease(version) {
  return version.includes('-')
}

// Plan the exact publication action. Returns one of:
//   'publish' — the target tag does not exist yet; create tag + Release.
//   'noop'    — the tag points at headSha and the Release exists; safe rerun.
//   'resume'  — the tag matches headSha but the Release is missing; create only
//               the Release (never recreate the tag).
//   'fail'    — the tag exists and points at a different commit; the caller
//               must stop with exit 1 and zero mutation (no move/delete).
export function planPublish({ version, headSha, tagSha, releaseExists }) {
  if (!version || typeof version !== 'string') {
    throw new TypeError('planPublish: version must be a non-empty string')
  }
  if (!headSha || typeof headSha !== 'string') {
    throw new TypeError('planPublish: headSha must be a non-empty string')
  }
  if (tagSha === null || tagSha === undefined || tagSha === '') {
    return 'publish'
  }
  if (tagSha !== headSha) {
    return 'fail'
  }
  return releaseExists === 'true' || releaseExists === true ? 'noop' : 'resume'
}

// Validate release metadata for a repo checkout rooted at `dir`. Throws on the
// first violation (fast-fail) so the workflow never reaches tag/Release
// creation with broken metadata. Returns the normalized release identity.
export function validateMetadata(dir) {
  const packageJsonPath = join(dir, 'package.json')
  const manifestPath = join(dir, 'manifest.json')
  const notesPath = (version) => join(dir, 'docs', 'releases', `v${version}.md`)

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  const version = packageJson.version
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`package.json version is missing or empty (${packageJsonPath})`)
  }

  // 1. package.json.version must equal manifest.json.version_name.
  if (manifest.version_name !== version) {
    throw new Error(
      `version mismatch: package.json version "${version}" !== manifest.json version_name "${manifest.version_name}"`,
    )
  }

  // 2. The matching release notes file must exist.
  if (!existsSync(notesPath(version))) {
    throw new Error(`missing release notes: ${notesPath(version)} does not exist`)
  }

  // 3. Chrome numeric manifest.version must stay valid.
  const manifestVersion = manifest.version
  if (typeof manifestVersion !== 'string' || !CHROME_VERSION_RE.test(manifestVersion)) {
    throw new Error(
      `invalid Chrome manifest.version "${manifestVersion}": expected 1-4 dot-separated numeric segments`,
    )
  }
  const oversized = manifestVersion
    .split('.')
    .find((segment) => Number(segment) > MAX_CHROME_SEGMENT)
  if (oversized !== undefined) {
    throw new Error(
      `invalid Chrome manifest.version "${manifestVersion}": segment "${oversized}" exceeds ${MAX_CHROME_SEGMENT}`,
    )
  }

  return {
    version,
    tag: `v${version}`,
    prerelease: classifyPrerelease(version),
  }
}

function emit(entries) {
  const lines = entries.map(([name, value]) => `${name}=${value}`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  } else {
    process.stdout.write(`${lines.join('\n')}\n`)
  }
}

function fatal(message) {
  console.error(`[release-metadata] ${message}`)
  process.exit(1)
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)

if (isMain) {
  const dir = process.cwd()
  let identity
  try {
    identity = validateMetadata(dir)
  } catch (error) {
    fatal(error && error.message ? error.message : String(error))
  }

  const headSha = process.env.INPUT_HEAD_SHA || ''

  if (process.argv.includes('--plan')) {
    const plan = planPublish({
      version: identity.version,
      headSha,
      tagSha: process.env.INPUT_TAG_SHA || '',
      releaseExists: process.env.INPUT_RELEASE_EXISTS || '',
    })
    emit([['plan', plan]])
    if (plan === 'fail') {
      fatal(
        `target tag ${identity.tag} exists and points at a different commit; refusing to move/delete it (zero mutation)`,
      )
    }
  } else {
    emit([
      ['version', identity.version],
      ['tag', identity.tag],
      ['prerelease', String(identity.prerelease)],
      ['head_sha', headSha],
    ])
  }
}
