import { describe, expect, it } from 'vitest'
import {
  CharacterTokenEstimator,
  GeminiQuotaStore,
  type GeminiQuotaSettings,
  type QuotaStorage,
} from './gemini-quota'

const profile: GeminiQuotaSettings = {
  requestsPerMinute: 5,
  inputTokensPerMinute: 100,
  requestsPerDay: 3,
  rpmSafetyPercent: 80,
  tpmSafetyPercent: 80,
  rpdSafetyPercent: 100,
  liveMaxWaitMs: 1_000,
  maxConcurrency: 1,
  providerDayStartHourUtc: 0,
}

const createStorage = (): QuotaStorage & { session: Record<string, unknown>; local: Record<string, unknown> } => {
  const session: Record<string, unknown> = {}
  const local: Record<string, unknown> = {}

  return {
    session,
    local,
    getSession: async () => session,
    setSession: async (value) => { Object.assign(session, value) },
    getLocal: async () => local,
    setLocal: async (value) => { Object.assign(local, value) },
  }
}

describe('GeminiQuotaStore', () => {
  it('atomically reserves only the safe rolling RPM capacity', async () => {
    const store = new GeminiQuotaStore(createStorage(), () => 1_000)

    const reservations = await Promise.all(Array.from({ length: 6 }, () => store.reserve({ ...profile, requestsPerDay: 100 }, 1)))

    expect(reservations.filter((reservation) => reservation.accepted)).toHaveLength(4)
    expect(reservations.filter((reservation) => reservation.reason === 'rpm')).toHaveLength(2)
  })

  it('denies batches that exceed safe TPM and admits them after the rolling window expires', async () => {
    let now = 1_000
    const store = new GeminiQuotaStore(createStorage(), () => now)

    expect(await store.reserve(profile, 50)).toMatchObject({ accepted: true })
    expect(await store.reserve(profile, 31)).toMatchObject({ accepted: false, reason: 'tpm' })

    now += 60_001
    expect(await store.reserve(profile, 31)).toMatchObject({ accepted: true })
  })

  it('persists RPD across store instances and resets at the configured provider-day boundary', async () => {
    const storage = createStorage()
    let now = Date.UTC(2026, 6, 13, 2, 0, 0)
    const dailyProfile = { ...profile, requestsPerMinute: 100, requestsPerDay: 2, providerDayStartHourUtc: 3 }
    const first = new GeminiQuotaStore(storage, () => now)

    await first.reserve(dailyProfile, 1)
    await first.reserve(dailyProfile, 1)

    const restored = new GeminiQuotaStore(storage, () => now)
    expect(await restored.reserve(dailyProfile, 1)).toMatchObject({ accepted: false, reason: 'rpd' })

    now = Date.UTC(2026, 6, 13, 3, 0, 0)
    expect(await restored.reserve(dailyProfile, 1)).toMatchObject({ accepted: true })
  })

  it('restores cooldown state and prunes stale rolling reservations', async () => {
    const storage = createStorage()
    let now = 1_000
    const first = new GeminiQuotaStore(storage, () => now)
    await first.reserve(profile, 1)
    await first.openCooldown(5_000)

    const restored = new GeminiQuotaStore(storage, () => now)
    expect(await restored.reserve(profile, 1)).toMatchObject({ accepted: false, reason: 'cooldown' })

    now += 60_001
    expect(await restored.getUsage()).toMatchObject({ rollingRequests: 0, rollingInputTokens: 0 })
  })
})

describe('CharacterTokenEstimator', () => {
  it('conservatively estimates serialized prompt tokens without an API call', () => {
    const estimator = new CharacterTokenEstimator()

    expect(estimator.estimate({ system: 'abc', user: 'defghi' })).toBe(4)
  })
})
