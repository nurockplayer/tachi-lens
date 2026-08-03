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

const completeBucket = (overrides: Partial<Parameters<typeof deriveQuotaHealth>[0]['bucket']> = {}) => ({
  providerDay: getGeminiProviderDayId(1_000),
  providerDayTrusted: true,
  hasInvalidProviderDay: false,
  requestsToday: 1,
  cooldownUntil: 0,
  monotonicCooldownUntil: 0,
  hasConservativelyImputedRollingState: false,
  hasConservativelyImputedDailyState: false,
  hasUnsafeRollingCount: false,
  ...overrides,
})

describe('deriveQuotaHealth', () => {
  it('maps a healthy bucket to the healthy status', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'gemini-2.5-flash',
      bucket: completeBucket(),
      snapshot: completeSnapshot(),
      wallNow: 1_000,
      highWaterMark: 1_000,
      monotonicNow: 1_000,
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
      bucket: completeBucket({
        cooldownUntil: 6_000,
        monotonicCooldownUntil: 5_000,
      }),
      snapshot: completeSnapshot(),
      wallNow: 1_000,
      highWaterMark: 1_000,
      monotonicNow: 1_000,
    })

    expect(result.status).toBe('cooldown')
    expect(result.denialReason).toBe('cooldown')
    expect(result.cooldownUntil).toBe(6_000)
    expect(result.recoveryAt).toBeUndefined()
  })

  it('maps a wall clock behind the high-water mark to clock_rollback with a recovery time', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: completeBucket({ providerDay: getGeminiProviderDayId(2_000) }),
      snapshot: completeSnapshot(),
      wallNow: 1_500,
      highWaterMark: 2_000,
      monotonicNow: 1_000,
    })

    expect(result.status).toBe('clock_rollback')
    expect(result.denialReason).toBe('clock_rollback')
    expect(result.recoveryAt).toBe(2_000)
  })

  it('maps a persisted provider day in the future to clock_rollback with the next day boundary', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: completeBucket({ providerDay: '2099-01-01' }),
      snapshot: completeSnapshot(),
      wallNow: 1_000,
      highWaterMark: 1_000,
      monotonicNow: 1_000,
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
      bucket: completeBucket({
        providerDay: getGeminiProviderDayId(1_000),
        requestsToday: Number.MAX_SAFE_INTEGER,
        hasConservativelyImputedRollingState: true,
        hasConservativelyImputedDailyState: true,
      }),
      snapshot: completeSnapshot({ clockTrusted: false }),
      wallNow: 1_000,
      highWaterMark: 1_000,
      monotonicNow: 1_000,
    })

    expect(result.status).toBe('untrusted_migration')
    expect(result.snapshotStatus).toBe('untrusted_migration')
    expect(result.recoveryAt).toBeUndefined()
    expect(result.cooldownUntil).toBeUndefined()
  })

  it('maps a conservatively imputed daily count to malformed_snapshot', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: completeBucket({
        requestsToday: Number.MAX_SAFE_INTEGER,
        hasConservativelyImputedDailyState: true,
      }),
      snapshot: completeSnapshot(),
      wallNow: 1_000,
      highWaterMark: 1_000,
      monotonicNow: 1_000,
    })

    expect(result.status).toBe('malformed_snapshot')
    expect(result.snapshotStatus).toBe('complete')
    expect(result.denialReason).toBeUndefined()
  })

  it('maps a conservatively imputed rolling token count to malformed_snapshot', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: completeBucket({ hasConservativelyImputedRollingState: true }),
      snapshot: completeSnapshot(),
      wallNow: 1_000,
      highWaterMark: 1_000,
      monotonicNow: 1_000,
    })

    expect(result.status).toBe('malformed_snapshot')
  })

  it('maps an unsupported future snapshot version to unsupported_version', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: completeBucket(),
      snapshot: completeSnapshot({ version: 4, clockTrusted: false }),
      wallNow: 1_000,
      highWaterMark: 1_000,
      monotonicNow: 1_000,
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

  it('keeps reporting cooldown when the monotonic deadline is active even after a forward wall-clock jump', () => {
    // The persisted wall-clock cooldown deadline (6_000) has already passed at
    // wallNow 16_000, but the monotonic cooldown deadline reserve() checks
    // (5_000) is still ahead of the monotonic clock (1_000). reserve() would
    // still deny with cooldown, so the diagnostics must not report healthy.
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: completeBucket({
        providerDay: getGeminiProviderDayId(16_000),
        cooldownUntil: 6_000,
        monotonicCooldownUntil: 5_000,
      }),
      snapshot: completeSnapshot(),
      wallNow: 16_000,
      highWaterMark: 16_000,
      monotonicNow: 1_000,
    })

    expect(result.status).toBe('cooldown')
    expect(result.denialReason).toBe('cooldown')
    // The wall-clock recovery field is not reported: it is no longer ahead of
    // the (jumped) wall clock, so it is not a trustworthy recovery instant.
    expect(result.cooldownUntil).toBeUndefined()
    expect(result.recoveryAt).toBeUndefined()
  })

  it('reports healthy when both the monotonic and wall-clock cooldowns have elapsed', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: completeBucket({
        providerDay: getGeminiProviderDayId(16_000),
        cooldownUntil: 6_000,
        monotonicCooldownUntil: 4_000,
      }),
      snapshot: completeSnapshot(),
      wallNow: 16_000,
      highWaterMark: 16_000,
      monotonicNow: 5_000,
    })

    expect(result.status).toBe('healthy')
    expect(result.cooldownUntil).toBeUndefined()
  })

  it('reports healthy once the monotonic cooldown deadline has elapsed even when the wall-clock deadline is still ahead', () => {
    // The monotonic cooldown reserve() checks has elapsed. The store clears the
    // cooldown and admits reservations, so the wall-clock-only deadline is not
    // an authoritative denial and must not be reported as an active cooldown.
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: completeBucket({
        providerDay: getGeminiProviderDayId(4_000),
        cooldownUntil: 10_000,
        monotonicCooldownUntil: 4_000,
      }),
      snapshot: completeSnapshot(),
      wallNow: 4_000,
      highWaterMark: 4_000,
      monotonicNow: 5_000,
    })

    expect(result.status).toBe('healthy')
    expect(result.denialReason).toBeUndefined()
    expect(result.cooldownUntil).toBeUndefined()
  })

  it('omits providerDay for an untrusted-migration snapshot', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: completeBucket(),
      snapshot: completeSnapshot({ clockTrusted: false }),
      wallNow: 1_000,
      highWaterMark: 1_000,
      monotonicNow: 1_000,
    })

    expect(result.status).toBe('untrusted_migration')
    expect(result.providerDay).toBeUndefined()
  })

  it('omits providerDay for an unsupported snapshot version', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: completeBucket(),
      snapshot: completeSnapshot({ version: 4, clockTrusted: false }),
      wallNow: 1_000,
      highWaterMark: 1_000,
      monotonicNow: 1_000,
    })

    expect(result.status).toBe('unsupported_version')
    expect(result.providerDay).toBeUndefined()
  })

  it('omits providerDay when the persisted provider day was substituted', () => {
    const result = deriveQuotaHealth({
      quotaKey: 'default',
      bucket: completeBucket({ providerDayTrusted: false }),
      snapshot: completeSnapshot(),
      wallNow: 1_000,
      highWaterMark: 1_000,
      monotonicNow: 1_000,
    })

    expect(result.status).toBe('healthy')
    expect(result.providerDay).toBeUndefined()
  })

  it('throws when a bucket is provided without a monotonic clock reading', () => {
    expect(() => deriveQuotaHealth({
      quotaKey: 'default',
      bucket: completeBucket(),
      snapshot: completeSnapshot(),
      wallNow: 1_000,
      highWaterMark: 1_000,
    })).toThrow(/monotonicNow is required/)
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
  })

  it('stops reporting cooldown and admits reservations once the monotonic deadline elapses even while the wall deadline is still ahead', async () => {
    const storage = createStorage()
    const clock = new MutableClock(10_000, 1_000)
    const store = new GeminiQuotaStore(storage, clock)
    const permissive = { ...profile, requestsPerDay: 100, requestsPerMinute: 100, inputTokensPerMinute: 100_000 }
    await store.reserve(permissive, 1)
    await store.openCooldown(5_000)

    // The monotonic cooldown deadline is 6_000. The persisted wall-clock
    // deadline is 15_000 and stays ahead of wallNow 10_000, but reserve() only
    // checks the monotonic deadline.
    expect((await store.reserve(permissive, 1)).reason).toBe('cooldown')

    clock.monotonic = 6_001
    clock.wall += 1

    const diagnostic = await store.getDiagnosticState()
    const result = collectQuotaHealthResults(diagnostic)[0]!
    expect(result.status).toBe('healthy')
    expect(result.cooldownUntil).toBeUndefined()

    // reserve() must not deny on the stale wall-clock deadline alone.
    await expect(store.reserve(permissive, 1)).resolves.toMatchObject({ accepted: true })
    // The stored wall deadline is still ahead even though the store no longer
    // treats the cooldown as active.
    expect(diagnostic.buckets.default!.cooldownUntil).toBeGreaterThan(10_000)
  })

  it('keeps reporting cooldown after a forward wall-clock jump while the monotonic cooldown is still active', async () => {
    const storage = createStorage()
    const clock = new MutableClock(10_000, 1_000)
    const store = new GeminiQuotaStore(storage, clock)
    await store.reserve({ ...profile, requestsPerDay: 100, requestsPerMinute: 100 }, 1)
    await store.openCooldown(5_000)

    // Forward wall-clock jump of 90 seconds. The persisted wall-clock cooldown
    // deadline (15_000) is now in the past, but the store's monotonic cooldown
    // deadline (6_000) is still ahead of the monotonic clock (1_000).
    clock.wall = 100_000
    const diagnostic = await store.getDiagnosticState()
    const result = collectQuotaHealthResults(diagnostic)[0]!

    expect(result.status).toBe('cooldown')
    expect(result.denialReason).toBe('cooldown')
    // The wall-clock deadline is no longer ahead of the jumped clock, so the
    // recovery field is not a trustworthy future instant.
    expect(result.cooldownUntil).toBeUndefined()
    expect(result.recoveryAt).toBeUndefined()

    // reserve() still denies with cooldown: diagnostics agree with the store.
    await expect(store.reserve(profile, 1)).resolves.toMatchObject({
      accepted: false,
      reason: 'cooldown',
    })
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

  it('reports malformed_snapshot for a canonical bucket with an invalid persisted provider day and keeps accounting fail-closed', async () => {
    const storage = createStorage()
    const now = Date.UTC(2026, 6, 13, 12)
    const persisted = {
      quotaVersion: 3,
      wallHighWaterMark: now,
      clockTrusted: true,
      buckets: {
        default: {
          reservations: [],
          cooldownUntil: 0,
          // An otherwise valid canonical bucket whose persisted provider day
          // string is impossible. The loader must substitute a day to keep
          // operating fail-closed, but the provenance must not be exposed.
          providerDay: '2026-02-30',
          requestsToday: 200,
        },
      },
    }
    Object.assign(storage.local, persisted)
    const localBefore = JSON.stringify(storage.local)
    const store = new GeminiQuotaStore(storage, () => now)
    const permissive = { ...profile, requestsPerDay: 100, requestsPerMinute: 100, inputTokensPerMinute: 100_000 }

    const diagnostic = await store.getDiagnosticState()
    const result = collectQuotaHealthResults(diagnostic)[0]!

    expect(diagnostic.snapshot.hasSafeHighWaterMark).toBe(true)
    expect(diagnostic.snapshot.clockTrusted).toBe(true)
    expect(result.status).toBe('malformed_snapshot')
    expect(result.providerDay).toBeUndefined()

    // Diagnostics must not repair or normalize persisted storage.
    expect(JSON.stringify(storage.local)).toBe(localBefore)

    // Quota accounting stays fail-closed: the persisted daily count is
    // retained (not zeroed by the invalid provider-day provenance), so a
    // reservation is denied on the daily limit.
    await expect(store.reserve(permissive, 1)).resolves.toMatchObject({ accepted: false, reason: 'rpd' })
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

  it('does not claim a persisted v3 snapshot when the local write fails', async () => {
    const storage = createStorage()
    let failLocalWrite = true
    const originalSetLocal = storage.setLocal.bind(storage)
    storage.setLocal = async (value) => {
      if (failLocalWrite) throw new Error('local write failed')
      await originalSetLocal(value)
    }
    const store = new GeminiQuotaStore(storage, () => 10_000)

    // A reservation mutation triggers persist(), whose local write throws.
    await expect(store.reserve(profile, 1)).rejects.toThrow('local write failed')

    // The persist metadata must not claim a successful persisted v3 snapshot.
    const diagnostic = await store.getDiagnosticState()
    expect(diagnostic.snapshot.isPresent).toBe(false)
    expect(diagnostic.snapshot.version).toBeNull()
    expect(diagnostic.snapshot.hasSafeHighWaterMark).toBe(true)

    // A later successful write commits the snapshot and flips the metadata.
    failLocalWrite = false
    await store.reserve(profile, 1)
    const after = await store.getDiagnosticState()
    expect(after.snapshot.isPresent).toBe(true)
    expect(after.snapshot.version).toBe(3)
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
