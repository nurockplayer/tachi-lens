import { describe, expect, it } from 'vitest'
import { parseRetryAfterMs } from './retry-after'

describe('parseRetryAfterMs', () => {
  const now = Date.UTC(2026, 6, 13, 0, 0, 0)

  it('parses numeric delay-seconds, including fractions', () => {
    expect(parseRetryAfterMs('12.5', now)).toBe(12_500)
  })

  it('parses a future HTTP-date relative to the supplied clock', () => {
    expect(parseRetryAfterMs('Mon, 13 Jul 2026 00:02:00 GMT', now)).toBe(120_000)
  })

  it('returns zero for a past HTTP-date', () => {
    expect(parseRetryAfterMs('Sun, 12 Jul 2026 23:59:00 GMT', now)).toBe(0)
  })

  it('rejects malformed values', () => {
    expect(parseRetryAfterMs('later please', now)).toBeUndefined()
  })
})
