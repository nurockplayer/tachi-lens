import { getGeminiProviderDayId, QUOTA_STORAGE_VERSION } from './gemini-quota'
import type {
  QuotaBucketDiagnosticState,
  QuotaDiagnosticState,
  QuotaSnapshotDiagnosticState,
} from './gemini-quota'
import type { QuotaHealthResult, QuotaHealthStatus, QuotaSnapshotStatus } from '@/shared/messages'

/**
 * Read-only diagnostic derivation of persisted Gemini quota health.
 *
 * This module must never mutate, normalize, or repair persisted quota state.
 * It only classifies the state already loaded by GeminiQuotaStore and derives
 * timing fields that can be computed safely from trusted clocks.
 */

const SUPPORTED_LEGACY_VERSIONS: ReadonlySet<number> = new Set([1, 2])

/**
 * Classifies the global snapshot integrity. Per-key data (malformed buckets,
 * cooldown, rollback) is handled per bucket in deriveQuotaHealth.
 */
const classifySnapshot = (snapshot: QuotaSnapshotDiagnosticState): QuotaSnapshotStatus => {
  if (!snapshot.isPresent) return 'missing'
  if (snapshot.version === QUOTA_STORAGE_VERSION) {
    return snapshot.hasSafeHighWaterMark && snapshot.clockTrusted
      ? 'complete'
      : 'untrusted_migration'
  }
  if (snapshot.version !== null && SUPPORTED_LEGACY_VERSIONS.has(snapshot.version)) {
    // Supported legacy formats (v1/v2). A v2 snapshot without a derivable
    // high-water mark is migrated fail-closed; v1 trusts its local day.
    return snapshot.clockTrusted ? 'complete' : 'untrusted_migration'
  }
  // A numeric version the store cannot read.
  if (snapshot.version !== null) return 'unsupported_version'
  // Version-less legacy blob (trusted) or an unreadable version value that the
  // store load treated as unknown (fail-closed). Both surface as integrity
  // states driven by the load path's clock trust.
  return snapshot.clockTrusted ? 'complete' : 'untrusted_migration'
}

const isProviderDayFuture = (day: string, providerDayNow: string): boolean => day > providerDayNow

const isRollbackActive = (options: {
  bucket: QuotaBucketDiagnosticState
  wallNow: number
  highWaterMark: number
}): boolean => {
  const { bucket, wallNow, highWaterMark } = options
  const providerDayNow = getGeminiProviderDayId(wallNow)
  return wallNow < highWaterMark || isProviderDayFuture(bucket.providerDay, providerDayNow)
}

/**
 * Finds the Pacific-midnight instant of the target provider day that is on or
 * after the reference wall time, via binary search on the same day formatter
 * the store uses. Returns undefined when the target is not a valid day or no
 * instant can be located.
 */
const getProviderDayStartAtOrAfter = (wallNow: number, targetDay: string): number | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(targetDay)
  if (!match) return undefined
  const targetUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const currentDay = getGeminiProviderDayId(wallNow)
  const currentMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(currentDay)
  if (!currentMatch) return undefined
  const currentUtc = Date.UTC(Number(currentMatch[1]), Number(currentMatch[2]) - 1, Number(currentMatch[3]))
  // LA midnight is always within ~26h before the target date's UTC midnight, so
  // a two-day pad guarantees the initial upper bound is on or after it.
  let after = wallNow + (targetUtc - currentUtc) + 2 * 86_400_000
  if (!Number.isFinite(after) || getGeminiProviderDayId(after) < targetDay) return undefined
  let before = wallNow
  while (after - before > 1) {
    const mid = before + Math.floor((after - before) / 2)
    if (getGeminiProviderDayId(mid) < targetDay) before = mid
    else after = mid
  }
  return after
}

/**
 * Computes the next automatic recovery instant for an active rollback:
 * - raw wall below the persisted high-water mark: recovery when the clock
 *   catches back up to the high-water mark.
 * - persisted provider day in the future: recovery at that day's Pacific
 *   midnight (the store only resets the day forward).
 * Returns the later of the applicable instants, or undefined when no
 * trustworthy recovery instant can be computed.
 */
const computeRollbackRecoveryAt = (options: {
  bucket: QuotaBucketDiagnosticState
  wallNow: number
  highWaterMark: number
}): number | undefined => {
  const { bucket, wallNow, highWaterMark } = options
  const providerDayNow = getGeminiProviderDayId(wallNow)
  const dayRecovery = isProviderDayFuture(bucket.providerDay, providerDayNow)
    ? getProviderDayStartAtOrAfter(wallNow, bucket.providerDay)
    : undefined
  const highWaterRecovery = wallNow < highWaterMark ? highWaterMark : undefined

  const candidates = [dayRecovery, highWaterRecovery].filter(
    (value): value is number => value !== undefined && value > wallNow,
  )
  if (candidates.length === 0) return undefined
  return Math.max(...candidates)
}

/**
 * Derives the quota-health diagnostic for one quotaKey/model.
 *
 * When bucket is undefined the bucket could not be materialized from persisted
 * state and a conservative fail-closed view is reported without mutating state.
 *
 * Cooldown classification uses the same monotonic cooldown state that
 * GeminiQuotaStore.reserve() checks (`monotonicCooldownUntil > monotonicNow`),
 * so a forward wall-clock jump that would still deny a reservation is reported
 * as cooldown instead of healthy. Once the monotonic deadline elapses the
 * store clears the cooldown and reserve() admits again, so the diagnostics
 * never report cooldown based on the wall-clock field alone.
 */
export const deriveQuotaHealth = (options: {
  quotaKey: string
  bucket: QuotaBucketDiagnosticState | undefined
  snapshot: QuotaSnapshotDiagnosticState
  wallNow: number
  highWaterMark: number
  /**
   * Monotonic clock reading from the store. Required whenever a bucket is
   * provided (the store always has one); the fallback deriveQuotaHealth call
   * without a bucket does not need it.
   */
  monotonicNow?: number
}): QuotaHealthResult => {
  const { quotaKey, bucket, snapshot, wallNow, highWaterMark, monotonicNow } = options
  const snapshotStatus = classifySnapshot(snapshot)

  let status: QuotaHealthStatus
  let denialReason: QuotaHealthResult['denialReason']
  let providerDay: string | undefined
  let cooldownUntil: number | undefined
  let recoveryAt: number | undefined

  if (bucket) {
    if (monotonicNow === undefined) {
      throw new Error('monotonicNow is required when a quota bucket is provided')
    }
    // providerDay is only exposed when the snapshot is complete and the day is
    // a verbatim trusted persisted value. untrusted_migration and
    // unsupported_version never carry a trustworthy provider day, and a
    // substituted/normalized day is never exposed as persisted data.
    if (snapshotStatus === 'complete' && bucket.providerDayTrusted) {
      providerDay = bucket.providerDay
    }
    if (snapshotStatus === 'complete') {
      if (isRollbackActive({ bucket, wallNow, highWaterMark })) {
        status = 'clock_rollback'
        denialReason = 'clock_rollback'
        recoveryAt = computeRollbackRecoveryAt({ bucket, wallNow, highWaterMark })
      } else if (
        bucket.hasConservativelyImputedRollingState ||
        bucket.hasConservativelyImputedDailyState ||
        bucket.hasUnsafeRollingCount ||
        bucket.hasInvalidProviderDay
      ) {
        // Integrity problems outrank a temporary cooldown. An invalid persisted
        // provider day is provenance corruption, so it is never normalized into
        // a healthy state.
        status = 'malformed_snapshot'
      } else if (
        bucket.monotonicCooldownUntil > monotonicNow
      ) {
        // Same cooldown source reserve() checks. This stays active across a
        // forward wall-clock jump, matching the store's monotonic deadline.
        status = 'cooldown'
        denialReason = 'cooldown'
        if (snapshot.clockTrusted && bucket.cooldownUntil > wallNow) {
          cooldownUntil = bucket.cooldownUntil
        }
      } else {
        status = 'healthy'
      }
    } else if (snapshotStatus === 'untrusted_migration') {
      // Fail-closed by design; the store does not automatically recover.
      status = 'untrusted_migration'
    } else if (snapshotStatus === 'unsupported_version') {
      status = 'unsupported_version'
    } else {
      status = 'healthy'
    }
  } else {
    // The bucket could not be materialized. Missing state implies a fresh
    // install (healthy); integrity failures surface their distinct reasons.
    switch (snapshotStatus) {
      case 'untrusted_migration':
        status = 'untrusted_migration'
        break
      case 'unsupported_version':
        status = 'unsupported_version'
        break
      default:
        status = 'healthy'
    }
  }

  return {
    quotaKey,
    status,
    ...(denialReason ? { denialReason } : {}),
    ...(providerDay ? { providerDay } : {}),
    snapshotVersion: snapshot.version,
    snapshotStatus,
    ...(recoveryAt !== undefined ? { recoveryAt } : {}),
    ...(cooldownUntil !== undefined ? { cooldownUntil } : {}),
  }
}

/**
 * Builds the ordered list of quota-health results from the store diagnostic
 * state. Persisted bucket order is preserved; the ambiguous legacy baseline is
 * reported once. Never mutates state and never invents storage that does not
 * exist.
 */
export const collectQuotaHealthResults = (diagnostic: QuotaDiagnosticState): QuotaHealthResult[] => {
  const results: QuotaHealthResult[] = []

  const orderedKeys = Object.keys(diagnostic.bucketIndex).sort(
    (left, right) => diagnostic.bucketIndex[left]! - diagnostic.bucketIndex[right]!,
  )

  for (const key of orderedKeys) {
    const bucket = diagnostic.buckets[key]
    results.push(deriveQuotaHealth({
      quotaKey: key,
      bucket,
      snapshot: diagnostic.snapshot,
      wallNow: diagnostic.wallNow,
      highWaterMark: diagnostic.highWaterMark,
      monotonicNow: diagnostic.monotonicNow,
    }))
  }

  if (diagnostic.legacyBaseline && orderedKeys.length === 0) {
    results.push(deriveQuotaHealth({
      quotaKey: 'legacy',
      bucket: diagnostic.legacyBaseline,
      snapshot: diagnostic.snapshot,
      wallNow: diagnostic.wallNow,
      highWaterMark: diagnostic.highWaterMark,
      monotonicNow: diagnostic.monotonicNow,
    }))
  }

  if (results.length === 0) {
    results.push(deriveQuotaHealth({
      quotaKey: 'default',
      bucket: undefined,
      snapshot: diagnostic.snapshot,
      wallNow: diagnostic.wallNow,
      highWaterMark: diagnostic.highWaterMark,
      monotonicNow: diagnostic.monotonicNow,
    }))
  }

  return results
}
