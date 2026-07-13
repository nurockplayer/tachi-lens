export interface GeminiQuotaSettings {
  requestsPerMinute: number
  inputTokensPerMinute: number
  requestsPerDay: number
  rpmSafetyPercent: number
  tpmSafetyPercent: number
  rpdSafetyPercent: number
  liveMaxWaitMs: number
  maxConcurrency: number
  providerDayStartHourUtc: number
}

export type GeminiQuotaDenial = 'rpm' | 'tpm' | 'rpd' | 'cooldown'

export interface GeminiQuotaReservation {
  accepted: boolean
  reason?: GeminiQuotaDenial
  nextAvailableAt?: number
}

export interface GeminiQuotaUsage {
  rollingRequests: number
  rollingInputTokens: number
  requestsToday: number
  cooldownUntil: number
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

interface Reservation {
  at: number
  inputTokens: number
}

interface SessionState {
  reservations: Reservation[]
  cooldownUntil: number
}

interface LocalState {
  providerDay: string
  requestsToday: number
}

const ROLLING_WINDOW_MS = 60_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toNonNegativeInteger = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

const toReservations = (value: unknown): Reservation[] => {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const at = toNonNegativeInteger(entry.at)
    const inputTokens = toNonNegativeInteger(entry.inputTokens)
    return at > 0 ? [{ at, inputTokens }] : []
  })
}

const safeLimit = (configured: number, safetyPercent: number, minimumOne = false): number => {
  if (!Number.isFinite(configured) || configured <= 0) return 0
  const percent = Number.isFinite(safetyPercent) ? Math.min(100, Math.max(0, safetyPercent)) : 0
  const safe = Math.floor(configured * percent / 100)
  return minimumOne ? Math.max(1, safe) : safe
}

const providerDayId = (now: number, boundaryHourUtc: number): string => {
  const boundedHour = Number.isFinite(boundaryHourUtc)
    ? Math.min(23, Math.max(0, Math.floor(boundaryHourUtc)))
    : 0
  return new Date(now - boundedHour * 3_600_000).toISOString().slice(0, 10)
}

const nextProviderDayStart = (now: number, boundaryHourUtc: number): number => {
  const date = new Date(now)
  const boundedHour = Number.isFinite(boundaryHourUtc)
    ? Math.min(23, Math.max(0, Math.floor(boundaryHourUtc)))
    : 0
  const boundary = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), boundedHour)
  return boundary > now ? boundary : boundary + 86_400_000
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
  private session: SessionState | undefined
  private local: LocalState | undefined
  private mutation = Promise.resolve()

  constructor(
    private storage: QuotaStorage,
    private now: () => number = Date.now,
  ) {}

  async reserve(profile: GeminiQuotaSettings, inputTokens: number): Promise<GeminiQuotaReservation> {
    return this.exclusively(async () => {
      await this.load()
      const now = this.now()
      this.prune(now)
      this.resetProviderDay(profile, now)

      if (this.session!.cooldownUntil > now) {
        await this.persist()
        return { accepted: false, reason: 'cooldown', nextAvailableAt: this.session!.cooldownUntil }
      }

      const rpm = safeLimit(profile.requestsPerMinute, profile.rpmSafetyPercent, true)
      const tpm = safeLimit(profile.inputTokensPerMinute, profile.tpmSafetyPercent)
      const rpd = safeLimit(profile.requestsPerDay, profile.rpdSafetyPercent)
      const tokenCost = Math.max(0, Math.ceil(inputTokens))
      const rollingTokens = this.session!.reservations.reduce((sum, reservation) => sum + reservation.inputTokens, 0)

      if (this.session!.reservations.length + 1 > rpm) {
        await this.persist()
        return { accepted: false, reason: 'rpm', nextAvailableAt: this.session!.reservations[0]!.at + ROLLING_WINDOW_MS }
      }

      if (rollingTokens + tokenCost > tpm) {
        await this.persist()
        return { accepted: false, reason: 'tpm', nextAvailableAt: this.nextTokenAvailability(tokenCost, tpm) }
      }

      if (this.local!.requestsToday + 1 > rpd) {
        await this.persist()
        return {
          accepted: false,
          reason: 'rpd',
          nextAvailableAt: nextProviderDayStart(now, profile.providerDayStartHourUtc),
        }
      }

      this.session!.reservations.push({ at: now, inputTokens: tokenCost })
      this.local!.requestsToday++
      await this.persist()
      return { accepted: true }
    })
  }

  async openCooldown(retryAfterMs: number): Promise<void> {
    await this.exclusively(async () => {
      await this.load()
      const cooldownUntil = this.now() + Math.max(0, Math.ceil(retryAfterMs))
      this.session!.cooldownUntil = Math.max(this.session!.cooldownUntil, cooldownUntil)
      await this.persist()
    })
  }

  async getUsage(): Promise<GeminiQuotaUsage> {
    return this.exclusively(async () => {
      await this.load()
      this.prune(this.now())
      await this.persistSession()
      return {
        rollingRequests: this.session!.reservations.length,
        rollingInputTokens: this.session!.reservations.reduce((sum, reservation) => sum + reservation.inputTokens, 0),
        requestsToday: this.local!.requestsToday,
        cooldownUntil: this.session!.cooldownUntil,
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
    if (this.session && this.local) return
    const [storedSession, storedLocal] = await Promise.all([this.storage.getSession(), this.storage.getLocal()])
    this.session = {
      reservations: toReservations(storedSession.reservations),
      cooldownUntil: toNonNegativeInteger(storedSession.cooldownUntil),
    }
    this.local = {
      providerDay: typeof storedLocal.providerDay === 'string' ? storedLocal.providerDay : '',
      requestsToday: toNonNegativeInteger(storedLocal.requestsToday),
    }
  }

  private prune(now: number): void {
    this.session!.reservations = this.session!.reservations
      .filter((reservation) => reservation.at + ROLLING_WINDOW_MS > now)
      .sort((left, right) => left.at - right.at)
  }

  private resetProviderDay(profile: GeminiQuotaSettings, now: number): void {
    const day = providerDayId(now, profile.providerDayStartHourUtc)
    if (this.local!.providerDay !== day) {
      this.local!.providerDay = day
      this.local!.requestsToday = 0
    }
  }

  private nextTokenAvailability(tokenCost: number, limit: number): number | undefined {
    let total = this.session!.reservations.reduce((sum, reservation) => sum + reservation.inputTokens, 0)
    for (const reservation of this.session!.reservations) {
      total -= reservation.inputTokens
      if (total + tokenCost <= limit) return reservation.at + ROLLING_WINDOW_MS
    }
    return undefined
  }

  private async persist(): Promise<void> {
    await Promise.all([this.persistSession(), this.persistLocal()])
  }

  private async persistSession(): Promise<void> {
    await this.storage.setSession({
      reservations: this.session!.reservations,
      cooldownUntil: this.session!.cooldownUntil,
    })
  }

  private async persistLocal(): Promise<void> {
    await this.storage.setLocal({
      providerDay: this.local!.providerDay,
      requestsToday: this.local!.requestsToday,
    })
  }
}
