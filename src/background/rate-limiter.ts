import { ExponentialBackoff, type BackoffStrategy } from './backoff-strategy'
import { createSystemClock, type Clock } from './clock'

export interface RateLimiterOptions {
  maxBackoffMs: number
  baseBackoffMs?: number
  strategy?: BackoffStrategy
  clock?: Pick<Clock, 'monotonicNow'>
}

interface ProviderState {
  retryAfterMs: number
  backoffMultiplier: number
  limitedAt: number
  attemptCount: number
}

export class RateLimiter {
  private state = new Map<string, ProviderState>()
  private maxBackoffMs: number
  private strategy: BackoffStrategy
  private monotonicNow: () => number

  constructor(options: RateLimiterOptions) {
    this.maxBackoffMs = options.maxBackoffMs
    this.strategy = options.strategy ?? new ExponentialBackoff(options.baseBackoffMs ?? 1_000, options.maxBackoffMs)
    this.monotonicNow = options.clock?.monotonicNow ?? createSystemClock().monotonicNow
  }

  recordError(providerId: string, retryAfterMs: number): void {
    const current = this.state.get(providerId)

    if (current) {
      current.attemptCount++
    } else {
      this.state.set(providerId, {
        retryAfterMs: 0,
        backoffMultiplier: 1,
        limitedAt: 0,
        attemptCount: 0,
      })
    }

    const entry = this.state.get(providerId)!
    const backoffMs = this.strategy.nextDelay(entry.attemptCount)
    const reportedWait = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 0
    const effectiveWait = Math.min(
      Math.max(reportedWait, backoffMs),
      this.maxBackoffMs,
    )

    entry.retryAfterMs = effectiveWait
    entry.limitedAt = this.monotonicNow()
  }

  isLimited(providerId: string): boolean {
    return this.getRemainingCooldown(providerId) > 0
  }

  getRemainingCooldown(providerId: string): number {
    const entry = this.state.get(providerId)

    if (!entry) return 0

    const elapsed = this.monotonicNow() - entry.limitedAt

    if (elapsed >= entry.retryAfterMs) {
      return 0
    }

    return entry.retryAfterMs - elapsed
  }

  reset(providerId: string): void {
    this.state.delete(providerId)
  }

  getAttemptCount(providerId: string): number {
    return this.state.get(providerId)?.attemptCount ?? 0
  }
}
