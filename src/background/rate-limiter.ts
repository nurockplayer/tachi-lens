export interface RateLimiterOptions {
  maxBackoffMs: number
  baseBackoffMs?: number
}

interface ProviderState {
  retryAfterMs: number
  backoffMultiplier: number
  limitedAt: number
}

export class RateLimiter {
  private state = new Map<string, ProviderState>()
  private maxBackoffMs: number
  private baseBackoffMs: number

  constructor(options: RateLimiterOptions) {
    this.maxBackoffMs = options.maxBackoffMs
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000
  }

  recordError(providerId: string, retryAfterMs: number): void {
    const current = this.state.get(providerId)

    if (current) {
      current.backoffMultiplier *= 2
    } else {
      this.state.set(providerId, {
        retryAfterMs: 0,
        backoffMultiplier: 1,
        limitedAt: 0,
      })
    }

    const entry = this.state.get(providerId)!
    const backoffMs = this.baseBackoffMs * entry.backoffMultiplier
    const effectiveWait = Math.min(
      Math.max(retryAfterMs, backoffMs),
      this.maxBackoffMs,
    )

    entry.retryAfterMs = effectiveWait
    entry.limitedAt = Date.now()
  }

  isLimited(providerId: string): boolean {
    return this.getRemainingCooldown(providerId) > 0
  }

  getRemainingCooldown(providerId: string): number {
    const entry = this.state.get(providerId)

    if (!entry) return 0

    const elapsed = Date.now() - entry.limitedAt

    if (elapsed >= entry.retryAfterMs) {
      return 0
    }

    return entry.retryAfterMs - elapsed
  }

  reset(providerId: string): void {
    this.state.delete(providerId)
  }
}
