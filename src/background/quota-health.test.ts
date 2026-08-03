import { describe, expect, it } from 'vitest'
import type { Clock } from './clock'
import {
  getGeminiProviderDayId,
  GeminiQuotaStore,
  type GeminiQuotaSettings,
  type QuotaStorage,
} from './gemini-quota'
import { collectQuotaHealthResults, deriveQuotaHealth } from './quota-health'
import type { QuotaSnapshotDiagnosticState } from './gemini-quota'

const profile: GeminiQuotaSettings = {
  requestsPerMinute: 5,
  inputTokensPerMinute: 100,
  requestsPerDay: 3,
  rpmSafetyPercent: 80,
  tpmSafetyPercent: 80,
  rpdSafetyPercent: 95,
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

const completeSnapshot = (overrides: Partial<QuotaSnapshotDiagnosticState> = {}): QuotaSnapshotDiagnosticState => ({
  isPresent: true,
  version: 3,
  hasSafeHighWaterMark: true,
  clockTrusted: true,
  hasUnsafeDailyCount: false,
  ...overrides,
})

describe('deriveQuotaHealth', () => {
  it('maps a healthy bucket to the healthy status', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'gemini-2.5-flash',
      bucket: {
        providerDay: getGeminiProviderDayId(1_000),
        requestsToday: 1,
        cooldownUntil: 0,
        hasConservativelyImputedRollingState: false,
        hasConservativelyImputedDailyState: false,
        hasUnsafeRollingCount: false,
      },
      snapshot: completeSnapshot(),
      wallNow: 1_000,
      highWaterMark: 1_000,
    })

    expect(result.status).toBe('healthy')
    expect(result.snapshotStatus).toBe('complete')
    expect(result.snapshotVersion).toBe(3)
    expect(result.denialReason).toBeUndefined()
    expect(result.recoveryAt).toBeUndefined()
    expect(result.cooldownUntil).toBeUndefined()
  })

  it('maps an active cooldown to the cooldown status with the recovery wall time', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'gemini-2.5-flash',
      bucket: {
        providerDay: getGeminiProviderDayId(1_000),
        requestsToday: 1,
        cooldownUntil: 6_000,
        hasConservativelyImputedRollingState: false,
        hasConservativelyImputedDailyState: false,
        hasUnsafeRollingCount: false,
      },
      snapshot: completeSnapshot(),
      wallNow: 1_000,
      highWaterMark: 1_000,
    })

    expect(result.status).toBe('cooldown')
    expect(result.denialReason).toBe('cooldown')
    expect(result.cooldownUntil).toBe(6_000)
    expect(result.recoveryAt).toBeUndefined()
  })

  it('maps a wall clock behind the high-water mark to clock_rollback with a recovery time', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: {
        providerDay: getGeminiProviderDayId(2_000),
        requestsToday: 1,
        cooldownUntil: 0,
        hasConservativelyImputedRollingState: false,
        hasConservativelyImputedDailyState: false,
        hasUnsafeRollingCount: false,
      },
      snapshot: completeSnapshot(),
      wallNow: 1_500,
      highWaterMark: 2_000,
    })

    expect(result.status).toBe('clock_rollback')
    expect(result.denialReason).toBe('clock_rollback')
    expect(result.recoveryAt).toBe(2_000)
  })

  it('maps a persisted provider day in the future to clock_rollback with the next day boundary', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: {
        providerDay: '2099-01-01',
        requestsToday: 1,
        cooldownUntil: 0,
        hasConservativelyImputedRollingState: false,
        hasConservativelyImputedDailyState: false,
        hasUnsafeRollingCount: false,
      },
      snapshot: completeSnapshot(),
      wallNow: 1_000,
      highWaterMark: 1_000,
    })

    expect(result.status).toBe('clock_rollback')
    expect(result.denialReason).toBe('clock_rollback')
    expect(result.recoveryAt).toBeGreaterThan(1_000)
    // Recovery lands at the Pacific midnight of the persisted future day.
    expect(getGeminiProviderDayId(result.recoveryAt!)).toBe('2099-01-01')
  })

  it('maps an untrusted-migration snapshot to untrusted_migration without a recovery time', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: {
        providerDay: getGeminiProviderDayId(1_000),
        requestsToday: Number.MAX_SAFE_INTEGER,
        cooldownUntil: 0,
        hasConservativelyImputedRollingState: true,
        hasConservativelyImputedDailyState: true,
        hasUnsafeRollingCount: false,
      },
      snapshot: completeSnapshot({ clockTrusted: false }),
      wallNow: 1_000,
      highWaterMark: 1_000,
    })

    expect(result.status).toBe('untrusted_migration')
    expect(result.snapshotStatus).toBe('untrusted_migration')
    expect(result.recoveryAt).toBeUndefined()
    expect(result.cooldownUntil).toBeUndefined()
  })

  it('maps a conservatively imputed daily count to malformed_snapshot', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: {
        providerDay: getGeminiProviderDayId(1_000),
        requestsToday: Number.MAX_SAFE_INTEGER,
        cooldownUntil: 0,
        hasConservativelyImputedRollingState: false,
        hasConservativelyImputedDailyState: true,
        hasUnsafeRollingCount: false,
      },
      snapshot: completeSnapshot(),
      wallNow: 1_000,
      highWaterMark: 1_000,
    })

    expect(result.status).toBe('malformed_snapshot')
    expect(result.snapshotStatus).toBe('complete')
    expect(result.denialReason).toBeUndefined()
  })

  it('maps a conservatively imputed rolling token count to malformed_snapshot', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: {
        providerDay: getGeminiProviderDayId(1_000),
        requestsToday: 1,
        cooldownUntil: 0,
        hasConservativelyImputedRollingState: true,
        hasConservativelyImputedDailyState: false,
        hasUnsafeRollingCount: false,
      },
      snapshot: completeSnapshot(),
      wallNow: 1_000,
      highWaterMark: 1_000,
    })

    expect(result.status).toBe('malformed_snapshot')
  })

  it('maps an unsupported future snapshot version to unsupported_version', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: {
        providerDay: getGeminiProviderDayId(1_000),
        requestsToday: 1,
        cooldownUntil: 0,
        hasConservativelyImputedRollingState: false,
        hasConservativelyImputedDailyState: false,
        hasUnsafeRollingCount: false,
      },
      snapshot: completeSnapshot({ version: 4, clockTrusted: false }),
      wallNow: 1_000,
      highWaterMark: 1_000,
    })

    expect(result.status).toBe('unsupported_version')
    expect(result.snapshotStatus).toBe('unsupported_version')
    expect(result.snapshotVersion).toBe(4)
  })

  it('maps missing state with no bucket to healthy', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: undefined,
      snapshot: completeSnapshot({ isPresent: false, version: null, hasSafeHighWaterMark: false, clockTrusted: false }),
      wallNow: 1_000,
      highWaterMark: 1_000,
    })

    expect(result.status).toBe('healthy')
    expect(result.snapshotStatus).toBe('missing')
    expect(result.snapshotVersion).toBe(null)
  })
})

describe('GeminiQuotaStore.getDiagnosticState', () => {
  it('reports a fresh healthy store without persisting quota state', async () => {
    const storage = createStorage()
    const store = new GeminiQuotaStore(storage, () => 1_000)

    const diagnostic = await store.getDiagnosticState()

    expect(diagnostic.snapshot.isPresent).toBe(false)
    expect(diagnostic.snapshot.version).toBeNull()
    expect(diagnostic.buckets).toEqual({})
    expect(diagnostic.runtimeRollback).toBe(false)
    expect(Object.keys(storage.local)).toHaveLength(0)
    expect(Object.keys(storage.session)).toHaveLength(0)
  })

  it('reports an active cooldown with the persisted cooldownUntil', async () => {
    const storage = createStorage()
    const store = new GeminiQuotaStore(storage, () => 1_000)
    await store.reserve({ ...profile, requestsPerDay: 100, requestsPerMinute: 100 }, 1)
    await store.openCooldown(5_000)

    const diagnostic = await store.getDiagnosticState()
    const result = collectQuotaHealthResults(diagnostic)[0]!

    expect(result.status).toBe('cooldown')
    expect(result.denialReason).toBe('cooldown')
    expect(result.cooldownUntil).toBe(6_000)
    expect(result.providerDay).toBe(getGeminiProviderDayId(1_000))
  })

  it('reports clock_rollback when the raw wall clock falls behind the high-water mark', async () => {
    const storage = createStorage()
    const clock = new MutableClock(10_000, 1_000)
    const store = new GeminiQuotaStore(storage, clock)
    await store.reserve({ ...profile, requestsPerDay: 100, requestsPerMinute: 100 }, 1)

    clock.wall = 9_000
    const diagnostic = await store.getDiagnosticState()

    expect(diagnostic.runtimeRollback).toBe(true)
    const result = collectQuotaHealthResults(diagnostic)[0]!
    expect(result.status).toBe('clock_rollback')
    expect(result.denialReason).toBe('clock_rollback')
    expect(result.recoveryAt).toBe(10_000)
  })

  it('reports untrusted_migration for a version-three snapshot without a safe high-water mark', async () => {
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

    const diagnostic = await store.getDiagnosticState()

    expect(diagnostic.snapshot.version).toBe(3)
    expect(diagnostic.snapshot.hasSafeHighWaterMark).toBe(false)
    expect(diagnostic.snapshot.clockTrusted).toBe(false)
    const result = collectQuotaHealthResults(diagnostic)[0]!
    expect(result.status).toBe('untrusted_migration')
    expect(result.snapshotStatus).toBe('untrusted_migration')
    expect(result.recoveryAt).toBeUndefined()
  })

  it('reports malformed_snapshot for conservatively imputed malformed usage', async () => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 12)
    storage.local.quotaVersion = 3
    storage.local.wallHighWaterMark = now
    storage.local.clockTrusted = true
    storage.local.buckets = {
      default: {
        reservations: [],
        cooldownUntil: 0,
        providerDay: getGeminiProviderDayId(now),
        requestsToday: 'corrupt',
      },
    }
    const store = new GeminiQuotaStore(storage, () => now)

    await store.reserve({ ...profile, requestsPerDay: 100, requestsPerMinute: 100, inputTokensPerMinute: 100_000 }, 1)
    const diagnostic = await store.getDiagnosticState()

    expect(diagnostic.snapshot.hasUnsafeDailyCount).toBe(true)
    const result = collectQuotaHealthResults(diagnostic)[0]!
    expect(result.status).toBe('malformed_snapshot')
    expect(result.snapshotStatus).toBe('complete')
  })

  it('reports unsupported_version for a future snapshot version', async () => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 12)
    storage.local.quotaVersion = 99
    storage.local.buckets = {
      default: {
        reservations: [],
        cooldownUntil: 0,
        providerDay: getGeminiProviderDayId(now),
        requestsToday: 2,
      },
    }
    const store = new GeminiQuotaStore(storage, () => now)

    const diagnostic = await store.getDiagnosticState()

    expect(diagnostic.snapshot.version).toBe(99)
    const result = collectQuotaHealthResults(diagnostic)[0]!
    expect(result.status).toBe('unsupported_version')
    expect(result.snapshotStatus).toBe('unsupported_version')
  })

  it('reading diagnostics never mutates persisted state', async () => {
    const storage = createStorage()
    const clock = new MutableClock(10_000, 1_000)
    const store = new GeminiQuotaStore(storage, clock)
    await store.reserve({ ...profile, requestsPerDay: 100, requestsPerMinute: 100 }, 1)
    await store.openCooldown(5_000)

    const localBefore = JSON.stringify(storage.local)
    const sessionBefore = JSON.stringify(storage.session)

    await store.getDiagnosticState()
    await store.getDiagnosticState()

    expect(JSON.stringify(storage.local)).toBe(localBefore)
    expect(JSON.stringify(storage.session)).toBe(sessionBefore)
  })

  it('keeps separate per-model buckets ordered by persisted insertion', async () => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 12)
    const store = new GeminiQuotaStore(storage, () => now)
    await store.reserve(profile, 1, 'gemini-2.5-flash')
    await store.reserve(profile, 1, 'gemini-2.5-pro')

    const diagnostic = await store.getDiagnosticState()
    const results = collectQuotaHealthResults(diagnostic)

    expect(results.map((entry) => entry.quotaKey)).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
    expect(results.every((entry) => entry.status === 'healthy')).toBe(true)
  })

  it('classifies a version-less legacy blob as complete and healthy', async () => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 1)
    Object.assign(storage.local, { providerDay: '2026-07-13', requestsToday: 2 })
    Object.assign(storage.session, {
      reservations: [{ id: 'legacy-request', at: now, inputTokens: 7 }],
      cooldownUntil: 0,
    })
    const store = new GeminiQuotaStore(storage, () => now)

    const diagnostic = await store.getDiagnosticState()

    expect(diagnostic.snapshot.isPresent).toBe(true)
    expect(diagnostic.snapshot.version).toBeNull()
    expect(diagnostic.snapshot.clockTrusted).toBe(true)
    const result = collectQuotaHealthResults(diagnostic)[0]!
    expect(result.snapshotStatus).toBe('complete')
    expect(result.status).toBe('healthy')
    expect(Object.keys(storage.local)).toContain('providerDay')
    expect(Object.keys(storage.session)).toContain('reservations')
  })
})
