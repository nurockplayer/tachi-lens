#!/usr/bin/env node
// Deterministic risk classification for tachi-lens validation tiers.
// No LLM, no network, no test-selection framework: a change is classified
// purely by the files it touches relative to a base ref.
//
//   node scripts/classify-risk.mjs             # classify vs origin/main
//   node scripts/classify-risk.mjs --base X    # classify vs an arbitrary ref
//
// The pure `classifyChangedFiles` export is unit-tested via
// `node --test scripts/classify-risk.test.mjs`. CLI output is written as
// NAME=VALUE lines to $GITHUB_OUTPUT when that env var is set, otherwise to
// stdout. A human-readable summary is always printed to stdout for the log.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_BASE = 'origin/main'

// A changed path that provably cannot affect extension runtime behavior.
// Only two shapes qualify: markdown files anywhere, and anything under docs/.
// Everything else (source, manifest, dependencies, e2e specs, scripts, build
// config, locales, workflows) is runtime-affecting and therefore full E2E.
export function isStaticPath(path) {
  return (
    typeof path === 'string' &&
    normalizePath(path).length > 0 &&
    (normalizePath(path).toLowerCase().endsWith('.md') ||
      normalizePath(path).startsWith('docs/'))
  )
}

// Normalize a git-reported path for stable comparison: trim surrounding
// whitespace, drop a leading './', unify backslashes, and strip a trailing CR.
export function normalizePath(path) {
  if (typeof path !== 'string') return ''
  return path
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/')
    .replace(/\r$/, '')
}

// Classify a set of changed files into a validation tier.
//
//   { tier: 'docs' | 'runtime', e2e: 'skip' | 'run', reasons: string[] }
//
// Fail-safe: an empty, non-array, or entirely-unknown change set escalates to
// 'runtime' (run full E2E). Only an explicit match where every changed file is
// static yields 'docs' (skip E2E).
export function classifyChangedFiles(files) {
  if (!Array.isArray(files)) {
    throw new TypeError('classifyChangedFiles: files must be an array of path strings')
  }
  const normalized = files
    .map((file) => normalizePath(file))
    .filter((file) => file.length > 0)

  if (normalized.length === 0) {
    return {
      tier: 'runtime',
      e2e: 'run',
      reasons: ['no changed files detected; failing safe to full validation'],
    }
  }

  const runtime = normalized.filter((file) => !isStaticPath(file))
  if (runtime.length > 0) {
    return { tier: 'runtime', e2e: 'run', reasons: runtime }
  }
  return { tier: 'docs', e2e: 'skip', reasons: [] }
}

function emit(entries) {
  const lines = entries.map(([name, value]) => `${name}=${value}`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  } else {
    process.stdout.write(`${lines.join('\n')}\n`)
  }
}

function getChangedFiles(base) {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8',
  })
  return out
    .split('\n')
    .map((line) => normalizePath(line))
    .filter((line) => line.length > 0)
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)

if (isMain) {
  const baseArgIndex = process.argv.indexOf('--base')
  const base = baseArgIndex !== -1 ? process.argv[baseArgIndex + 1] : DEFAULT_BASE

  let result
  try {
    result = classifyChangedFiles(getChangedFiles(base))
  } catch (error) {
    // A classifier failure must never skip validation: escalate to full E2E.
    result = {
      tier: 'runtime',
      e2e: 'run',
      reasons: [`classifier error (failing safe to full E2E): ${error.message}`],
    }
  }

  const summary =
    result.e2e === 'run'
      ? `[classify-risk] tier=runtime e2e=run (${result.reasons.join(', ')})`
      : '[classify-risk] tier=docs e2e=skip (docs-only change)'
  console.log(summary)

  emit([
    ['tier', result.tier],
    ['e2e', result.e2e],
    ['reason', result.reasons.join(', ')],
  ])
}
