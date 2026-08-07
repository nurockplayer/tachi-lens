// Pure selection + normalization helpers for the Twitch canary resolver.
// No network I/O and no process access here so every branch is unit-testable
// via `node --test` (see twitch-canary-selector.test.mjs).

/** Parse a comma-separated candidate list: trim, drop empty entries, and
 *  reject a list that normalizes to nothing. */
export function parseCandidates(raw) {
  if (typeof raw !== 'string') {
    throw new Error('TWITCH_CANARY_CANDIDATES must be a comma-separated list of channel logins')
  }
  const list = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (list.length === 0) {
    throw new Error('TWITCH_CANARY_CANDIDATES must contain at least one candidate channel')
  }
  return list
}

/** Validate a Twitch Helix streams payload and index it by lowercased login.
 *  Any malformed entry or an entry outside the configured candidates is a
 *  hard failure: we must never silently guess a stream's state. */
export function buildLiveByLogin(data, logins) {
  if (!Array.isArray(data)) {
    throw new Error('Twitch Helix returned an invalid streams payload')
  }
  const known = new Set(logins)
  const liveByLogin = new Map()
  for (const entry of data) {
    if (
      typeof entry !== 'object' || entry === null ||
      typeof entry.user_login !== 'string' || entry.user_login.length === 0 ||
      typeof entry.viewer_count !== 'number' || !Number.isFinite(entry.viewer_count) || entry.viewer_count < 0
    ) {
      throw new Error('Twitch Helix returned a malformed stream entry')
    }
    const login = entry.user_login.toLowerCase()
    if (!known.has(login)) {
      throw new Error('Twitch Helix returned a stream entry outside the configured candidate list')
    }
    liveByLogin.set(login, entry.viewer_count)
  }
  return liveByLogin
}

/** Deterministically pick the live candidate with the highest viewer count,
 *  using candidate-list order as the tie-breaker. Throws when nothing is live. */
export function pickLiveChannel(candidates, liveByLogin) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('Candidate list is empty')
  }
  const live = []
  for (let index = 0; index < candidates.length; index += 1) {
    const login = candidates[index].toLowerCase()
    const viewerCount = liveByLogin.get(login)
    if (viewerCount !== undefined) {
      live.push({ login, viewerCount, index })
    }
  }
  if (live.length === 0) {
    throw new Error('No configured candidate is currently live')
  }
  live.sort((a, b) => {
    if (b.viewerCount !== a.viewerCount) return b.viewerCount - a.viewerCount
    return a.index - b.index
  })
  return { login: live[0].login, viewerCount: live[0].viewerCount }
}
