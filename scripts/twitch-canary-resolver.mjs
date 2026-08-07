#!/usr/bin/env node
// Resolver for the scheduled Twitch canary: deterministically select one
// currently live channel from the configured candidate list and print its
// canonical twitch.tv URL.
//
// Environment:
//   TWITCH_CANARY_CANDIDATES  (required)  comma-separated channel logins
//   TWITCH_CLIENT_ID          (required)  Twitch application client id (secret)
//   TWITCH_CLIENT_SECRET      (required)  Twitch application client secret
//
// Exit codes: 0 on success; 1 on any configuration/auth/Helix/selection
// failure. Logs may mention candidate logins but never secrets, tokens,
// authorization headers, or credential-bearing response bodies.
//
// No changes to the Extension source or test behavior are made here — the
// URL is only printed for the caller (the workflow) to export and hand to the
// existing `pnpm test:e2e:canary` command.
import { parseCandidates, buildLiveByLogin, pickLiveChannel } from './twitch-canary-selector.mjs'

const MAX_TOKEN_BYTES = 4096
const MAX_STREAM_LOGINS = 100
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const STREAMS_URL = 'https://api.twitch.tv/helix/streams'

const baseUrl = new URL('https://www.twitch.tv')

function fatal(message) {
  console.error(`[twitch-canary-resolver] ${message}`)
  process.exit(1)
}

function reportTokenResponse(response) {
  if (response && response.ok && response.status === 200) {
    console.error('[twitch-canary-resolver] Obtained Twitch app access token.')
    return
  }
  console.error('[twitch-canary-resolver] Could not obtain a Twitch app access token.')
  if (response && response.status >= 500) {
    console.error(`[twitch-canary-resolver] Twitch token endpoint returned HTTP ${response.status}.`)
    return
  }
  console.error('[twitch-canary-resolver] Twitch token endpoint rejected the request.')
}

async function main() {
  const candidates = parseCandidates(process.env.TWITCH_CANARY_CANDIDATES)

  const clientId = process.env.TWITCH_CLIENT_ID
  const clientSecret = process.env.TWITCH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    fatal('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must both be set')
  }

  let tokenResponse
  let tokenBody
  try {
    tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
    })
    tokenBody = await tokenResponse.text()
  } catch (error) {
    reportTokenResponse(undefined)
    if (error && error.message) {
      console.error(`[twitch-canary-resolver] Token request failed: ${error.message}`)
    }
    process.exit(1)
  }
  reportTokenResponse(tokenResponse)

  if (!tokenResponse.ok || !tokenBody) {
    fatal('Authentication failed: no app access token obtained')
  }
  if (tokenBody.length > MAX_TOKEN_BYTES) {
    fatal('Authentication failed: token response exceeded the accepted size limit')
  }
  if (tokenBody.includes('access_token') && !/^\s*\{/.test(tokenBody)) {
    fatal('Authentication failed: token response was not valid JSON')
  }

  let token
  try {
    const parsed = JSON.parse(tokenBody)
    token = typeof parsed === 'object' && parsed !== null ? parsed.access_token : undefined
  } catch {
    fatal('Authentication failed: token response was not valid JSON')
  }
  if (typeof token !== 'string' || token.length === 0) {
    fatal('Authentication failed: no app access token in the response')
  }

  const targetLogins = candidates.slice(0, MAX_STREAM_LOGINS).map((login) => login.toLowerCase())
  const params = new URLSearchParams({ first: String(MAX_STREAM_LOGINS) })
  for (const login of targetLogins) params.append('user_login', login)
  const streamsUrl = `${STREAMS_URL}?${params.toString()}`

  let streamsBody
  try {
    const streamsResponse = await fetch(streamsUrl, {
      headers: {
        'Client-Id': clientId,
        Authorization: `Bearer ${token}`,
      },
    })
    streamsBody = await streamsResponse.text()
    if (!streamsResponse.ok) {
      fatal(`Twitch Helix streams request failed with HTTP ${streamsResponse.status}`)
    }
  } catch (error) {
    if (error && error.message) {
      console.error(`[twitch-canary-resolver] Helix request failed: ${error.message}`)
    }
    fatal('Twitch Helix streams request failed')
  }

  let payload
  try {
    payload = JSON.parse(streamsBody)
  } catch {
    fatal('Twitch Helix returned invalid JSON')
  }

  const liveByLogin = buildLiveByLogin(payload.data, targetLogins)
  const selected = pickLiveChannel(targetLogins, liveByLogin)
  const channelUrl = new URL(`/${selected.login}`, baseUrl)

  console.error(`[twitch-canary-resolver] Selected live candidate: ${selected.login} (${selected.viewerCount} viewers)`)
  // stdout must be a single GITHUB_ENV-compatible line (`>> "$GITHUB_ENV"`).
  console.log(`TWITCH_CANARY_URL=${channelUrl.toString()}`)
}

main().catch((error) => {
  fatal(`Unexpected error: ${error && error.message ? error.message : String(error)}`)
})
