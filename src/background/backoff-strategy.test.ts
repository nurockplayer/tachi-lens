// Backoff Strategy Tests
// Tests for exponential, linear, and fixed backoff strategies.

import { describe, expect, it } from 'vitest'
import { ExponentialBackoff, FixedBackoff, LinearBackoff } from './backoff-strategy'

describe('Backoff Strategies', () => {
  describe('ExponentialBackoff', () => {
    it('starts with base delay on first attempt', () => {
      const strategy = new ExponentialBackoff(1_000)
      expect(strategy.nextDelay(0)).toBe(1_000)
    })

    it('doubles delay on each subsequent attempt', () => {
      const strategy = new ExponentialBackoff(1_000)
      expect(strategy.nextDelay(0)).toBe(1_000)
      expect(strategy.nextDelay(1)).toBe(2_000)
      expect(strategy.nextDelay(2)).toBe(4_000)
      expect(strategy.nextDelay(3)).toBe(8_000)
    })

    it('caps delay at maxMs', () => {
      const strategy = new ExponentialBackoff(1_000, 10_000)
      expect(strategy.nextDelay(0)).toBe(1_000)
      expect(strategy.nextDelay(1)).toBe(2_000)
      expect(strategy.nextDelay(2)).toBe(4_000)
      expect(strategy.nextDelay(3)).toBe(8_000)
      expect(strategy.nextDelay(4)).toBe(10_000) // capped
      expect(strategy.nextDelay(5)).toBe(10_000) // capped
    })
  })

  describe('LinearBackoff', () => {
    it('starts with base delay on first attempt', () => {
      const strategy = new LinearBackoff(1_000)
      expect(strategy.nextDelay(0)).toBe(0) // 1000 * 0
    })

    it('increases delay linearly with attempt count', () => {
      const strategy = new LinearBackoff(1_000)
      expect(strategy.nextDelay(1)).toBe(1_000)
      expect(strategy.nextDelay(2)).toBe(2_000)
      expect(strategy.nextDelay(3)).toBe(3_000)
    })

    it('caps delay at maxMs', () => {
      const strategy = new LinearBackoff(1_000, 5_000)
      expect(strategy.nextDelay(1)).toBe(1_000)
      expect(strategy.nextDelay(2)).toBe(2_000)
      expect(strategy.nextDelay(3)).toBe(3_000)
      expect(strategy.nextDelay(4)).toBe(4_000)
      expect(strategy.nextDelay(5)).toBe(5_000) // capped
      expect(strategy.nextDelay(6)).toBe(5_000) // capped
    })
  })

  describe('FixedBackoff', () => {
    it('returns constant delay regardless of attempt', () => {
      const strategy = new FixedBackoff(5_000)
      expect(strategy.nextDelay()).toBe(5_000)
      expect(strategy.nextDelay()).toBe(5_000)
      expect(strategy.nextDelay()).toBe(5_000)
    })

    it('can be configured with custom delay', () => {
      const strategy = new FixedBackoff(10_000)
      expect(strategy.nextDelay()).toBe(10_000)
    })
  })
})