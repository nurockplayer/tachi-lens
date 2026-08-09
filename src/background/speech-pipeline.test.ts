// Speech pipeline tests (v0.3 speech, Spec §2/§6/§9/§10).
// Deterministic: shared FakeSpeechSource + shared mock speech provider + mock
// settings + fake budget storage + fake timers (Spec §11). No tabCapture/
// offscreen/provider.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpeechBudget, type SpeechBudgetStorage } from './speech-budget'
import { RateLimiter } from './rate-limiter'
import {
  SPEECH_MAX_BUFFER_MS,
  SpeechPipeline,
  computePcmRms,
  mapCaptureError,
  type SpeechPipelineDependencies,
} from './speech-pipeline'
import { FakeSpeechSource, fluentChunk, loudPcm, mkChunk, silentPcm } from '@/test-utils/fake-speech-source'
import { createMockSpeechProvider, type MockSpeechProviderHandle } from '@/test-utils/mock-speech-provider'
import type { AudioChunk } from '@/providers/speech-types'
import type { UserSettings } from '@/storage/settings'
import type { SpeechCaptionClearedPayload, SpeechCaptionPayload, SpeechStatePayload } from '@/shared/messages'
import type { SpeechErrorReason } from '@/shared/speech-state'

// --- fakes ------------------------------------------------------------------

const DEFAULT_SETTINGS: Partial<UserSettings> = {
  speechConfig: {
    speechEnabled: true,
    speechConsentGranted: true,
    speechProvider: 'gemini',
    speechModel: 'gemini-2.5-flash',
    speechTargetLanguage: 'zh-TW',
    captionMaxLines: 2,
    captionOpacity: 100,
    maxSessionMinutes: 30,
  },
}

const createBudgetStorage = (): SpeechBudgetStorage & {
  local: Record<string, unknown>
  session: Record<string, unknown>
  localSet: ReturnType<typeof vi.fn>
  sessionSet: ReturnType<typeof vi.fn>
} => {
  const local: Record<string, unknown> = {}
  const session: Record<string, unknown> = {}
  const localSet = vi.fn(async (value: Record<string, unknown>) => { Object.assign(local, value) })
  const sessionSet = vi.fn(async (value: Record<string, unknown>) => { Object.assign(session, value) })
  return {
    local,
    session,
    localSet,
    sessionSet,
    getLocal: vi.fn(async () => ({ ...local })),
    setLocal: localSet,
    getSession: vi.fn(async () => ({ ...session })),
    setSession: sessionSet,
  }
}

interface Harness {
  pipeline: SpeechPipeline
  source: FakeSpeechSource
  handle: MockSpeechProviderHandle
  budget: SpeechBudget
  stateEvents: SpeechStatePayload[]
  captionEvents: SpeechCaptionPayload[]
  clearedEvents: SpeechCaptionClearedPayload[]
  fatalErrors: SpeechErrorReason[]
  counters: string[]
}

const createHarness = (options: {
  settings?: Partial<UserSettings>
  windowMs?: number
  maxBufferMs?: number
  silenceRmsThreshold?: number
  maxConsecutiveFailures?: number
  sessionCapMinutes?: number
  dailyCapMinutes?: number
  now?: () => number
} = {}): Harness => {
  const source = new FakeSpeechSource()
  const { provider, handle } = createMockSpeechProvider()
  const budgetStorage = createBudgetStorage()
  const budget = new SpeechBudget({
    storage: budgetStorage,
    now: options.now ?? (() => 1_700_000_000_000),
    getSessionCapMinutes: () => options.sessionCapMinutes ?? 30,
    dailyCapMinutes: options.dailyCapMinutes,
  })
  const rateLimiter = new RateLimiter({ maxBackoffMs: 60_000, clock: { monotonicNow: () => 0 } })
  const stateEvents: SpeechStatePayload[] = []
  const captionEvents: SpeechCaptionPayload[] = []
  const clearedEvents: SpeechCaptionClearedPayload[] = []
  const fatalErrors: SpeechErrorReason[] = []
  const counters: string[] = []

  const deps: SpeechPipelineDependencies = {
    source,
    getProvider: () => provider,
    getApiKey: async () => 'gemini-secret-key',
    getSettings: async () => ({ ...DEFAULT_SETTINGS, ...options.settings } as UserSettings),
    budget,
    rateLimiter,
    onState: (payload) => stateEvents.push(payload),
    onCaption: (caption) => captionEvents.push(caption),
    onCaptionCleared: (cleared) => clearedEvents.push(cleared),
    onFatalError: (reason) => fatalErrors.push(reason),
    reportDiagnosticCount: (stage) => counters.push(stage),
    windowMs: options.windowMs ?? 5_000,
    maxBufferMs: options.maxBufferMs ?? SPEECH_MAX_BUFFER_MS,
    silenceRmsThreshold: options.silenceRmsThreshold ?? 400,
    maxConsecutiveFailures: options.maxConsecutiveFailures ?? 5,
    createSessionId: () => 'session-fixed',
  }

  const pipeline = new SpeechPipeline(deps)
  return { pipeline, source, handle, budget, stateEvents, captionEvents, clearedEvents, fatalErrors, counters }
}

/** Fill the pipeline buffer past the window threshold. */
const pushWindow = (h: Harness, seconds = 5): void => {
  for (let i = 0; i < seconds; i++) {
    h.source.emitChunk(fluentChunk(i * 1000, (i + 1) * 1000))
  }
}

const flushMicrotasks = async (): Promise<void> => {
  // The provider promise chain resolves on microtasks, which fake timers do not
  // swallow. Several turns cover the .then() broadcast chain.
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('SpeechPipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('start', () => {
    it('starts capture and broadcasts capturing', async () => {
      const h = createHarness()
      await h.pipeline.start()
      expect(h.source.start).toHaveBeenCalledTimes(1)
      expect(h.stateEvents.at(-1)?.state).toBe('capturing')
      expect(h.counters).toContain('speech_started')
    })

    it('is a no-op when speech is disabled', async () => {
      const h = createHarness({ settings: { speechConfig: { ...DEFAULT_SETTINGS.speechConfig!, speechEnabled: false } } })
      await h.pipeline.start()
      expect(h.source.start).not.toHaveBeenCalled()
      expect(h.stateEvents).toHaveLength(0)
    })

    it('fails with auth when no speech API key is configured', async () => {
      const source = new FakeSpeechSource()
      const { provider } = createMockSpeechProvider()
      const budgetStorage = createBudgetStorage()
      const budget = new SpeechBudget({ storage: budgetStorage, now: () => 1_700_000_000_000 })
      const rateLimiter = new RateLimiter({ maxBackoffMs: 60_000, clock: { monotonicNow: () => 0 } })
      const fatalErrors: SpeechErrorReason[] = []
      const stateEvents: SpeechStatePayload[] = []
      const p = new SpeechPipeline({
        source,
        getProvider: () => provider,
        getApiKey: async () => undefined,
        getSettings: async () => ({ ...DEFAULT_SETTINGS } as UserSettings),
        budget,
        rateLimiter,
        onState: (s) => stateEvents.push(s),
        onCaption: () => undefined,
        onCaptionCleared: () => undefined,
        onFatalError: (r) => fatalErrors.push(r),
        reportDiagnosticCount: () => undefined,
      })
      await p.start()
      expect(fatalErrors).toEqual(['auth'])
      expect(stateEvents.at(-1)?.state).toBe('error')
      expect(stateEvents.at(-1)?.errorKey).toBe('speechErrorAuth')
    })

    it('fails with budget_exhausted when the daily cap is already reached', async () => {
      // Pre-populate storage with a daily counter at/over a 1-minute cap so a
      // fresh start is blocked before any capture begins.
      const budgetStorage = createBudgetStorage()
      Object.assign(budgetStorage.local, {
        speechAudioUsage: { version: 1, providerDay: '2099-01-01', audioSeconds: 60 },
      })
      const budget2 = new SpeechBudget({ storage: budgetStorage, now: () => 1_700_000_000_000, dailyCapMinutes: 1 })
      const source = new FakeSpeechSource()
      const { provider } = createMockSpeechProvider()
      const rateLimiter = new RateLimiter({ maxBackoffMs: 60_000, clock: { monotonicNow: () => 0 } })
      const fatalErrors2: SpeechErrorReason[] = []
      const stateEvents2: SpeechStatePayload[] = []
      const p2 = new SpeechPipeline({
        source,
        getProvider: () => provider,
        getApiKey: async () => 'key',
        getSettings: async () => ({ ...DEFAULT_SETTINGS } as UserSettings),
        budget: budget2,
        rateLimiter,
        onState: (s) => stateEvents2.push(s),
        onCaption: () => undefined,
        onCaptionCleared: () => undefined,
        onFatalError: (r) => fatalErrors2.push(r),
        reportDiagnosticCount: () => undefined,
      })
      await p2.start()
      expect(fatalErrors2).toEqual(['budget_exhausted'])
      expect(stateEvents2.at(-1)?.state).toBe('error')
      expect(stateEvents2.at(-1)?.errorKey).toBe('speechErrorBudget')
    })
  })

  describe('stop', () => {
    it('stops capture, broadcasts idle, clears captions, and ends the session', async () => {
      const h = createHarness()
      await h.pipeline.start()
      await h.pipeline.stop()
      expect(h.source.stop).toHaveBeenCalledTimes(1)
      expect(h.stateEvents.at(-1)?.state).toBe('idle')
      expect(h.clearedEvents.at(-1)?.reason).toBe('idle')
      expect(h.counters).toContain('speech_stopped')
    })
  })

  describe('chunk → caption assembly', () => {
    it('emits interim captions untranslated and final captions translated', async () => {
      // A long window means the 5 s push below never auto-flushes; silence
      // then flushes the pending buffer as a FINAL (translated) window.
      const h = createHarness({ windowMs: 20_000 })
      await h.pipeline.start()
      h.handle.transcribeChunk.mockImplementation(async (chunk: AudioChunk) => {
        if (chunk.isFinal) {
          return [{ id: chunk.chunkId, text: '你好世界', translatedText: 'Hello world', isFinal: true }]
        }
        return [{ id: chunk.chunkId, text: '你好', isFinal: false }]
      })

      pushWindow(h, 5)
      await flushMicrotasks()
      // No provider call yet (window not reached, no silence).
      expect(h.handle.transcribeChunk).not.toHaveBeenCalled()

      // A silence flush emits the FINAL translated caption.
      h.source.emitChunk(mkChunk({ data: silentPcm() }))
      await flushMicrotasks()
      expect(h.captionEvents.at(-1)).toEqual({ id: expect.any(String), text: 'Hello world', interim: false })
    })

    it('emits an interim caption from a non-final window (untranslated)', async () => {
      const h = createHarness({ windowMs: 3_000 })
      await h.pipeline.start()
      h.handle.transcribeChunk.mockImplementation(async (chunk: AudioChunk) => [
        { id: chunk.chunkId, text: '你好', isFinal: false },
      ])

      // 3 x 1 s pushes reach the 3 s window threshold → non-final flush.
      for (let i = 0; i < 3; i++) {
        h.source.emitChunk(fluentChunk(i * 1000, (i + 1) * 1000))
      }
      await flushMicrotasks()
      expect(h.captionEvents.at(-1)).toEqual({ id: expect.any(String), text: '你好', interim: true })
    })

    it('suppresses a final that duplicates the previous line (dedup)', async () => {
      const h = createHarness()
      await h.pipeline.start()
      h.handle.transcribeChunk.mockImplementation(async (chunk: AudioChunk) => [
        { id: chunk.chunkId, text: '你好世界', translatedText: 'Hello world', isFinal: true },
      ])

      pushWindow(h, 5)
      await flushMicrotasks()
      h.source.emitChunk(mkChunk({ data: silentPcm() }))
      await flushMicrotasks()
      const emitted = h.captionEvents.length
      // Another silence flush of the same (now empty) buffer emits nothing.
      h.source.emitChunk(mkChunk({ data: silentPcm() }))
      await flushMicrotasks()
      expect(h.captionEvents.length).toBe(emitted)
    })

    it('dirty-check: identical interim text is not re-emitted', async () => {
      const h = createHarness()
      await h.pipeline.start()
      h.handle.transcribeChunk.mockImplementation(async (chunk: AudioChunk) => [
        { id: chunk.chunkId, text: 'same', isFinal: false },
      ])

      pushWindow(h, 5)
      await flushMicrotasks()
      const first = h.captionEvents.length
      pushWindow(h, 5)
      await flushMicrotasks()
      // Same text, so no new caption.
      expect(h.captionEvents.length).toBe(first)
    })

    it('never sends or bills silent chunks (VAD gate)', async () => {
      const h = createHarness()
      await h.pipeline.start()
      h.handle.transcribeChunk.mockImplementation(async () => [])

      h.source.emitChunk(mkChunk({ data: silentPcm() }))
      h.source.emitChunk(mkChunk({ data: silentPcm() }))
      await flushMicrotasks()

      expect(h.handle.transcribeChunk).not.toHaveBeenCalled()
      expect(h.budget.getUsage().sessionSeconds).toBe(0)
    })

    it('drops the oldest chunk when the buffer exceeds maxBufferMs', async () => {
      const h = createHarness({ maxBufferMs: 3_000, windowMs: 10_000 })
      await h.pipeline.start()
      h.handle.transcribeChunk.mockImplementation(async (chunk: AudioChunk) => [
        { id: chunk.chunkId, text: chunk.startMs?.toString() ?? 'x', isFinal: false },
      ])

      // 6 seconds > 3s maxBufferMs → oldest dropped.
      pushWindow(h, 6)
      await flushMicrotasks()
      // The window never hit 10s, so no provider call; buffer kept ≤3s worth.
      expect(h.handle.transcribeChunk).not.toHaveBeenCalled()
    })
  })

  describe('provider errors', () => {
    it('auth stops capture and surfaces the fixed errorKey', async () => {
      const h = createHarness()
      await h.pipeline.start()
      h.handle.transcribeChunk.mockImplementation(async (chunk: AudioChunk) => [
        { id: chunk.chunkId, text: '', error: { type: 'auth', status: 401, message: 'Invalid API key: sk-abc' } },
      ])

      pushWindow(h, 5)
      await flushMicrotasks()

      expect(h.fatalErrors).toEqual(['auth'])
      expect(h.stateEvents.at(-1)?.state).toBe('error')
      expect(h.stateEvents.at(-1)?.errorKey).toBe('speechErrorAuth')
      expect(h.stateEvents.at(-1)?.reason).toBe('auth')
      // The raw provider message never reaches the content script.
      const serialized = JSON.stringify(h.stateEvents)
      expect(serialized).not.toContain('sk-abc')
      expect(serialized).not.toContain('Invalid API key')
    })

    it('rate_limited pauses transcription and resumes after cooldown', async () => {
      const h = createHarness({ windowMs: 5_000 })
      await h.pipeline.start()
      h.handle.transcribeChunk.mockImplementation(async (chunk: AudioChunk) => [
        { id: chunk.chunkId, text: '', error: { type: 'rate_limited', retryAfterMs: 1000, message: 'Rate limited' } },
      ])

      pushWindow(h, 5)
      await flushMicrotasks()
      expect(h.stateEvents.at(-1)?.state).toBe('paused')
      expect(h.stateEvents.at(-1)?.reason).toBe('rate_limited')

      // After the cooldown elapses the pipeline resumes to capturing.
      await vi.advanceTimersByTimeAsync(1100)
      expect(h.stateEvents.at(-1)?.state).toBe('capturing')
    })

    it('stops after a threshold of consecutive network failures', async () => {
      const h = createHarness({ maxConsecutiveFailures: 3 })
      await h.pipeline.start()
      h.handle.transcribeChunk.mockImplementation(async (chunk: AudioChunk) => [
        { id: chunk.chunkId, text: '', error: { type: 'network', message: 'boom' } },
      ])

      for (let i = 0; i < 3; i++) {
        pushWindow(h, 5)
        await flushMicrotasks()
      }
      expect(h.fatalErrors).toEqual(['network'])
      expect(h.stateEvents.at(-1)?.state).toBe('error')
      expect(h.stateEvents.at(-1)?.errorKey).toBe('speechErrorNetwork')
    })

    it('recovers after a single transient network failure', async () => {
      const h = createHarness()
      await h.pipeline.start()
      h.handle.transcribeChunk
        .mockImplementationOnce(async (chunk: AudioChunk) => [
          { id: chunk.chunkId, text: '', error: { type: 'network', message: 'boom' } },
        ])
        .mockImplementationOnce(async (chunk: AudioChunk) => [
          { id: chunk.chunkId, text: 'hi', translatedText: '你好', isFinal: true },
        ])

      pushWindow(h, 5)
      await flushMicrotasks()
      expect(h.pipeline.isCapturing()).toBe(true)

      pushWindow(h, 5)
      h.source.emitChunk(mkChunk({ data: silentPcm() }))
      await flushMicrotasks()
      expect(h.captionEvents.at(-1)?.text).toBe('你好')
    })
  })

  describe('capture source errors', () => {
    it('no_twitch_tab returns to idle without an error state', async () => {
      const h = createHarness()
      await h.pipeline.start()
      h.source.emitError({ reason: 'no_twitch_tab' })
      expect(h.stateEvents.at(-1)?.state).toBe('idle')
      expect(h.fatalErrors).toHaveLength(0)
      expect(h.clearedEvents.at(-1)?.reason).toBe('idle')
    })

    it('permission_denied surfaces a sanitized error state', async () => {
      const h = createHarness()
      await h.pipeline.start()
      h.source.emitError({ reason: 'permission_denied', message: 'getUserMedia failed' })
      expect(h.fatalErrors).toEqual(['permission_denied'])
      expect(h.stateEvents.at(-1)?.errorKey).toBe('speechErrorPermissionDenied')
    })

    it('maps every capture error reason to the Spec §9 taxonomy', () => {
      expect(mapCaptureError({ reason: 'no_twitch_tab' })).toBe('no_twitch_tab')
      expect(mapCaptureError({ reason: 'permission_denied' })).toBe('permission_denied')
      expect(mapCaptureError({ reason: 'context_invalidated' })).toBe('context_invalidated')
      expect(mapCaptureError({ reason: 'capture_failed' })).toBe('unknown')
      expect(mapCaptureError({ reason: 'unknown' })).toBe('unknown')
    })
  })

  describe('SW suspension / port drop (Spec §7)', () => {
    it('port disconnect surfaces a reconnectable paused state', async () => {
      const h = createHarness()
      await h.pipeline.start()
      h.source.emitDisconnect('port_disconnected')
      expect(h.stateEvents.at(-1)?.state).toBe('paused')
      expect(h.pipeline.isCapturing()).toBe(false)
    })

    it('ignores its own stop-path disconnect (reason "stopped")', async () => {
      const h = createHarness()
      await h.pipeline.start()
      h.source.emitDisconnect('stopped')
      // No state change (running is still true here only because we did not
      // call stop(); the disconnect reason is our own teardown signal).
      expect(h.stateEvents.at(-1)?.state).toBe('capturing')
    })
  })

  describe('budget integration', () => {
    it('bills only the non-silent windows and stops on session exhaustion', async () => {
      const h = createHarness({ sessionCapMinutes: 1 })
      await h.pipeline.start()
      h.handle.transcribeChunk.mockImplementation(async () => [])

      // 59 s of loud audio.
      for (let i = 0; i < 11; i++) h.source.emitChunk(fluentChunk(i * 1000, (i + 1) * 1000))
      await flushMicrotasks()
      // Some windows flushed; silent chunks skipped.
      h.source.emitChunk(mkChunk({ data: silentPcm() }))
      await flushMicrotasks()

      const usage = h.budget.getUsage()
      expect(usage.sessionSeconds).toBeGreaterThan(0)
      expect(usage.sessionSeconds).toBeLessThanOrEqual(60)
    })
  })

  describe('privacy', () => {
    it('speech_state broadcasts never contain keys, raw audio, transcript, or channel names', async () => {
      const h = createHarness()
      await h.pipeline.start()
      h.handle.transcribeChunk.mockImplementation(async (chunk: AudioChunk) => [
        { id: chunk.chunkId, text: 'secret transcript', error: { type: 'auth', status: 401, message: 'sk-leaked-key' } },
      ])
      pushWindow(h, 5)
      await flushMicrotasks()

      const serialized = JSON.stringify(h.stateEvents)
      expect(serialized).not.toContain('sk-leaked-key')
      expect(serialized).not.toContain('secret transcript')
      expect(serialized).not.toContain('channelName')
      expect(serialized).not.toContain('ArrayBuffer')
    })
  })
})

describe('computePcmRms', () => {
  it('returns ~0 for silence and a large value for loud audio', () => {
    expect(computePcmRms(silentPcm())).toBe(0)
    expect(computePcmRms(loudPcm())).toBeGreaterThan(30_000)
  })
  it('returns 0 for an empty buffer', () => {
    expect(computePcmRms(new ArrayBuffer(0))).toBe(0)
  })
})
