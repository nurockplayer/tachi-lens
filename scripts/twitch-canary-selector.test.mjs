// Unit tests for the pure canary resolver selection logic.
// Run with: node --test scripts/twitch-canary-selector.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCandidates, buildLiveByLogin, pickLiveChannel } from './twitch-canary-selector.mjs'

test('parseCandidates trims whitespace and drops empty entries', () => {
  assert.deepEqual(parseCandidates('  alpha , beta ,, gamma '), ['alpha', 'beta', 'gamma'])
})

test('parseCandidates rejects an empty normalized list', () => {
  assert.throws(() => parseCandidates('   ,, , '), /must contain at least one candidate channel/)
})

test('parseCandidates rejects a non-string value', () => {
  assert.throws(() => parseCandidates(undefined), /must be a comma-separated list/)
  assert.throws(() => parseCandidates(null), /must be a comma-separated list/)
})

test('buildLiveByLogin indexes only configured candidates by lowercased login', () => {
  const liveByLogin = buildLiveByLogin(
    [
      { user_login: 'Alpha', viewer_count: 100 },
      { user_login: 'BETA', viewer_count: 50 },
    ],
    ['alpha', 'beta', 'gamma'],
  )
  assert.equal(liveByLogin.get('alpha'), 100)
  assert.equal(liveByLogin.get('beta'), 50)
  assert.equal(liveByLogin.has('gamma'), false)
})

test('buildLiveByLogin rejects a non-array payload', () => {
  assert.throws(() => buildLiveByLogin({ data: [] }, ['alpha']), /invalid streams payload/)
  assert.throws(() => buildLiveByLogin(null, ['alpha']), /invalid streams payload/)
})

test('buildLiveByLogin rejects malformed entries', () => {
  assert.throws(() => buildLiveByLogin([{ user_login: '', viewer_count: 10 }], ['alpha']), /malformed stream entry/)
  assert.throws(() => buildLiveByLogin([{ user_login: 'alpha', viewer_count: 'nope' }], ['alpha']), /malformed stream entry/)
  assert.throws(() => buildLiveByLogin([{ user_login: 'alpha', viewer_count: NaN }], ['alpha']), /malformed stream entry/)
  assert.throws(() => buildLiveByLogin([{ user_login: 'alpha', viewer_count: -1 }], ['alpha']), /malformed stream entry/)
  assert.throws(() => buildLiveByLogin([null], ['alpha']), /malformed stream entry/)
})

test('buildLiveByLogin rejects a stream entry outside the candidate list', () => {
  assert.throws(
    () => buildLiveByLogin([{ user_login: 'hacker', viewer_count: 1 }], ['alpha']),
    /outside the configured candidate list/,
  )
})

test('pickLiveChannel prefers the highest viewer count', () => {
  const candidates = ['alpha', 'beta', 'gamma']
  const liveByLogin = new Map([
    ['alpha', 10],
    ['beta', 500],
    ['gamma', 99],
  ])
  assert.deepEqual(pickLiveChannel(candidates, liveByLogin), { login: 'beta', viewerCount: 500 })
})

test('pickLiveChannel uses candidate-list order to break viewer-count ties', () => {
  const candidates = ['alpha', 'beta', 'gamma']
  const liveByLogin = new Map([
    ['beta', 42],
    ['gamma', 42],
    ['alpha', 42],
  ])
  // Tie: alpha appears first in the candidate list, so it must win.
  assert.deepEqual(pickLiveChannel(candidates, liveByLogin), { login: 'alpha', viewerCount: 42 })
})

test('pickLiveChannel ignores candidates absent from the live map', () => {
  const candidates = ['alpha', 'beta', 'gamma']
  const liveByLogin = new Map([['beta', 7]])
  assert.deepEqual(pickLiveChannel(candidates, liveByLogin), { login: 'beta', viewerCount: 7 })
})

test('pickLiveChannel throws when no candidate is live', () => {
  const candidates = ['alpha', 'beta']
  const liveByLogin = new Map([])
  assert.throws(() => pickLiveChannel(candidates, liveByLogin), /No configured candidate is currently live/)
})

test('pickLiveChannel throws on an empty candidate list', () => {
  assert.throws(() => pickLiveChannel([], new Map()), /Candidate list is empty/)
})

test('pickLiveChannel is case-insensitive against the candidate list', () => {
  const candidates = ['Alpha', 'Beta']
  const liveByLogin = new Map([['beta', 3]])
  assert.deepEqual(pickLiveChannel(candidates, liveByLogin), { login: 'beta', viewerCount: 3 })
})
