import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { RateLimiter } from './rate-limiter'

describe('RateLimiter', () => {
  let limiter: RateLimiter

  beforeEach(() => {
    vi.useFakeTimers()
    limiter = new RateLimiter({ maxBackoffMs: 60_000 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with no provider limited', () => {
    expect(limiter.isLimited('deepseek')).toBe(false)
    expect(limiter.getRemainingCooldown('deepseek')).toBe(0)
  })

  it('marks provider as limited after recording a rate limit error', () => {
    limiter.recordError('deepseek', 5_000)
    expect(limiter.isLimited('deepseek')).toBe(true)
    expect(limiter.getRemainingCooldown('deepseek')).toBeGreaterThan(0)
    expect(limiter.getRemainingCooldown('deepseek')).toBeLessThanOrEqual(5_000)
  })

  it('does not affect other providers when one is rate limited', () => {
    limiter.recordError('deepseek', 5_000)
    expect(limiter.isLimited('deepseek')).toBe(true)
    expect(limiter.isLimited('gemini')).toBe(false)
    expect(limiter.getRemainingCooldown('gemini')).toBe(0)
  })

  it('becomes not limited after the retry period passes', () => {
    limiter.recordError('deepseek', 5_000)
    vi.advanceTimersByTime(5_001)
    expect(limiter.isLimited('deepseek')).toBe(false)
    expect(limiter.getRemainingCooldown('deepseek')).toBe(0)
  })

  it('uses injected monotonic elapsed time instead of wall-clock jumps', () => {
    let monotonicNow = 1_000
    vi.setSystemTime(10_000)
    limiter = new RateLimiter({
      maxBackoffMs: 60_000,
      clock: { monotonicNow: () => monotonicNow },
    })
    limiter.recordError('deepseek', 5_000)

    vi.setSystemTime(86_410_000)
    expect(limiter.isLimited('deepseek')).toBe(true)

    monotonicNow += 5_001
    expect(limiter.isLimited('deepseek')).toBe(false)
  })

  it('applies exponential backoff for consecutive rate limit errors', () => {
    limiter.recordError('deepseek', 1_000)
    expect(limiter.getRemainingCooldown('deepseek')).toBeGreaterThanOrEqual(900)

    vi.advanceTimersByTime(2_000)

    limiter.recordError('deepseek', 1_000)
    expect(limiter.getRemainingCooldown('deepseek')).toBeGreaterThanOrEqual(1_800)

    vi.advanceTimersByTime(4_000)

    limiter.recordError('deepseek', 1_000)
    expect(limiter.getRemainingCooldown('deepseek')).toBeGreaterThanOrEqual(3_600)
  })

  it('caps backoff at maxBackoffMs', () => {
    limiter = new RateLimiter({ maxBackoffMs: 10_000 })
    limiter.recordError('deepseek', 60_000)
    expect(limiter.getRemainingCooldown('deepseek')).toBeLessThanOrEqual(10_000)
  })

  it('uses the larger of provider retryAfterMs and computed backoff', () => {
    limiter.recordError('deepseek', 1_000)

    vi.advanceTimersByTime(2_000)

    // Provider says 30s, but backoff is smaller — should use provider's value
    limiter.recordError('deepseek', 30_000)
    expect(limiter.getRemainingCooldown('deepseek')).toBeGreaterThanOrEqual(29_000)
  })

  it('resets rate limit state after a successful call', () => {
    limiter.recordError('deepseek', 10_000)
    expect(limiter.isLimited('deepseek')).toBe(true)

    limiter.reset('deepseek')
    expect(limiter.isLimited('deepseek')).toBe(false)
    expect(limiter.getRemainingCooldown('deepseek')).toBe(0)

    // Next error should start from base, not from escalated backoff
    limiter.recordError('deepseek', 1_000)
    expect(limiter.getRemainingCooldown('deepseek')).toBeGreaterThanOrEqual(900)
    expect(limiter.getRemainingCooldown('deepseek')).toBeLessThanOrEqual(1_100)
  })

  it('returns 0 cooldown for providers that were never rate limited', () => {
    expect(limiter.getRemainingCooldown('gemini')).toBe(0)
  })

  it('handles multiple providers independently with separate backoff', () => {
    limiter.recordError('deepseek', 1_000)
    limiter.recordError('gemini', 2_000)

    expect(limiter.isLimited('deepseek')).toBe(true)
    expect(limiter.isLimited('gemini')).toBe(true)

    vi.advanceTimersByTime(1_500)

    expect(limiter.isLimited('deepseek')).toBe(false)
    expect(limiter.isLimited('gemini')).toBe(true)

    vi.advanceTimersByTime(1_000)

    expect(limiter.isLimited('gemini')).toBe(false)
  })
})
