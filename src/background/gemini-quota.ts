import { createSystemClock, type Clock } from './clock'

export interface GeminiQuotaSettings {
  requestsPerMinute: number
  inputTokensPerMinute: number
  requestsPerDay: number
  rpmSafetyPercent: number
  tpmSafetyPercent: number
  rpdSafetyPercent: number
  liveMaxWaitMs: number
  maxConcurrency: number
}

export const DEFAULT_GEMINI_QUOTA: GeminiQuotaSettings = {
  requestsPerMinute: 5,
  inputTokensPerMinute: 100_000,
  requestsPerDay: 100,
  rpmSafetyPercent: 80,
  tpmSafetyPercent: 80,
  rpdSafetyPercent: 95,
  liveMaxWaitMs: 1_000,
  maxConcurrency: 1,
}

export type GeminiQuotaDenial = 'rpm' | 'tpm' | 'rpd' | 'cooldown' | 'clock_rollback'

export interface GeminiQuotaReservation {
  accepted: boolean
  reason?: GeminiQuotaDenial
  nextAvailableAt?: number
  reservationId?: string
}

export interface GeminiQuotaUsage {
  rollingRequests: number
  rollingInputTokens: number
  requestsToday: number
  cooldownUntil: number
  clockRollback: boolean
}

export interface QuotaStorage {
  getSession: () => Promise<Record<string, unknown>>
  setSession: (value: Record<string, unknown>) => Promise<void>
  getLocal: () => Promise<Record<string, unknown>>
  setLocal: (value: Record<string, unknown>) => Promise<void>
}

export interface InputTokenEstimator {
  estimate(prompt: { system: string; user: string }): number
}

export type ReservationIdFactory = () => string

export const createRestartSafeReservationId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  throw new Error('Secure random reservation IDs are unavailable')
}

interface Reservation {
  id: string
  at: number
  inputTokens: number
  monotonicExpiresAt: number
}

interface SessionState {
  reservations: Reservation[]
  cooldownUntil: number
  monotonicCooldownUntil: number
}

interface LocalState {
  providerDay: string
  requestsToday: number
}

interface QuotaBucketState extends SessionState, LocalState {}

const ROLLING_WINDOW_MS = 60_000
const PROVIDER_TIME_ZONE = 'America/Los_Angeles'
const MAX_PROVIDER_DAY_MS = 36 * 3_600_000
const QUOTA_STORAGE_VERSION = 3
const DEFAULT_QUOTA_BUCKET = 'default'

const providerDayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PROVIDER_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toNonNegativeInteger = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

const positiveInteger = (value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(maximum, Math.max(1, Math.floor(value)))
    : fallback

const positivePercent = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(100, value)
    : fallback

export const normalizeGeminiQuotaSettings = (value: unknown): GeminiQuotaSettings => {
  const candidate = isRecord(value) ? value : {}

  return {
    requestsPerMinute: positiveInteger(candidate.requestsPerMinute, DEFAULT_GEMINI_QUOTA.requestsPerMinute),
    inputTokensPerMinute: positiveInteger(candidate.inputTokensPerMinute, DEFAULT_GEMINI_QUOTA.inputTokensPerMinute),
    requestsPerDay: positiveInteger(candidate.requestsPerDay, DEFAULT_GEMINI_QUOTA.requestsPerDay),
    rpmSafetyPercent: positivePercent(candidate.rpmSafetyPercent, DEFAULT_GEMINI_QUOTA.rpmSafetyPercent),
    tpmSafetyPercent: positivePercent(candidate.tpmSafetyPercent, DEFAULT_GEMINI_QUOTA.tpmSafetyPercent),
    rpdSafetyPercent: positivePercent(candidate.rpdSafetyPercent, DEFAULT_GEMINI_QUOTA.rpdSafetyPercent),
    liveMaxWaitMs: positiveInteger(candidate.liveMaxWaitMs, DEFAULT_GEMINI_QUOTA.liveMaxWaitMs, 60_000),
    maxConcurrency: positiveInteger(candidate.maxConcurrency, DEFAULT_GEMINI_QUOTA.maxConcurrency, 10),
  }
}

const conservativeReservation = (wallNow: number, monotonicNow: number, index: number): Reservation => ({
  id: `malformed:${wallNow}:${index}`,
  at: wallNow,
  inputTokens: Number.MAX_SAFE_INTEGER,
  monotonicExpiresAt: monotonicNow + ROLLING_WINDOW_MS,
})

const toReservations = (
  value: unknown,
  trustedWallNow: number,
  monotonicNow: number,
): Reservation[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) return [conservativeReservation(trustedWallNow, monotonicNow, 0)]

  return value.flatMap((entry, index) => {
    if (!isRecord(entry)) return [conservativeReservation(trustedWallNow, monotonicNow, index)]
    const at = typeof entry.at === 'number' && Number.isFinite(entry.at) && entry.at > 0
      ? Math.floor(entry.at)
      : trustedWallNow
    const inputTokens = typeof entry.inputTokens === 'number' &&
      Number.isFinite(entry.inputTokens) && entry.inputTokens >= 0
      ? Math.floor(entry.inputTokens)
      : Number.MAX_SAFE_INTEGER
    const id = typeof entry.id === 'string' && entry.id ? entry.id : `legacy:${at}:${index}`
    const remainingMs = Math.max(0, at + ROLLING_WINDOW_MS - trustedWallNow)
    return [{ id, at, inputTokens, monotonicExpiresAt: monotonicNow + remainingMs }]
  })
}

const isStoredCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const getCompleteVersionTwoHighWater = (value: Record<string, unknown>): number | undefined => {
  if (!isRecord(value.buckets)) return undefined

  const candidates: number[] = []
  const validateBucket = (bucketValue: unknown): boolean => {
    if (!isRecord(bucketValue) ||
      !Array.isArray(bucketValue.reservations) ||
      !isStoredCount(bucketValue.cooldownUntil) ||
      !isProviderDay(bucketValue.providerDay) ||
      !isStoredCount(bucketValue.requestsToday)) return false

    for (const reservation of bucketValue.reservations) {
      if (!isRecord(reservation) ||
        typeof reservation.id !== 'string' || !reservation.id ||
        typeof reservation.at !== 'number' || !Number.isFinite(reservation.at) || reservation.at <= 0 ||
        !isStoredCount(reservation.inputTokens)) return false
      candidates.push(Math.floor(reservation.at))
    }
    return true
  }

  const bucketValues = Object.values(value.buckets)
  if (bucketValues.length === 0 || !bucketValues.every(validateBucket)) return undefined
  if (value.legacyBaseline !== undefined && !validateBucket(value.legacyBaseline)) return undefined
  return candidates.length > 0 ? Math.max(...candidates) : undefined
}

const isProviderDay = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= daysInMonth[month - 1]!
}

const safeLimit = (configured: number, safetyPercent: number, minimumOne = false): number => {
  if (!Number.isFinite(configured) || configured <= 0) return 0
  const percent = Number.isFinite(safetyPercent) ? Math.min(100, Math.max(0, safetyPercent)) : 0
  const safe = Math.floor(configured * percent / 100)
  return minimumOne ? Math.max(1, safe) : safe
}

export const getGeminiProviderDayId = (now: number): string => {
  const parts = providerDayFormatter.formatToParts(new Date(now))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export const getNextGeminiProviderDayStart = (now: number): number => {
  const currentDay = getGeminiProviderDayId(now)
  let before = Math.floor(now)
  let after = before + MAX_PROVIDER_DAY_MS

  while (after - before > 1) {
    const candidate = before + Math.floor((after - before) / 2)
    if (getGeminiProviderDayId(candidate) === currentDay) before = candidate
    else after = candidate
  }

  return after
}

export class CharacterTokenEstimator implements InputTokenEstimator {
  estimate(prompt: { system: string; user: string }): number {
    return Math.ceil(Math.ceil((prompt.system.length + prompt.user.length) / 3) * 1.2)
  }
}

/**
 * Persists the state needed to make Gemini quota checks survive MV3 worker
 * suspension. Mutations are serialized so concurrent scheduler callers cannot
 * reserve the same capacity.
 */
export class GeminiQuotaStore {
  private buckets: Map<string, QuotaBucketState> | undefined
  private legacyBaseline: QuotaBucketState | undefined
  private wallHighWaterMark: number | undefined
  private clockTrusted = true
  private trustedWallNow: number | undefined
  private lastMonotonicNow: number | undefined
  private mutation = Promise.resolve()
  private clock: Clock

  constructor(
    private storage: QuotaStorage,
    clock: Clock | (() => number) = createSystemClock(),
    private createReservationId: ReservationIdFactory = createRestartSafeReservationId,
  ) {
    this.clock = typeof clock === 'function'
      ? { monotonicNow: clock, wallNow: clock }
      : clock
  }

  async reserve(
    profile: GeminiQuotaSettings,
    inputTokens: number,
    quotaKey = DEFAULT_QUOTA_BUCKET,
  ): Promise<GeminiQuotaReservation> {
    return this.exclusively(async () => {
      await this.load()
      const time = this.observeClock()
      const normalizedProfile = normalizeGeminiQuotaSettings(profile)
      const bucket = this.getBucket(quotaKey, time)

      if (time.rollback) {
        await this.persist()
        return { accepted: false, reason: 'clock_rollback' }
      }

      this.prune(bucket, time.monotonicNow)
      this.resetProviderDay(bucket, time.wallNow)
      this.expireCooldown(bucket, time.monotonicNow)

      if (bucket.monotonicCooldownUntil > time.monotonicNow) {
        await this.persist()
        return { accepted: false, reason: 'cooldown', nextAvailableAt: bucket.monotonicCooldownUntil }
      }

      const rpm = safeLimit(normalizedProfile.requestsPerMinute, normalizedProfile.rpmSafetyPercent, true)
      const tpm = safeLimit(normalizedProfile.inputTokensPerMinute, normalizedProfile.tpmSafetyPercent)
      const rpd = safeLimit(normalizedProfile.requestsPerDay, normalizedProfile.rpdSafetyPercent, true)
      const tokenCost = toNonNegativeInteger(inputTokens)
      const rollingTokens = bucket.reservations.reduce((sum, reservation) => sum + reservation.inputTokens, 0)

      if (bucket.reservations.length + 1 > rpm) {
        await this.persist()
        return {
          accepted: false,
          reason: 'rpm',
          nextAvailableAt: bucket.reservations[0]!.monotonicExpiresAt,
        }
      }

      if (rollingTokens + tokenCost > tpm) {
        await this.persist()
        return { accepted: false, reason: 'tpm', nextAvailableAt: this.nextTokenAvailability(bucket, tokenCost, tpm) }
      }

      if (bucket.requestsToday + 1 > rpd) {
        await this.persist()
        return {
          accepted: false,
          reason: 'rpd',
          nextAvailableAt: undefined,
        }
      }

      const reservationId = this.createReservationId()
      if (
        typeof reservationId !== 'string' ||
        reservationId.length === 0 ||
        this.hasReservationId(reservationId)
      ) {
        throw new Error('Reservation ID factory returned a duplicate or invalid ID')
      }
      bucket.reservations.push({
        id: reservationId,
        at: time.wallNow,
        inputTokens: tokenCost,
        monotonicExpiresAt: time.monotonicNow + ROLLING_WINDOW_MS,
      })
      bucket.requestsToday++
      try {
        await this.persist()
      } catch (error) {
        bucket.reservations = bucket.reservations.filter((reservation) => reservation.id !== reservationId)
        bucket.requestsToday = Math.max(0, bucket.requestsToday - 1)
        throw error
      }
      return { accepted: true, reservationId }
    })
  }

  async release(reservationId: string): Promise<void> {
    await this.exclusively(async () => {
      await this.load()
      const time = this.observeClock()
      if (time.rollback) {
        await this.persist()
        return
      }
      const match = Array.from(this.buckets!.values(), (bucket) => ({
        bucket,
        index: bucket.reservations.findIndex((reservation) => reservation.id === reservationId),
      })).find(({ index }) => index >= 0)
      if (!match) return

      const { bucket, index } = match
      const previous = this.cloneBucket(bucket)
      const [reservation] = bucket.reservations.splice(index, 1)
      this.resetProviderDay(bucket, time.wallNow)
      if (reservation && getGeminiProviderDayId(reservation.at) === bucket.providerDay) {
        bucket.requestsToday = Math.max(0, bucket.requestsToday - 1)
      }
      try {
        await this.persist()
      } catch (error) {
        Object.assign(bucket, previous)
        throw error
      }
    })
  }

  async openCooldown(retryAfterMs: number, quotaKey = DEFAULT_QUOTA_BUCKET): Promise<void> {
    await this.exclusively(async () => {
      await this.load()
      const time = this.observeClock()
      const bucket = this.getBucket(quotaKey, time)
      const normalizedDelay = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? Math.ceil(retryAfterMs)
        : 0
      const cooldownUntil = this.wallHighWaterMark! + normalizedDelay
      bucket.cooldownUntil = Math.max(bucket.cooldownUntil, cooldownUntil)
      bucket.monotonicCooldownUntil = Math.max(
        bucket.monotonicCooldownUntil,
        time.monotonicNow + normalizedDelay,
      )
      await this.persist()
    })
  }

  async getUsage(quotaKey = DEFAULT_QUOTA_BUCKET): Promise<GeminiQuotaUsage> {
    return this.exclusively(async () => {
      await this.load()
      const time = this.observeClock()
      const bucket = this.getBucket(quotaKey, time)
      if (!time.rollback) {
        this.prune(bucket, time.monotonicNow)
        this.resetProviderDay(bucket, time.wallNow)
        this.expireCooldown(bucket, time.monotonicNow)
      }
      await this.persist()
      return {
        rollingRequests: bucket.reservations.length,
        rollingInputTokens: bucket.reservations.reduce((sum, reservation) => sum + reservation.inputTokens, 0),
        requestsToday: bucket.requestsToday,
        cooldownUntil: bucket.cooldownUntil,
        clockRollback: time.rollback,
      }
    })
  }

  private async exclusively<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation
    let release!: () => void
    this.mutation = new Promise<void>((resolve) => { release = resolve })
    await previous

    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async load(): Promise<void> {
    if (this.buckets) return
    const localValue = await this.storage.getLocal()
    const storedLocal = isRecord(localValue) ? localValue : {}
    const wallNow = this.readWallNow()
    const monotonicNow = this.readMonotonicNow()
    const buckets = new Map<string, QuotaBucketState>()
    let legacyBaseline: QuotaBucketState | undefined

    if (storedLocal.quotaVersion === QUOTA_STORAGE_VERSION) {
      const storedHighWater = storedLocal.wallHighWaterMark
      const validHighWater = isStoredCount(storedHighWater)
      this.clockTrusted = validHighWater && storedLocal.clockTrusted === true
      this.wallHighWaterMark = validHighWater ? Math.floor(storedHighWater) : wallNow
      const trustedWallNow = Math.max(wallNow, this.wallHighWaterMark)
      if (isRecord(storedLocal.buckets)) {
        for (const [key, value] of Object.entries(storedLocal.buckets)) {
          buckets.set(key, this.readCanonicalBucket(value, trustedWallNow, monotonicNow))
        }
      } else {
        legacyBaseline = this.conservativeBucket(trustedWallNow, monotonicNow)
      }

      if (storedLocal.legacyBaseline !== undefined) {
        legacyBaseline = this.readCanonicalBucket(storedLocal.legacyBaseline, trustedWallNow, monotonicNow)
      }
      if (!validHighWater) {
        const currentProviderDay = getGeminiProviderDayId(trustedWallNow)
        for (const bucket of buckets.values()) {
          this.makeMigrationFailClosed(bucket, currentProviderDay, trustedWallNow, monotonicNow)
        }
        if (legacyBaseline) {
          this.makeMigrationFailClosed(legacyBaseline, currentProviderDay, trustedWallNow, monotonicNow)
        }
        legacyBaseline = legacyBaseline ?? this.conservativeBucket(trustedWallNow, monotonicNow)
      }
      this.buckets = buckets
      this.legacyBaseline = legacyBaseline
      this.initializeRuntimeClock(wallNow, monotonicNow)
      return
    }

    const sessionValue = await this.storage.getSession()
    const storedSession = isRecord(sessionValue) ? sessionValue : {}
    const hasAnyQuotaState = Object.keys(storedLocal).length > 0 || Object.keys(storedSession).length > 0

    if (!hasAnyQuotaState) {
      this.clockTrusted = true
      this.wallHighWaterMark = wallNow
      this.buckets = buckets
      this.initializeRuntimeClock(wallNow, monotonicNow)
      return
    }

    if (storedLocal.quotaVersion === 2) {
      const derivedHighWater = getCompleteVersionTwoHighWater(storedLocal)
      this.clockTrusted = derivedHighWater !== undefined
      this.wallHighWaterMark = derivedHighWater ?? wallNow
      const trustedWallNow = Math.max(wallNow, this.wallHighWaterMark)
      const currentProviderDay = getGeminiProviderDayId(wallNow)
      if (isRecord(storedLocal.buckets)) {
        for (const [key, value] of Object.entries(storedLocal.buckets)) {
          const bucket = this.readCanonicalBucket(value, trustedWallNow, monotonicNow)
          if (!this.clockTrusted) {
            this.makeMigrationFailClosed(bucket, currentProviderDay, wallNow, monotonicNow)
          }
          buckets.set(key, bucket)
        }
      }
      if (storedLocal.legacyBaseline !== undefined) {
        legacyBaseline = this.readCanonicalBucket(storedLocal.legacyBaseline, trustedWallNow, monotonicNow)
        if (!this.clockTrusted) {
          this.makeMigrationFailClosed(legacyBaseline, currentProviderDay, wallNow, monotonicNow)
        }
      }
      if (!this.clockTrusted) {
        legacyBaseline = legacyBaseline ?? this.conservativeBucket(wallNow, monotonicNow)
      }
    } else if (storedLocal.quotaVersion === 1) {
      this.clockTrusted = true
      this.wallHighWaterMark = wallNow
      legacyBaseline = this.readVersionOneBucket(storedLocal, wallNow, monotonicNow)
    } else if (storedLocal.quotaVersion !== undefined) {
      this.clockTrusted = false
      this.wallHighWaterMark = wallNow
      legacyBaseline = this.conservativeBucket(wallNow, monotonicNow, storedLocal)
    } else {
      this.clockTrusted = true
      this.wallHighWaterMark = wallNow
      legacyBaseline = this.readLegacyBucket(storedLocal, storedSession, wallNow, monotonicNow)
    }

    this.buckets = buckets
    this.legacyBaseline = legacyBaseline
    this.initializeRuntimeClock(wallNow, monotonicNow)
  }

  private readCanonicalBucket(
    value: unknown,
    trustedWallNow: number,
    monotonicNow: number,
  ): QuotaBucketState {
    if (!isRecord(value)) return this.conservativeBucket(trustedWallNow, monotonicNow)
    const currentProviderDay = getGeminiProviderDayId(trustedWallNow)
    const storedRequestsToday = value.requestsToday
    const validRequestsToday = isStoredCount(storedRequestsToday)
    const requestsToday = validRequestsToday
      ? Math.floor(storedRequestsToday)
      : Number.MAX_SAFE_INTEGER
    const validRollingState = Array.isArray(value.reservations) && isStoredCount(value.cooldownUntil)
    const cooldownUntil = toNonNegativeInteger(value.cooldownUntil)
    const remainingCooldown = Math.max(0, cooldownUntil - trustedWallNow)

    return {
      reservations: validRollingState
        ? toReservations(value.reservations, trustedWallNow, monotonicNow)
        : [conservativeReservation(trustedWallNow, monotonicNow, 0)],
      cooldownUntil,
      monotonicCooldownUntil: monotonicNow + remainingCooldown,
      providerDay: validRequestsToday && isProviderDay(value.providerDay)
        ? value.providerDay
        : currentProviderDay,
      requestsToday,
    }
  }

  private readVersionOneBucket(
    value: Record<string, unknown>,
    wallNow: number,
    monotonicNow: number,
  ): QuotaBucketState {
    const currentProviderDay = getGeminiProviderDayId(wallNow)
    const providerDayIsPast = isProviderDay(value.providerDay) && value.providerDay < currentProviderDay
    const storedRequestsToday = value.requestsToday
    const requestsToday = isStoredCount(storedRequestsToday)
      ? Math.floor(storedRequestsToday)
      : Number.MAX_SAFE_INTEGER
    const validRollingState = Array.isArray(value.reservations) && isStoredCount(value.cooldownUntil)
    const cooldownUntil = toNonNegativeInteger(value.cooldownUntil)

    return {
      reservations: validRollingState
        ? toReservations(value.reservations, wallNow, monotonicNow)
        : [conservativeReservation(wallNow, monotonicNow, 0)],
      cooldownUntil,
      monotonicCooldownUntil: monotonicNow + Math.max(0, cooldownUntil - wallNow),
      providerDay: currentProviderDay,
      requestsToday: providerDayIsPast && isStoredCount(storedRequestsToday) ? 0 : requestsToday,
    }
  }

  private readLegacyBucket(
    local: Record<string, unknown>,
    session: Record<string, unknown>,
    wallNow: number,
    monotonicNow: number,
  ): QuotaBucketState {
    const currentProviderDay = getGeminiProviderDayId(wallNow)
    const cooldownUntil = toNonNegativeInteger(session.cooldownUntil)
    return {
      reservations: toReservations(session.reservations, wallNow, monotonicNow),
      cooldownUntil,
      monotonicCooldownUntil: monotonicNow + Math.max(0, cooldownUntil - wallNow),
      providerDay: currentProviderDay,
      // Legacy provider-day identity used a fixed offset, so even a date that
      // appears old is ambiguous around DST/midnight and must retain usage.
      requestsToday: isStoredCount(local.requestsToday)
        ? Math.floor(local.requestsToday)
        : Number.MAX_SAFE_INTEGER,
    }
  }

  private conservativeBucket(
    wallNow: number,
    monotonicNow: number,
    value: Record<string, unknown> = {},
  ): QuotaBucketState {
    const cooldownUntil = toNonNegativeInteger(value.cooldownUntil)
    return {
      reservations: [conservativeReservation(wallNow, monotonicNow, 0)],
      cooldownUntil,
      monotonicCooldownUntil: monotonicNow + Math.max(0, cooldownUntil - wallNow),
      providerDay: getGeminiProviderDayId(wallNow),
      requestsToday: isStoredCount(value.requestsToday)
        ? Math.floor(value.requestsToday)
        : Number.MAX_SAFE_INTEGER,
    }
  }

  private getBucket(
    quotaKey: string,
    time: { wallNow: number; monotonicNow: number },
  ): QuotaBucketState {
    const key = typeof quotaKey === 'string' && quotaKey.trim() ? quotaKey.trim() : DEFAULT_QUOTA_BUCKET
    const existing = this.buckets!.get(key)
    if (existing) return existing

    const bucket = this.legacyBaseline
      ? this.cloneBucket(this.legacyBaseline)
      : {
          reservations: [],
          cooldownUntil: 0,
          monotonicCooldownUntil: 0,
          providerDay: getGeminiProviderDayId(time.wallNow),
          requestsToday: 0,
        }
    this.buckets!.set(key, bucket)
    return bucket
  }

  private cloneBucket(bucket: QuotaBucketState): QuotaBucketState {
    return { ...bucket, reservations: bucket.reservations.map((reservation) => ({ ...reservation })) }
  }

  private hasReservationId(reservationId: string): boolean {
    if (this.legacyBaseline?.reservations.some((reservation) => reservation.id === reservationId)) return true
    return Array.from(this.buckets!.values()).some((bucket) =>
      bucket.reservations.some((reservation) => reservation.id === reservationId),
    )
  }

  private prune(bucket: QuotaBucketState, monotonicNow: number): void {
    bucket.reservations = bucket.reservations
      .filter((reservation) => reservation.monotonicExpiresAt > monotonicNow)
      .sort((left, right) => left.monotonicExpiresAt - right.monotonicExpiresAt)
  }

  private resetProviderDay(bucket: QuotaBucketState, wallNow: number): void {
    const day = getGeminiProviderDayId(wallNow)
    if (isProviderDay(bucket.providerDay) && day > bucket.providerDay) {
      bucket.providerDay = day
      bucket.requestsToday = 0
    }
  }

  private expireCooldown(bucket: QuotaBucketState, monotonicNow: number): void {
    if (bucket.monotonicCooldownUntil <= monotonicNow) {
      bucket.monotonicCooldownUntil = 0
      bucket.cooldownUntil = 0
    }
  }

  private nextTokenAvailability(bucket: QuotaBucketState, tokenCost: number, limit: number): number | undefined {
    let total = bucket.reservations.reduce((sum, reservation) => sum + reservation.inputTokens, 0)
    for (const reservation of bucket.reservations) {
      total -= reservation.inputTokens
      if (total + tokenCost <= limit) return reservation.monotonicExpiresAt
    }
    return undefined
  }

  private makeMigrationFailClosed(
    bucket: QuotaBucketState,
    providerDay: string,
    wallNow: number,
    monotonicNow: number,
  ): void {
    bucket.providerDay = providerDay
    bucket.requestsToday = Number.MAX_SAFE_INTEGER
    bucket.reservations.push(conservativeReservation(wallNow, monotonicNow, bucket.reservations.length))
  }

  private observeClock(): { wallNow: number; monotonicNow: number; rollback: boolean } {
    const rawWallNow = this.readWallNow()
    const monotonicNow = this.readMonotonicNow()
    const previousHighWater = this.wallHighWaterMark ?? rawWallNow
    const previousTrustedWall = this.trustedWallNow ?? previousHighWater
    const previousMonotonic = this.lastMonotonicNow ?? monotonicNow
    const monotonicElapsed = Math.max(0, monotonicNow - previousMonotonic)
    const trustedWallNow = Math.max(
      previousTrustedWall,
      Math.min(rawWallNow, previousTrustedWall + monotonicElapsed),
    )
    const behindHighWater = rawWallNow < previousHighWater
    this.trustedWallNow = trustedWallNow
    this.lastMonotonicNow = Math.max(previousMonotonic, monotonicNow)
    this.wallHighWaterMark = Math.max(previousHighWater, Math.floor(trustedWallNow))
    const providerDay = getGeminiProviderDayId(trustedWallNow)
    const behindProviderDay = Array.from(this.buckets?.values() ?? []).some((bucket) =>
      isProviderDay(bucket.providerDay) && providerDay < bucket.providerDay,
    ) || (this.legacyBaseline !== undefined &&
      isProviderDay(this.legacyBaseline.providerDay) && providerDay < this.legacyBaseline.providerDay)
    return {
      wallNow: trustedWallNow,
      monotonicNow,
      rollback: !this.clockTrusted || behindHighWater || behindProviderDay,
    }
  }

  private initializeRuntimeClock(wallNow: number, monotonicNow: number): void {
    this.trustedWallNow = Math.max(this.wallHighWaterMark ?? wallNow, wallNow)
    this.lastMonotonicNow = monotonicNow
  }

  private readWallNow(): number {
    const value = this.clock.wallNow()
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : this.wallHighWaterMark ?? 0
  }

  private readMonotonicNow(): number {
    const value = this.clock.monotonicNow()
    return Number.isFinite(value) && value >= 0 ? value : 0
  }

  private async persist(): Promise<void> {
    // One local write is the restart-safe commit point. The session record is
    // only a legacy/best-effort mirror, so cross-area partial writes cannot
    // restore a quota state that was never committed.
    await this.persistLocal()
    try {
      await this.persistSession()
    } catch {
      // The complete canonical snapshot is already durable.
    }
  }

  private async persistSession(): Promise<void> {
    await this.storage.setSession({
      quotaVersion: QUOTA_STORAGE_VERSION,
      wallHighWaterMark: this.wallHighWaterMark,
      clockTrusted: this.clockTrusted,
      buckets: this.serializeBuckets(false),
      ...(this.legacyBaseline ? { legacyBaseline: this.serializeBucket(this.legacyBaseline, false) } : {}),
    })
  }

  private async persistLocal(): Promise<void> {
    await this.storage.setLocal({
      quotaVersion: QUOTA_STORAGE_VERSION,
      wallHighWaterMark: this.wallHighWaterMark,
      clockTrusted: this.clockTrusted,
      buckets: this.serializeBuckets(true),
      ...(this.legacyBaseline ? { legacyBaseline: this.serializeBucket(this.legacyBaseline, true) } : {}),
    })
  }

  private serializeBuckets(includeDaily: boolean): Record<string, Record<string, unknown>> {
    return Object.fromEntries(Array.from(this.buckets!.entries(), ([key, bucket]) => [
      key,
      this.serializeBucket(bucket, includeDaily),
    ]))
  }

  private serializeBucket(bucket: QuotaBucketState, includeDaily: boolean): Record<string, unknown> {
    return {
      reservations: bucket.reservations.map(({ id, at, inputTokens }) => ({ id, at, inputTokens })),
      cooldownUntil: bucket.cooldownUntil,
      ...(includeDaily ? {
        providerDay: bucket.providerDay,
        requestsToday: bucket.requestsToday,
      } : {}),
    }
  }
}
