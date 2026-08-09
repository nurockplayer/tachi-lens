// Speech budget tests (v0.3 speech, Spec §10/§7, D4 decision).
// Deterministic: fake storage, fake clock. Verifies session + daily caps,
// provider-day rollover, SW-suspension session restore, and the new-storage-key
// D4 decision (separate from chat geminiQuota machinery).

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DAILY_AUDIO_MINUTE_CAP,
  SPEECH_AUDIO_USAGE_LOCAL_KEY,
  SPEECH_SESSION_STATE_KEY,
  SpeechBudget,
  SpeechBudgetExceededError,
  type SpeechBudgetStorage,
} from './speech-budget'

interface FakeStorage {
  local: Record<string, unknown>
  session: Record<string, unknown>
  localSet: ReturnType<typeof vi.fn>
  sessionSet: ReturnType<typeof vi.fn>
  storage: SpeechBudgetStorage
}

const createFakeStorage = (overrides: { local?: Record<string, unknown>; session?: Record<string, unknown> } = {}): FakeStorage => {
  const local: Record<string, unknown> = { ...overrides.local }
  const session: Record<string, unknown> = { ...overrides.session }
  const localSet = vi.fn(async (value: Record<string, unknown>) => { Object.assign(local, value) })
  const sessionSet = vi.fn(async (value: Record<string, unknown>) => { Object.assign(session, value) })
  const storage: SpeechBudgetStorage = {
    getLocal: vi.fn(async () => ({ ...local })),
    setLocal: localSet,
    getSession: vi.fn(async () => ({ ...session })),
    setSession: sessionSet,
  }
  return { local, session, localSet, sessionSet, storage }
}

const createBudget = (options: {
  storage?: SpeechBudgetStorage
  now?: () => number
  sessionCapMinutes?: number
  dailyCapMinutes?: number
} = {}) => {
  const storage = options.storage ?? createFakeStorage().storage
  const budget = new SpeechBudget({
    storage,
    now: options.now ?? (() => 1_700_000_000_000),
    getSessionCapMinutes: () => options.sessionCapMinutes ?? 30,
    dailyCapMinutes: options.dailyCapMinutes ?? DEFAULT_DAILY_AUDIO_MINUTE_CAP,
  })
  return { budget, storage }
}

describe('SpeechBudget', () => {
  describe('session cap (maxSessionMinutes)', () => {
    it('charges under the cap and throws over it', async () => {
      const { budget } = createBudget({ sessionCapMinutes: 1 })
      await budget.beginSession('sess-1')

      // 30 s is fine; 31 s would exceed the 60 s session cap.
      const usage = budget.chargeSeconds(30)
      expect(usage.sessionSeconds).toBe(30)
      expect(() => budget.chargeSeconds(31)).toThrow(SpeechBudgetExceededError)

      let caughtKind: string | undefined
      try {
        budget.chargeSeconds(31)
      } catch (error) {
        if (error instanceof SpeechBudgetExceededError) caughtKind = error.kind
      }
      expect(caughtKind).toBe('session')
      // The rejected window is never charged.
      expect(budget.getUsage().sessionSeconds).toBe(30)
    })

    it('a fresh session id resets the session counter', async () => {
      const { budget, storage } = createBudget({ sessionCapMinutes: 1 })
      await budget.beginSession('sess-1')
      budget.chargeSeconds(59)
      await budget.flush()

      const budget2 = new SpeechBudget({
        storage,
        now: () => 1_700_000_000_000,
        getSessionCapMinutes: () => 1,
      })
      await budget2.beginSession('sess-2')
      expect(budget2.getUsage().sessionSeconds).toBe(0)
    })
  })

  describe('daily cap persistence (D4: new storage key)', () => {
    it('persists daily audio-seconds under speechAudioUsage and rolls over on provider day', async () => {
      const { budget, storage } = createBudget({ dailyCapMinutes: 10 })
      await budget.beginSession('sess-1')
      budget.chargeSeconds(120)
      await budget.flush()

      // Persisted under the dedicated speech key, never the chat quota key.
      const local = (storage as SpeechBudgetStorage).getLocal ? await (storage as SpeechBudgetStorage).getLocal() : {}
      const persisted = local[SPEECH_AUDIO_USAGE_LOCAL_KEY] as { providerDay: string; audioSeconds: number }
      expect(persisted).toBeDefined()
      expect(persisted.audioSeconds).toBe(120)
      expect(persisted.providerDay).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // Chat quota keys are untouched.
      expect(local['geminiQuotaUsage']).toBeUndefined()
    })

    it('a reload resumes the same daily counter within the same provider day', async () => {
      const { budget, storage } = createBudget({ dailyCapMinutes: 10 })
      await budget.beginSession('sess-1')
      budget.chargeSeconds(120)
      await budget.flush()

      // Simulate an SW wake: a fresh SpeechBudget over the same storage.
      const budget2 = new SpeechBudget({
        storage,
        now: () => 1_700_000_000_000,
        getSessionCapMinutes: () => 30,
        dailyCapMinutes: 10,
      })
      await budget2.beginSession('sess-1')
      expect(budget2.getUsage().dailySeconds).toBe(120)
    })

    it('zeroes the daily counter after the provider day rolls over', async () => {
      // day0 and day0+24h must be different Gemini provider days.
      const day0 = 1_700_000_000_000
      const day1 = day0 + 24 * 3_600_000
      const { budget, storage } = createBudget({ now: () => day0, dailyCapMinutes: 10 })
      await budget.beginSession('sess-1')
      budget.chargeSeconds(120)
      await budget.flush()

      const budget2 = new SpeechBudget({
        storage,
        now: () => day1,
        getSessionCapMinutes: () => 30,
        dailyCapMinutes: 10,
      })
      await budget2.beginSession('sess-1')
      expect(budget2.getUsage().dailySeconds).toBe(0)
      // The persisted local counter still holds the old day; the new instance
      // zeroed the counter for the current day.
      const persisted = (await (storage as SpeechBudgetStorage).getLocal())[SPEECH_AUDIO_USAGE_LOCAL_KEY] as { providerDay: string; audioSeconds: number }
      expect(persisted.providerDay).not.toBe(budget2.getUsage().providerDay)
    })

    it('a reload zeroes an old-day counter without a charge', async () => {
      const day0 = 1_700_000_000_000
      const day1 = day0 + 24 * 3_600_000
      const { budget, storage } = createBudget({ now: () => day0, dailyCapMinutes: 10 })
      await budget.beginSession('sess-1')
      budget.chargeSeconds(5)
      await budget.flush()

      const budget2 = new SpeechBudget({
        storage,
        now: () => day1,
        getSessionCapMinutes: () => 30,
        dailyCapMinutes: 10,
      })
      await budget2.beginSession('sess-1')
      expect(budget2.getUsage().dailySeconds).toBe(0)
    })
  })

  describe('daily cap exhaustion', () => {
    it('stops charging at the daily cap', async () => {
      const { budget } = createBudget({ dailyCapMinutes: 1 })
      await budget.beginSession('sess-1')
      budget.chargeSeconds(59)
      expect(() => budget.chargeSeconds(2)).toThrow(SpeechBudgetExceededError)
      expect(budget.getUsage().dailySeconds).toBe(59)
      expect(budget.isDailyExhausted()).toBe(false)
      budget.chargeSeconds(1)
      expect(budget.isDailyExhausted()).toBe(true)
      expect(() => budget.chargeSeconds(1)).toThrow(SpeechBudgetExceededError)
    })
  })

  describe('SW suspension session restore (Spec §7)', () => {
    it('marks the session active and returns its id for resume', async () => {
      const { budget, storage } = createBudget({ sessionCapMinutes: 30 })
      await budget.beginSession('sess-live')
      budget.chargeSeconds(60)
      await budget.flush()

      const activeId = await budget.readActiveSessionId()
      expect(activeId).toBe('sess-live')

      // A new worker instance resolves the same active session and resumes it.
      const budget2 = new SpeechBudget({
        storage,
        now: () => 1_700_000_000_000,
        getSessionCapMinutes: () => 30,
      })
      await budget2.beginSession('sess-live')
      expect(budget2.getUsage().sessionSeconds).toBe(60)
    })

    it('markSessionInactive ends the session so a fresh enable starts over', async () => {
      const { budget, storage } = createBudget({ sessionCapMinutes: 30 })
      await budget.beginSession('sess-live')
      budget.chargeSeconds(60)
      await budget.flush()
      await budget.markSessionInactive()

      expect(await budget.readActiveSessionId()).toBeUndefined()

      const budget2 = new SpeechBudget({
        storage,
        now: () => 1_700_000_000_000,
        getSessionCapMinutes: () => 30,
      })
      await budget2.beginSession('sess-live')
      expect(budget2.getUsage().sessionSeconds).toBe(0)
    })

    it('persists the session state under the session storage key', async () => {
      const { budget, storage } = createBudget({ sessionCapMinutes: 30 })
      await budget.beginSession('sess-1')
      budget.chargeSeconds(30)
      await budget.flush()

      const session = await (storage as SpeechBudgetStorage).getSession()
      const state = session[SPEECH_SESSION_STATE_KEY] as { sessionId: string; audioSeconds: number; active: boolean }
      expect(state.sessionId).toBe('sess-1')
      expect(state.audioSeconds).toBe(30)
      expect(state.active).toBe(true)
    })
  })

  describe('setSessionCapMinutes', () => {
    it('applies a runtime session cap from settings', async () => {
      const { budget } = createBudget({ sessionCapMinutes: 30 })
      budget.setSessionCapMinutes(2) // 2 minutes from speechConfig.maxSessionMinutes
      await budget.beginSession('sess-1')
      budget.chargeSeconds(119)
      expect(() => budget.chargeSeconds(2)).toThrow(SpeechBudgetExceededError)
      expect(budget.getUsage().sessionCapSeconds).toBe(120)
    })
  })
})
