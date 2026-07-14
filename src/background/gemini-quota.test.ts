import { describe, expect, it } from 'vitest'
import type { Clock } from './clock'
import {
  CharacterTokenEstimator,
  getGeminiProviderDayId,
  getNextGeminiProviderDayStart,
  GeminiQuotaStore,
  normalizeGeminiQuotaSettings,
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

class MutableClock implements Clock {
  constructor(
    public wall: number,
    public monotonic: number = 0,
  ) {}

  wallNow = (): number => this.wall
  monotonicNow = (): number => this.monotonic
}

describe('GeminiQuotaStore', () => {
  it('fails closed instead of freeing full RPM capacity when wall time moves backward', async () => {
    const storage = createStorage()
    const clock = new MutableClock(10_000, 1_000)
    const store = new GeminiQuotaStore(storage, clock, () => 'rpm-reservation')
    const rpmProfile = {
      ...profile,
      requestsPerMinute: 1,
      rpmSafetyPercent: 100,
      inputTokensPerMinute: 1_000,
      requestsPerDay: 100,
    }

    await expect(store.reserve(rpmProfile, 1)).resolves.toMatchObject({ accepted: true })
    clock.wall -= 1

    await expect(store.reserve(rpmProfile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: 'clock_rollback',
    })
    await expect(store.getUsage()).resolves.toMatchObject({ rollingRequests: 1 })
  })

  it('fails closed instead of freeing full TPM capacity when wall time moves backward', async () => {
    const storage = createStorage()
    const clock = new MutableClock(10_000, 1_000)
    const store = new GeminiQuotaStore(storage, clock, () => 'tpm-reservation')
    const tpmProfile = {
      ...profile,
      requestsPerMinute: 100,
      inputTokensPerMinute: 10,
      tpmSafetyPercent: 100,
      requestsPerDay: 100,
    }

    await expect(store.reserve(tpmProfile, 10)).resolves.toMatchObject({ accepted: true })
    clock.wall -= 1

    await expect(store.reserve(tpmProfile, 10)).resolves.toMatchObject({
      accepted: false,
      reason: 'clock_rollback',
    })
    await expect(store.getUsage()).resolves.toMatchObject({ rollingInputTokens: 10 })
  })

  it.each([
    ['PDT', Date.UTC(2026, 6, 13, 7, 0, 1), Date.UTC(2026, 6, 13, 6, 59, 59)],
    ['PST', Date.UTC(2026, 0, 13, 8, 0, 1), Date.UTC(2026, 0, 13, 7, 59, 59)],
  ])('does not reset RPD when wall time rolls backward across Pacific midnight in %s', async (_label, afterMidnight, beforeMidnight) => {
    const storage = createStorage()
    const clock = new MutableClock(afterMidnight, 1_000)
    let id = 0
    const store = new GeminiQuotaStore(storage, clock, () => `rpd-${++id}`)
    const rpdProfile = {
      ...profile,
      requestsPerMinute: 100,
      inputTokensPerMinute: 1_000,
      requestsPerDay: 1,
      rpdSafetyPercent: 100,
    }

    await expect(store.reserve(rpdProfile, 1)).resolves.toMatchObject({ accepted: true })
    clock.wall = beforeMidnight

    await expect(store.reserve(rpdProfile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: 'clock_rollback',
    })
    await expect(store.getUsage()).resolves.toMatchObject({ requestsToday: 1 })
  })

  it('fails closed when a restarted worker observes wall time below the persisted high-water mark', async () => {
    const storage = createStorage()
    const firstClock = new MutableClock(10_000, 1_000)
    const quotaProfile = {
      ...profile,
      requestsPerMinute: 100,
      inputTokensPerMinute: 1_000,
      requestsPerDay: 100,
    }
    const first = new GeminiQuotaStore(storage, firstClock, () => 'before-restart')
    await first.reserve(quotaProfile, 1)

    const restoredClock = new MutableClock(9_999, 50)
    const restored = new GeminiQuotaStore(storage, restoredClock, () => 'after-restart')

    await expect(restored.reserve(quotaProfile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: 'clock_rollback',
    })
    expect(storage.local.wallHighWaterMark).toBe(10_000)
  })

  it('retains a persisted cooldown during rollback and recovers only after wall catches up', async () => {
    const storage = createStorage()
    const firstClock = new MutableClock(10_000, 1_000)
    const first = new GeminiQuotaStore(storage, firstClock, () => 'cooldown-original')
    const permissiveProfile = {
      ...profile,
      requestsPerMinute: 100,
      inputTokensPerMinute: 1_000,
      requestsPerDay: 100,
    }
    await first.openCooldown(5_000)

    const restoredClock = new MutableClock(9_000, 100)
    const restored = new GeminiQuotaStore(storage, restoredClock, () => 'cooldown-recovery')
    await expect(restored.reserve(permissiveProfile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: 'clock_rollback',
    })
    await expect(restored.getUsage()).resolves.toMatchObject({
      cooldownUntil: 15_000,
      clockRollback: true,
    })

    restoredClock.wall = 10_000
    restoredClock.monotonic = 5_099
    await expect(restored.reserve(permissiveProfile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: 'cooldown',
    })
    restoredClock.monotonic = 5_101
    await expect(restored.reserve(permissiveProfile, 1)).resolves.toMatchObject({ accepted: true })
    await expect(restored.getUsage()).resolves.toMatchObject({ cooldownUntil: 0, clockRollback: false })
  })

  it('does not let a forward wall jump shorten an in-process rolling window or cooldown', async () => {
    const storage = createStorage()
    const clock = new MutableClock(10_000, 1_000)
    let id = 0
    const store = new GeminiQuotaStore(storage, clock, () => `forward-${++id}`)
    const rpmProfile = {
      ...profile,
      requestsPerMinute: 1,
      rpmSafetyPercent: 100,
      inputTokensPerMinute: 1_000,
      requestsPerDay: 100,
    }
    await store.reserve(rpmProfile, 1)
    await store.openCooldown(5_000)

    clock.wall += 86_400_000
    clock.monotonic += 1_000

    await expect(store.reserve(rpmProfile, 1)).resolves.toMatchObject({ accepted: false, reason: 'cooldown' })
    clock.monotonic += 4_001
    await expect(store.reserve(rpmProfile, 1)).resolves.toMatchObject({ accepted: false, reason: 'rpm' })
  })

  it('does not reset RPD until monotonic elapsed time proves a forward Pacific-day transition', async () => {
    const beforeMidnight = Date.UTC(2026, 6, 13, 6, 59, 59)
    const storage = createStorage()
    const clock = new MutableClock(beforeMidnight, 1_000)
    let id = 0
    const store = new GeminiQuotaStore(storage, clock, () => `forward-rpd-${++id}`)
    const rpdProfile = {
      ...profile,
      requestsPerMinute: 100,
      inputTokensPerMinute: 1_000,
      requestsPerDay: 1,
      rpdSafetyPercent: 100,
    }
    await expect(store.reserve(rpdProfile, 1)).resolves.toMatchObject({ accepted: true })

    clock.wall += 86_400_000
    clock.monotonic += 500
    await expect(store.reserve(rpdProfile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: 'rpd',
    })
    await expect(store.getUsage()).resolves.toMatchObject({ requestsToday: 1 })

    clock.monotonic += 501
    await expect(store.reserve(rpdProfile, 1)).resolves.toMatchObject({ accepted: true })
  })

  it('anchors restored wall timestamps to the new worker monotonic epoch', async () => {
    const storage = createStorage()
    const firstClock = new MutableClock(10_000, 1_000)
    const rpmProfile = {
      ...profile,
      requestsPerMinute: 1,
      rpmSafetyPercent: 100,
      inputTokensPerMinute: 1_000,
      requestsPerDay: 100,
    }
    await new GeminiQuotaStore(storage, firstClock, () => 'persisted').reserve(rpmProfile, 1)

    const restoredClock = new MutableClock(40_000, 500)
    const restored = new GeminiQuotaStore(storage, restoredClock, () => 'restored')
    await restored.getUsage()
    restoredClock.monotonic += 29_999
    await expect(restored.reserve(rpmProfile, 1)).resolves.toMatchObject({ accepted: false, reason: 'rpm' })
    restoredClock.monotonic += 2
    await expect(restored.reserve(rpmProfile, 1)).resolves.toMatchObject({ accepted: true })
  })

  it('persists a wall high-water mark that never decreases and clears rollback after recovery', async () => {
    const storage = createStorage()
    const clock = new MutableClock(10_000, 1_000)
    const store = new GeminiQuotaStore(storage, clock, () => 'high-water')
    await store.getUsage()

    clock.wall = 9_000
    await expect(store.getUsage()).resolves.toMatchObject({ clockRollback: true })
    expect(storage.local.wallHighWaterMark).toBe(10_000)

    clock.wall = 11_000
    clock.monotonic += 1_000
    await expect(store.getUsage()).resolves.toMatchObject({ clockRollback: false })
    expect(storage.local.wallHighWaterMark).toBe(11_000)

    clock.wall = 10_500
    await store.getUsage()
    expect(storage.local.wallHighWaterMark).toBe(11_000)
  })

  it('migrates version-two state fail closed when no safe high-water mark exists', async () => {
    const storage = createStorage()
    const clock = new MutableClock(Date.UTC(2026, 6, 13, 12), 1_000)
    storage.local.quotaVersion = 2
    storage.local.buckets = {
      default: {
        reservations: [],
        cooldownUntil: 0,
        providerDay: getGeminiProviderDayId(clock.wall),
        requestsToday: 0,
      },
    }
    const store = new GeminiQuotaStore(storage, clock, () => 'after-v2')
    const permissiveProfile = {
      ...profile,
      requestsPerMinute: 100,
      inputTokensPerMinute: 1_000,
      requestsPerDay: 100,
    }

    await expect(store.reserve(permissiveProfile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: 'clock_rollback',
    })
    expect(storage.local).toMatchObject({
      quotaVersion: 3,
      wallHighWaterMark: clock.wall,
      clockTrusted: false,
    })

    clock.wall += 2 * 86_400_000
    clock.monotonic += 2 * 86_400_000
    await expect(store.reserve(permissiveProfile, 1, 'new-model')).resolves.toMatchObject({
      accepted: false,
      reason: 'clock_rollback',
    })
  })

  it('derives a conservative high-water mark from complete version-two reservations and recovers', async () => {
    const storage = createStorage()
    const clock = new MutableClock(9_000, 100)
    storage.local.quotaVersion = 2
    storage.local.buckets = {
      default: {
        reservations: [{ id: 'v2-reservation', at: 10_000, inputTokens: 1 }],
        cooldownUntil: 0,
        providerDay: getGeminiProviderDayId(10_000),
        requestsToday: 1,
      },
    }
    const store = new GeminiQuotaStore(storage, clock, () => 'after-recovery')
    const rpmProfile = {
      ...profile,
      requestsPerMinute: 1,
      rpmSafetyPercent: 100,
      inputTokensPerMinute: 1_000,
      requestsPerDay: 100,
    }

    await expect(store.reserve(rpmProfile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: 'clock_rollback',
    })
    expect(storage.local).toMatchObject({
      quotaVersion: 3,
      wallHighWaterMark: 10_000,
      clockTrusted: true,
    })

    clock.wall = 10_000
    clock.monotonic += 59_999
    await expect(store.reserve(rpmProfile, 1)).resolves.toMatchObject({ accepted: false, reason: 'rpm' })
    clock.monotonic += 2
    await expect(store.reserve(rpmProfile, 1)).resolves.toMatchObject({ accepted: true })
  })

  it('keeps a version-three snapshot without a safe high-water mark fail closed', async () => {
    const storage = createStorage()
    const clock = new MutableClock(Date.UTC(2026, 6, 13, 12), 1_000)
    storage.local.quotaVersion = 3
    storage.local.buckets = {
      default: {
        reservations: [],
        cooldownUntil: 0,
        providerDay: getGeminiProviderDayId(clock.wall),
        requestsToday: 0,
      },
    }
    const store = new GeminiQuotaStore(storage, clock)

    await expect(store.reserve(profile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: 'clock_rollback',
    })
    expect(storage.local).toMatchObject({ clockTrusted: false })
  })

  it('atomically reserves only the safe rolling RPM capacity', async () => {
    const store = new GeminiQuotaStore(createStorage(), () => 1_000)

    const reservations = await Promise.all(Array.from({ length: 6 }, () => store.reserve({ ...profile, requestsPerDay: 100 }, 1)))

    expect(reservations.filter((reservation) => reservation.accepted)).toHaveLength(4)
    expect(reservations.filter((reservation) => reservation.reason === 'rpm')).toHaveLength(2)
  })

  it('reserves at least one RPD request when requestsPerDay=1 and rpdSafetyPercent=95', async () => {
    const store = new GeminiQuotaStore(createStorage(), () => 1_000)
    const smallProfile = {
      ...profile,
      requestsPerMinute: 100,
      inputTokensPerMinute: 10_000,
      requestsPerDay: 1,
      rpdSafetyPercent: 95,
    }

    await expect(store.reserve(smallProfile, 1)).resolves.toMatchObject({ accepted: true })
    await expect(store.reserve(smallProfile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: 'rpd',
    })
  })

  it('atomically reserves TPM and RPD capacity under concurrent calls', async () => {
    const tokenStore = new GeminiQuotaStore(createStorage(), () => 1_000)
    const tokenReservations = await Promise.all([
      tokenStore.reserve({ ...profile, requestsPerMinute: 100, inputTokensPerMinute: 100, tpmSafetyPercent: 100 }, 60),
      tokenStore.reserve({ ...profile, requestsPerMinute: 100, inputTokensPerMinute: 100, tpmSafetyPercent: 100 }, 60),
    ])
    expect(tokenReservations.filter((reservation) => reservation.accepted)).toHaveLength(1)
    expect(tokenReservations.filter((reservation) => reservation.reason === 'tpm')).toHaveLength(1)

    const dayStore = new GeminiQuotaStore(createStorage(), () => 1_000)
    const dayReservations = await Promise.all([
      dayStore.reserve({ ...profile, requestsPerMinute: 100, requestsPerDay: 1 }, 1),
      dayStore.reserve({ ...profile, requestsPerMinute: 100, requestsPerDay: 1 }, 1),
    ])
    expect(dayReservations.filter((reservation) => reservation.accepted)).toHaveLength(1)
    expect(dayReservations.filter((reservation) => reservation.reason === 'rpd')).toHaveLength(1)
  })

  it('denies batches that exceed safe TPM and admits them after the rolling window expires', async () => {
    let now = 1_000
    const store = new GeminiQuotaStore(createStorage(), () => now)

    expect(await store.reserve(profile, 50)).toMatchObject({ accepted: true })
    expect(await store.reserve(profile, 31)).toMatchObject({ accepted: false, reason: 'tpm' })

    now += 60_001
    expect(await store.reserve(profile, 31)).toMatchObject({ accepted: true })
  })

  it('persists RPD across store instances and resets at Pacific midnight', async () => {
    const storage = createStorage()
    let now = Date.UTC(2026, 0, 13, 7, 59, 59)
    const dailyProfile = { ...profile, requestsPerMinute: 100, requestsPerDay: 2 }
    const first = new GeminiQuotaStore(storage, () => now)

    await first.reserve(dailyProfile, 1)
    await first.reserve(dailyProfile, 1)

    const restored = new GeminiQuotaStore(storage, () => now)
    expect(await restored.reserve(dailyProfile, 1)).toMatchObject({ accepted: false, reason: 'rpd' })

    now = Date.UTC(2026, 0, 13, 8, 0, 0)
    expect(await restored.reserve(dailyProfile, 1)).toMatchObject({ accepted: true })
  })

  it('persists independent model quota buckets and cooldowns across restarts', async () => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 12)
    const first = new GeminiQuotaStore(storage, () => now, () => 'flash-reservation')

    await first.reserve(profile, 10, 'gemini-2.5-flash')
    await first.openCooldown(30_000, 'gemini-2.5-flash')

    const restored = new GeminiQuotaStore(storage, () => now, () => 'pro-reservation')
    await expect(restored.getUsage('gemini-2.5-flash')).resolves.toMatchObject({
      rollingRequests: 1,
      rollingInputTokens: 10,
      requestsToday: 1,
      cooldownUntil: now + 30_000,
    })
    await expect(restored.getUsage('gemini-2.5-pro')).resolves.toMatchObject({
      rollingRequests: 0,
      rollingInputTokens: 0,
      requestsToday: 0,
      cooldownUntil: 0,
    })
  })

  it('copies ambiguous legacy usage conservatively into every model bucket', async () => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 1)
    Object.assign(storage.local, { providerDay: '2026-07-13', requestsToday: 2 })
    Object.assign(storage.session, {
      reservations: [{ id: 'legacy-request', at: now, inputTokens: 7 }],
      cooldownUntil: now + 30_000,
    })
    const store = new GeminiQuotaStore(storage, () => now)

    for (const model of ['gemini-2.5-flash', 'gemini-2.5-pro']) {
      await expect(store.getUsage(model)).resolves.toMatchObject({
        rollingRequests: 1,
        rollingInputTokens: 7,
        requestsToday: 2,
        cooldownUntil: now + 30_000,
      })
    }
  })

  it.each([
    ['zero', { ...profile, requestsPerMinute: 0 }],
    ['negative', { ...profile, requestsPerMinute: -1 }],
    ['NaN', { ...profile, requestsPerMinute: Number.NaN }],
    ['malformed', { requestsPerMinute: 'broken' }],
  ])('normalizes a %s quota profile instead of throwing', async (_name, candidate) => {
    const store = new GeminiQuotaStore(createStorage(), () => 1_000)

    await expect(store.reserve(candidate as unknown as GeminiQuotaSettings, 1)).resolves.toMatchObject({ accepted: true })
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

  it('rolls back a failed release instead of losing a dispatched reservation', async () => {
    const storage = createStorage()
    const store = new GeminiQuotaStore(storage, () => 1_000)
    const reservation = await store.reserve(profile, 10)
    const originalSetLocal = storage.setLocal
    storage.setLocal = async () => { throw new Error('release persistence failed') }

    await expect(store.release(reservation.reservationId!)).rejects.toThrow('release persistence failed')

    storage.setLocal = originalSetLocal
    await expect(store.getUsage()).resolves.toMatchObject({
      rollingRequests: 1,
      rollingInputTokens: 10,
      requestsToday: 1,
    })
  })

  it('uses injected restart-safe reservation IDs to release the matching token charge', async () => {
    const storage = createStorage()
    const now = 1_000
    const firstStore = new GeminiQuotaStore(storage, () => now, () => 'worker-a-reservation')
    const first = await firstStore.reserve({
      ...profile,
      requestsPerMinute: 100,
      inputTokensPerMinute: 1_000,
      requestsPerDay: 100,
    }, 10)
    const secondStore = new GeminiQuotaStore(storage, () => now, () => 'worker-b-reservation')
    const second = await secondStore.reserve({
      ...profile,
      requestsPerMinute: 100,
      inputTokensPerMinute: 1_000,
      requestsPerDay: 100,
    }, 20)

    expect(first.reservationId).toBe('worker-a-reservation')
    expect(second.reservationId).toBe('worker-b-reservation')

    await secondStore.release(second.reservationId!)

    const restored = new GeminiQuotaStore(storage, () => now, () => 'worker-c-reservation')
    await expect(restored.getUsage()).resolves.toMatchObject({
      rollingRequests: 1,
      rollingInputTokens: 10,
      requestsToday: 1,
    })
  })

  it('does not restore an uncommitted reservation after a service-worker restart', async () => {
    const storage = createStorage()
    const originalSetLocal = storage.setLocal
    storage.setLocal = async () => { throw new Error('local persistence failed') }
    const first = new GeminiQuotaStore(storage, () => 1_000)

    await expect(first.reserve(profile, 10)).rejects.toThrow('local persistence failed')

    storage.setLocal = originalSetLocal
    const restored = new GeminiQuotaStore(storage, () => 1_000)
    await expect(restored.getUsage()).resolves.toMatchObject({
      rollingRequests: 0,
      rollingInputTokens: 0,
    })
  })

  it('retries legacy restoration after a transient session read failure', async () => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 1)
    Object.assign(storage.local, { providerDay: '2026-07-13', requestsToday: 2 })
    Object.assign(storage.session, { reservations: [], cooldownUntil: 0 })
    let failSessionRead = true
    storage.getSession = async () => {
      if (failSessionRead) {
        failSessionRead = false
        throw new Error('session temporarily unavailable')
      }
      return storage.session
    }
    const store = new GeminiQuotaStore(storage, () => now)
    const dailyProfile = {
      ...profile,
      requestsPerMinute: 100,
      inputTokensPerMinute: 10_000,
      requestsPerDay: 2,
    }

    await expect(store.reserve(dailyProfile, 1)).rejects.toThrow('session temporarily unavailable')
    await expect(store.reserve(dailyProfile, 1)).resolves.toMatchObject({ accepted: false, reason: 'rpd' })
  })

  it('fails closed for malformed current-day usage and rolling token state', async () => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 12)
    storage.local.providerDay = getGeminiProviderDayId(now)
    storage.local.requestsToday = 'corrupt'
    storage.session.reservations = [{ at: now, inputTokens: 'corrupt' }]
    const store = new GeminiQuotaStore(storage, () => now)

    await expect(store.reserve(profile, 1)).resolves.toMatchObject({ accepted: false, reason: 'tpm' })
    await expect(store.getUsage()).resolves.toMatchObject({
      rollingRequests: 1,
      rollingInputTokens: Number.MAX_SAFE_INTEGER,
      requestsToday: Number.MAX_SAFE_INTEGER,
    })
  })

  it('fails closed for a truncated canonical quota snapshot', async () => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 12)
    Object.assign(storage.local, { quotaVersion: 1 })
    const store = new GeminiQuotaStore(storage, () => now)

    await expect(store.reserve(profile, 1)).resolves.toMatchObject({ accepted: false, reason: 'tpm' })
    await expect(store.getUsage()).resolves.toMatchObject({
      rollingRequests: 1,
      rollingInputTokens: Number.MAX_SAFE_INTEGER,
      requestsToday: Number.MAX_SAFE_INTEGER,
    })
  })

  it.each([
    [
      'legacy fixed-offset day from the prior implementation',
      { providerDay: '2026-07-13', requestsToday: 2 },
      'rpd',
    ],
    [
      'impossible canonical day',
      { quotaVersion: 1, reservations: [], cooldownUntil: 0, providerDay: '2026-02-30', requestsToday: 2 },
      'rpd',
    ],
    [
      'impossible canonical year zero',
      { quotaVersion: 1, reservations: [], cooldownUntil: 0, providerDay: '0000-01-01', requestsToday: 2 },
      'rpd',
    ],
    [
      'future canonical day',
      { quotaVersion: 1, reservations: [], cooldownUntil: 0, providerDay: '2099-01-01', requestsToday: 2 },
      'rpd',
    ],
    [
      'missing canonical day',
      { quotaVersion: 1, reservations: [], cooldownUntil: 0, requestsToday: 2 },
      'rpd',
    ],
    [
      'unknown future storage version',
      { quotaVersion: 4, reservations: [], cooldownUntil: 0, providerDay: '2026-07-13', requestsToday: 2 },
      'clock_rollback',
    ],
  ])('preserves RPD usage for %s', async (_label, localState, expectedReason) => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 1, 0, 0)
    Object.assign(storage.local, localState)
    Object.assign(storage.session, { reservations: [], cooldownUntil: 0 })
    const store = new GeminiQuotaStore(storage, () => now)
    const dailyProfile = {
      ...profile,
      requestsPerMinute: 100,
      inputTokensPerMinute: 10_000,
      requestsPerDay: 2,
    }

    await expect(store.reserve(dailyProfile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: expectedReason,
    })
    await expect(store.getUsage()).resolves.toMatchObject({ requestsToday: 2 })
    expect((storage.local.buckets as Record<string, { providerDay: string }>).default!.providerDay)
      .toBe('2026-07-12')
  })

  it.each([
    ['partial legacy state', { providerDay: '2026-07-13' }, 'rpd'],
    ['unknown storage version', { quotaVersion: 99, providerDay: '2026-07-13' }, 'clock_rollback'],
  ])('fails closed when %s omits the RPD count', async (_label, localState, expectedReason) => {
    const storage = createStorage()
    let now = Date.UTC(2026, 6, 13, 1, 0, 0)
    Object.assign(storage.local, localState)
    Object.assign(storage.session, { reservations: [], cooldownUntil: 0 })
    const store = new GeminiQuotaStore(storage, () => now)
    const dailyProfile = {
      ...profile,
      requestsPerMinute: 100,
      inputTokensPerMinute: 10_000,
      requestsPerDay: 2,
    }

    await expect(store.getUsage()).resolves.toMatchObject({ requestsToday: Number.MAX_SAFE_INTEGER })
    now += 60_001
    await expect(store.reserve(dailyProfile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: expectedReason,
    })
  })

  it.each([
    ['canonical bucket', {
      quotaVersion: 3,
      wallHighWaterMark: Date.UTC(2026, 6, 13, 12, 0, 0),
      clockTrusted: true,
      buckets: {
        default: {
          reservations: [],
          cooldownUntil: 0,
          providerDay: '2026-07-11',
          requestsToday: 'malformed',
        },
      },
    }],
    ['version-one snapshot', {
      quotaVersion: 1,
      reservations: [],
      cooldownUntil: 0,
      providerDay: '2026-07-11',
      requestsToday: 'malformed',
    }],
  ])('does not reset malformed RPD usage merely because the %s day looks old', async (_label, localState) => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 12, 0, 0)
    Object.assign(storage.local, localState)
    const store = new GeminiQuotaStore(storage, () => now)

    await expect(store.getUsage()).resolves.toMatchObject({ requestsToday: Number.MAX_SAFE_INTEGER })
  })

  it('resets RPD only for a valid canonical day that is provably in the past', async () => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 12, 0, 0)
    Object.assign(storage.local, {
      quotaVersion: 1,
      reservations: [],
      cooldownUntil: 0,
      providerDay: '2026-07-11',
      requestsToday: 2,
    })
    const store = new GeminiQuotaStore(storage, () => now)

    await expect(store.getUsage()).resolves.toMatchObject({ requestsToday: 0 })
    expect((storage.local.buckets as Record<string, { providerDay: string }>).default!.providerDay)
      .toBe('2026-07-13')
  })

  it('reports the Pacific provider-day reset before another reservation', async () => {
    const storage = createStorage()
    let now = Date.UTC(2026, 0, 13, 7, 59, 59)
    const store = new GeminiQuotaStore(storage, () => now)
    await store.reserve(profile, 1)

    now = Date.UTC(2026, 0, 13, 8, 0, 0)

    await expect(store.getUsage()).resolves.toMatchObject({ requestsToday: 0 })
  })
})

describe('Gemini quota settings', () => {
  it('normalizes missing and invalid fields to positive safe defaults', () => {
    const normalized = normalizeGeminiQuotaSettings({
      requestsPerMinute: 0,
      inputTokensPerMinute: -1,
      requestsPerDay: Number.NaN,
      rpmSafetyPercent: 'invalid',
      liveMaxWaitMs: Number.POSITIVE_INFINITY,
      maxConcurrency: 0,
    })

    expect(normalized.requestsPerMinute).toBeGreaterThan(0)
    expect(normalized.inputTokensPerMinute).toBeGreaterThan(0)
    expect(normalized.requestsPerDay).toBeGreaterThan(0)
    expect(normalized.rpmSafetyPercent).toBeGreaterThan(0)
    expect(normalized.liveMaxWaitMs).toBeGreaterThan(0)
    expect(normalized.maxConcurrency).toBe(1)
  })
})

describe('Gemini provider day', () => {
  it.each([
    ['PST', Date.UTC(2026, 0, 13, 7, 59, 59), '2026-01-12', Date.UTC(2026, 0, 13, 8, 0, 0)],
    ['PDT', Date.UTC(2026, 6, 13, 6, 59, 59), '2026-07-12', Date.UTC(2026, 6, 13, 7, 0, 0)],
    ['spring DST transition', Date.UTC(2026, 2, 8, 8, 0, 0), '2026-03-08', Date.UTC(2026, 2, 9, 7, 0, 0)],
    ['fall DST transition', Date.UTC(2026, 10, 1, 7, 0, 0), '2026-11-01', Date.UTC(2026, 10, 2, 8, 0, 0)],
  ])('uses America/Los_Angeles at the %s boundary', (_label, now, expectedDay, expectedNext) => {
    expect(getGeminiProviderDayId(now)).toBe(expectedDay)
    expect(getNextGeminiProviderDayStart(now)).toBe(expectedNext)
  })
})

describe('CharacterTokenEstimator', () => {
  it('conservatively estimates serialized prompt tokens without an API call', () => {
    const estimator = new CharacterTokenEstimator()

    expect(estimator.estimate({ system: 'abc', user: 'defghi' })).toBe(4)
  })
})
