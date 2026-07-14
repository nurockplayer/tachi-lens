import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProviderId, type TranslationProvider } from '@/providers/types'
import { createGeminiProvider } from '@/providers/gemini'
import { TranslationCache } from './cache'
import type { Clock } from './clock'
import { RateLimiter } from './rate-limiter'
import {
  DEFAULT_GEMINI_QUOTA,
  getGeminiProviderDayId,
  GeminiQuotaStore,
  type QuotaStorage,
} from './gemini-quota'
import { QuotaScheduler } from './quota-scheduler'
import { type TranslatorDependencies, Translator } from './translator'

const createMockProvider = (id: ProviderId = 'deepseek'): TranslationProvider => ({
  id,
  displayName: id === 'gemini' ? 'Gemini' : 'DeepSeek',
  models: [],
  defaultModel: 'deepseek-v4-flash',
  translateBatch: vi.fn<TranslationProvider['translateBatch']>(),
  validateKey: vi.fn(),
})

const defaultDeps = (overrides?: Partial<TranslatorDependencies>): TranslatorDependencies => ({
  cache: new TranslationCache(100),
  rateLimiter: new RateLimiter({ maxBackoffMs: 60000 }),
  getSettings: vi.fn(async () => ({
    selectedProvider: 'deepseek' as ProviderId,
    selectedModel: 'deepseek-v4-flash',
    targetLanguage: 'zh-TW',
  })),
  getApiKey: vi.fn(async () => 'test-api-key'),
  getProvider: vi.fn(() => createMockProvider()),
  ...overrides,
})

const createQuotaScheduler = (deepseekMaxConcurrency = 2): QuotaScheduler => {
  const session: Record<string, unknown> = {}
  const local: Record<string, unknown> = {}
  const storage: QuotaStorage = {
    getSession: async () => session,
    setSession: async (value) => { Object.assign(session, value) },
    getLocal: async () => local,
    setLocal: async (value) => { Object.assign(local, value) },
  }
  return new QuotaScheduler(new GeminiQuotaStore(storage), { deepseekMaxConcurrency })
}

describe('Translator', () => {
  let deps: TranslatorDependencies
  let translator: Translator

  beforeEach(() => {
    vi.useFakeTimers()
    deps = defaultDeps()
    translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 10 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('batching', () => {
    it('resolves a single translation request after debounce', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([
        { id: 'msg1', translatedText: '你好' },
      ])
      deps.getProvider = vi.fn(() => provider)

      const resultPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })

      vi.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result.messageId).toBe('msg1')
      expect(result.translatedText).toBe('你好')
    })

    it('flushes immediately when max batch size is reached', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
        requests.map((r) => ({ id: r.id, translatedText: `trans-${r.text}` })),
      )
      deps.getProvider = vi.fn(() => provider)

      const promises = Array.from({ length: 10 }, (_, i) =>
        translator.translate({ messageId: `msg${i}`, text: `text${i}` }),
      )
      const results = await Promise.all(promises)

      expect(provider.translateBatch).toHaveBeenCalledTimes(1)
      expect(results).toHaveLength(10)
      expect(results[0]!.translatedText).toBe('trans-text0')
      expect(results[9]!.translatedText).toBe('trans-text9')
    })

    it('batches multiple requests within the same debounce window', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
        requests.map((r) => ({ id: r.id, translatedText: `T-${r.text}` })),
      )
      deps.getProvider = vi.fn(() => provider)

      const promise1 = translator.translate({ messageId: 'msg1', text: 'one' })
      const promise2 = translator.translate({ messageId: 'msg2', text: 'two' })
      vi.advanceTimersByTime(150)

      const [result1, result2] = await Promise.all([promise1, promise2])
      expect(provider.translateBatch).toHaveBeenCalledTimes(1)
      expect(result1.translatedText).toBe('T-one')
      expect(result2.translatedText).toBe('T-two')
    })

    it('passes correct arguments to the provider', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([
        { id: 'msg1', translatedText: 'Hello' },
      ])
      deps.getProvider = vi.fn(() => provider)

      translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      await vi.waitFor(() => {
        expect(provider.translateBatch).toHaveBeenCalledTimes(1)
      })

      const callArgs = vi.mocked(provider.translateBatch).mock.calls[0]!
      expect(callArgs[0]).toEqual([{ id: 'msg1', text: 'Hello', sourceLang: undefined }])
      expect(callArgs[1]).toBe('test-api-key')
      expect(callArgs[2]).toBe('deepseek-v4-flash')
      expect(callArgs[3]).toBe('zh-TW')
    })

    it('passes sourceLang through to translateBatch when provided', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([
        { id: 'msg1', translatedText: 'Hello' },
      ])
      deps.getProvider = vi.fn(() => provider)

      translator.translate({ messageId: 'msg1', text: 'Hello', sourceLang: 'en' })
      vi.advanceTimersByTime(150)
      await vi.waitFor(() => {
        expect(provider.translateBatch).toHaveBeenCalledTimes(1)
      })

      const requests = vi.mocked(provider.translateBatch).mock.calls[0]![0]
      expect(requests[0]!.sourceLang).toBe('en')
    })

    it('separates mixed live and backlog input and dispatches live first', async () => {
      const provider = createMockProvider('deepseek')
      vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: request.id })),
      )
      deps.getProvider = vi.fn(() => provider)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 10 })

      const backlog = translator.translate({ messageId: 'backlog', text: 'old', priority: 'backlog' })
      const live = translator.translate({ messageId: 'live', text: 'new', priority: 'live' })
      await vi.advanceTimersByTimeAsync(150)
      await vi.advanceTimersByTimeAsync(150)
      await Promise.all([backlog, live])

      expect(provider.translateBatch).toHaveBeenCalledTimes(2)
      expect(vi.mocked(provider.translateBatch).mock.calls[0]![0].map((request) => request.id)).toEqual(['live'])
      expect(vi.mocked(provider.translateBatch).mock.calls[1]![0].map((request) => request.id)).toEqual(['backlog'])
    })

    it('services backlog after at most three live batches while live input continues', async () => {
      const provider = createMockProvider('deepseek')
      vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: request.id })),
      )
      deps.getProvider = vi.fn(() => provider)
      deps.quotaScheduler = createQuotaScheduler(20)
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 2 })

      const pending = [translator.translate({ messageId: 'backlog', text: 'old', priority: 'backlog' })]
      for (let index = 0; index < 8; index++) {
        pending.push(translator.translate({
          messageId: `live-${index}`,
          text: `new-${index}`,
          priority: 'live',
        }))
      }

      await vi.waitFor(() => expect(provider.translateBatch).toHaveBeenCalledTimes(4))
      const firstFourBatches = vi.mocked(provider.translateBatch).mock.calls
        .slice(0, 4)
        .map(([requests]) => requests.map((request) => request.id))

      expect(firstFourBatches).toEqual([
        ['live-0', 'live-1'],
        ['live-2', 'live-3'],
        ['live-4', 'live-5'],
        ['backlog'],
      ])

      await vi.advanceTimersByTimeAsync(150)
      await expect(Promise.all(pending)).resolves.toHaveLength(9)
    })

    it('services scheduler backlog after bounded live work releases provider capacity', async () => {
      let releaseFirst!: () => void
      const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })
      const provider = createMockProvider('deepseek')
      vi.mocked(provider.translateBatch).mockImplementation(async (requests) => {
        if (requests[0]?.id === 'holder') await firstHeld
        return requests.map((request) => ({ id: request.id, translatedText: request.id }))
      })
      deps.getProvider = vi.fn(() => provider)
      deps.quotaScheduler = createQuotaScheduler(1)
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const holder = translator.translate({ messageId: 'holder', text: 'holder', priority: 'live' })
      await vi.waitFor(() => expect(provider.translateBatch).toHaveBeenCalledTimes(1))

      const backlog = translator.translate({ messageId: 'backlog', text: 'old', priority: 'backlog' })
      const live = Array.from({ length: 5 }, (_, index) => translator.translate({
        messageId: `live-${index}`,
        text: `new-${index}`,
        priority: 'live',
      }))
      await vi.advanceTimersByTimeAsync(0)
      releaseFirst()

      await expect(Promise.all([holder, backlog, ...live])).resolves.toHaveLength(7)
      const callOrder = vi.mocked(provider.translateBatch).mock.calls
        .map(([requests]) => requests[0]!.id)

      expect(callOrder.indexOf('backlog')).toBeGreaterThan(0)
      expect(callOrder.indexOf('backlog')).toBeLessThanOrEqual(4)
    })

    it('bounds selected-DeepSeek batches with the shared scheduler capacity', async () => {
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      const provider = createMockProvider('deepseek')
      vi.mocked(provider.translateBatch).mockImplementation(async (requests) => {
        await held
        return requests.map((request) => ({ id: request.id, translatedText: request.id }))
      })
      deps.getProvider = vi.fn(() => provider)
      deps.quotaScheduler = createQuotaScheduler(2)
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const pending = ['a', 'b', 'c'].map((id) => translator.translate({ messageId: id, text: id }))
      await vi.waitFor(() => expect(provider.translateBatch).toHaveBeenCalledTimes(2))
      expect(provider.translateBatch).toHaveBeenCalledTimes(2)

      release()
      await expect(Promise.all(pending)).resolves.toHaveLength(3)
      expect(provider.translateBatch).toHaveBeenCalledTimes(3)
    })

    it('uses the selected Gemini model quota profile on the production scheduler path', async () => {
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: `g-${request.id}` })),
      )
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: `d-${request.id}` })),
      )
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-pro',
        targetLanguage: 'zh-TW',
        geminiQuota: {
          ...DEFAULT_GEMINI_QUOTA,
          requestsPerMinute: 100,
          rpmSafetyPercent: 100,
          maxConcurrency: 10,
        },
        geminiQuotaProfiles: {
          'gemini-2.5-flash': {
            ...DEFAULT_GEMINI_QUOTA,
            requestsPerMinute: 100,
            rpmSafetyPercent: 100,
            maxConcurrency: 10,
          },
          'gemini-2.5-pro': {
            ...DEFAULT_GEMINI_QUOTA,
            requestsPerMinute: 1,
            rpmSafetyPercent: 100,
            maxConcurrency: 10,
          },
        },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const results = await Promise.all([
        translator.translate({ messageId: 'first', text: 'one', priority: 'backlog' }),
        translator.translate({ messageId: 'second', text: 'two', priority: 'backlog' }),
      ])

      expect(results).toEqual([
        { messageId: 'first', translatedText: 'g-first' },
        { messageId: 'second', translatedText: 'd-second' },
      ])
      expect(gemini.translateBatch).toHaveBeenCalledTimes(1)
      expect(deepseek.translateBatch).toHaveBeenCalledTimes(1)
    })

    it('preserves retryable Gemini quota result when scheduler denies and DeepSeek fallback returns auth', async () => {
      let now = Date.UTC(2026, 6, 14, 12)
      const session: Record<string, unknown> = {}
      const local: Record<string, unknown> = {}
      const storage: QuotaStorage = {
        getSession: async () => session,
        setSession: async (value) => { Object.assign(session, value) },
        getLocal: async () => local,
        setLocal: async (value) => { Object.assign(local, value) },
      }
      const quota = new GeminiQuotaStore(storage, () => now)
      const rpmProfile = {
        ...DEFAULT_GEMINI_QUOTA,
        requestsPerMinute: 1,
        rpmSafetyPercent: 100,
        inputTokensPerMinute: 1_000_000,
        tpmSafetyPercent: 100,
        requestsPerDay: 100,
        rpdSafetyPercent: 100,
        liveMaxWaitMs: 1_000,
        maxConcurrency: 10,
      }
      // Pre-fill the single RPM slot for the model's quotaKey.
      await quota.reserve(rpmProfile, 1, 'gemini-2.5-pro')

      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(deepseek.translateBatch).mockImplementation(async () =>
        [{ id: 'quota-denied', error: 'DeepSeek auth error', errorType: 'auth' as const }],
      )
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-pro',
        targetLanguage: 'zh-TW',
        geminiQuotaProfiles: {
          'gemini-2.5-pro': rpmProfile,
        },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = new QuotaScheduler(quota, { now: () => now })
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 2 })

      const translatePromise = translator.translate({ messageId: 'quota-denied', text: 'hello', priority: 'backlog' })
      await vi.advanceTimersByTimeAsync(150)
      await vi.waitFor(() => expect(deepseek.translateBatch).toHaveBeenCalledTimes(1))

      const result = await translatePromise
      expect(result.error?.type).toBe('rate_limited')
      expect(result.messageId).toBe('quota-denied')
      expect(gemini.translateBatch).not.toHaveBeenCalled()
      expect(deepseek.translateBatch).toHaveBeenCalledTimes(1)
    })

    it('preserves DeepSeek fallback success when Gemini is quota-denied', async () => {
      let now = Date.UTC(2026, 6, 14, 12)
      const session: Record<string, unknown> = {}
      const local: Record<string, unknown> = {}
      const storage: QuotaStorage = {
        getSession: async () => session,
        setSession: async (value) => { Object.assign(session, value) },
        getLocal: async () => local,
        setLocal: async (value) => { Object.assign(local, value) },
      }
      const quota = new GeminiQuotaStore(storage, () => now)
      const rpmProfile = {
        ...DEFAULT_GEMINI_QUOTA,
        requestsPerMinute: 1,
        rpmSafetyPercent: 100,
        inputTokensPerMinute: 1_000_000,
        tpmSafetyPercent: 100,
        requestsPerDay: 100,
        rpdSafetyPercent: 100,
        liveMaxWaitMs: 1_000,
        maxConcurrency: 10,
      }
      await quota.reserve(rpmProfile, 1, 'gemini-2.5-pro')

      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: `d-${request.text}` })),
      )
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-pro',
        targetLanguage: 'zh-TW',
        geminiQuotaProfiles: {
          'gemini-2.5-pro': rpmProfile,
        },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = new QuotaScheduler(quota, { now: () => now })
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 2 })

      const translatePromise = translator.translate({ messageId: 'quota-fallback-ok', text: 'hello', priority: 'backlog' })
      await vi.advanceTimersByTimeAsync(150)
      await vi.waitFor(() => expect(deepseek.translateBatch).toHaveBeenCalledTimes(1))

      const result = await translatePromise
      expect(result.translatedText).toBe('d-hello')
      expect(gemini.translateBatch).not.toHaveBeenCalled()
      expect(deepseek.translateBatch).toHaveBeenCalledTimes(1)
    })

    it('overflows smaller backlog work while a live Gemini batch can still wait for quota', async () => {
      let now = Date.UTC(2026, 6, 14, 12)
      const session: Record<string, unknown> = {}
      const local: Record<string, unknown> = {}
      const storage: QuotaStorage = {
        getSession: async () => session,
        setSession: async (value) => { Object.assign(session, value) },
        getLocal: async () => local,
        setLocal: async (value) => { Object.assign(local, value) },
      }
      const quota = new GeminiQuotaStore(storage, () => now)
      const liveProfile = {
        ...DEFAULT_GEMINI_QUOTA,
        requestsPerMinute: 1,
        rpmSafetyPercent: 100,
        inputTokensPerMinute: 1_000_000,
        tpmSafetyPercent: 100,
        requestsPerDay: 100,
        rpdSafetyPercent: 100,
        liveMaxWaitMs: 1_000,
        maxConcurrency: 2,
      }
      const backlogProfile = {
        ...liveProfile,
        requestsPerMinute: 100,
      }
      await quota.reserve(liveProfile, 1, 'gemini-2.5-flash')
      now += 59_500

      let selectedModel = 'gemini-2.5-flash'
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: `g-${request.id}` })),
      )
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: `d-${request.id}` })),
      )
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel,
        targetLanguage: 'zh-TW',
        geminiQuotaProfiles: {
          'gemini-2.5-flash': liveProfile,
          'gemini-2.5-pro': backlogProfile,
        },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = new QuotaScheduler(quota, { now: () => now })
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 2 })

      const live = Promise.all([
        translator.translate({ messageId: 'live-1', text: 'live one', priority: 'live' }),
        translator.translate({ messageId: 'live-2', text: 'live two', priority: 'live' }),
      ])
      await vi.waitFor(() => expect(deps.getSettings).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(0)

      selectedModel = 'gemini-2.5-pro'
      const backlog = translator.translate({ messageId: 'backlog', text: 'old', priority: 'backlog' })
      await vi.advanceTimersByTimeAsync(150)

      await vi.waitFor(() => expect(deepseek.translateBatch).toHaveBeenCalledTimes(1))
      expect(vi.mocked(deepseek.translateBatch).mock.calls[0]![0].map(({ id }) => id)).toEqual(['backlog'])
      expect(gemini.translateBatch).not.toHaveBeenCalled()

      now += 500
      await vi.advanceTimersByTimeAsync(500)

      await expect(live).resolves.toEqual([
        { messageId: 'live-1', translatedText: 'g-live-1' },
        { messageId: 'live-2', translatedText: 'g-live-2' },
      ])
      await expect(backlog).resolves.toEqual({ messageId: 'backlog', translatedText: 'd-backlog' })
      expect(vi.mocked(gemini.translateBatch).mock.calls[0]![0].map(({ id }) => id))
        .toEqual(['live-1', 'live-2'])
    })

    it('keeps Gemini quota and cooldown state independent for each selected model', async () => {
      let selectedModel = 'gemini-2.5-flash'
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: `g-${request.id}` })),
      )
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: `d-${request.id}` })),
      )
      const perModelProfile = {
        ...DEFAULT_GEMINI_QUOTA,
        requestsPerMinute: 1,
        rpmSafetyPercent: 100,
        requestsPerDay: 100,
        rpdSafetyPercent: 100,
        maxConcurrency: 2,
      }
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel,
        targetLanguage: 'zh-TW',
        geminiQuotaProfiles: {
          'gemini-2.5-flash': perModelProfile,
          'gemini-2.5-pro': perModelProfile,
        },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      await expect(translator.translate({ messageId: 'flash-first', text: 'one', priority: 'backlog' }))
        .resolves.toEqual({ messageId: 'flash-first', translatedText: 'g-flash-first' })
      await expect(translator.translate({ messageId: 'flash-second', text: 'two', priority: 'backlog' }))
        .resolves.toEqual({ messageId: 'flash-second', translatedText: 'd-flash-second' })

      selectedModel = 'gemini-2.5-pro'
      await expect(translator.translate({ messageId: 'pro-first', text: 'three', priority: 'backlog' }))
        .resolves.toEqual({ messageId: 'pro-first', translatedText: 'g-pro-first' })

      expect(gemini.translateBatch).toHaveBeenCalledTimes(2)
      expect(deepseek.translateBatch).toHaveBeenCalledTimes(1)
    })

    it('does not apply one Gemini model cooldown to another model', async () => {
      let selectedModel = 'gemini-2.5-flash'
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockImplementation(async (requests) => requests.map((request) =>
        selectedModel === 'gemini-2.5-flash'
          ? { id: request.id, error: 'Flash limited', status: 429, retryAfterMs: 60_000 }
          : { id: request.id, translatedText: `g-${request.id}` },
      ))
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: `d-${request.id}` })),
      )
      const perModelProfile = {
        ...DEFAULT_GEMINI_QUOTA,
        requestsPerMinute: 100,
        rpmSafetyPercent: 100,
        requestsPerDay: 100,
        rpdSafetyPercent: 100,
      }
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel,
        targetLanguage: 'zh-TW',
        geminiQuotaProfiles: {
          'gemini-2.5-flash': perModelProfile,
          'gemini-2.5-pro': perModelProfile,
        },
      }))
      deps.getApiKey = vi.fn(async (providerId) => `key-${providerId}`)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      await expect(translator.translate({ messageId: 'flash', text: 'one', priority: 'backlog' }))
        .resolves.toEqual({ messageId: 'flash', translatedText: 'd-flash' })
      selectedModel = 'gemini-2.5-pro'
      await expect(translator.translate({ messageId: 'pro', text: 'two', priority: 'backlog' }))
        .resolves.toEqual({ messageId: 'pro', translatedText: 'g-pro' })

      expect(gemini.translateBatch).toHaveBeenCalledTimes(2)
      expect(deepseek.translateBatch).toHaveBeenCalledTimes(1)
    })

    it('bounds simultaneous full Gemini batches with the selected model concurrency profile', async () => {
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockImplementation(async (requests) => {
        await held
        return requests.map((request) => ({ id: request.id, translatedText: `g-${request.id}` }))
      })
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: `d-${request.id}` })),
      )
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-pro',
        targetLanguage: 'zh-TW',
        geminiQuota: { ...DEFAULT_GEMINI_QUOTA, requestsPerMinute: 100, maxConcurrency: 10 },
        geminiQuotaProfiles: {
          'gemini-2.5-pro': {
            ...DEFAULT_GEMINI_QUOTA,
            requestsPerMinute: 100,
            rpmSafetyPercent: 100,
            maxConcurrency: 1,
          },
        },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 2 })

      const pending = ['a', 'b', 'c', 'd'].map((id) => translator.translate({
        messageId: id,
        text: id,
        priority: 'backlog',
      }))
      await vi.waitFor(() => expect(deepseek.translateBatch).toHaveBeenCalledTimes(1))

      expect(gemini.translateBatch).toHaveBeenCalledTimes(1)
      expect(vi.mocked(gemini.translateBatch).mock.calls[0]![0].map(({ id }) => id)).toEqual(['a', 'b'])
      expect(vi.mocked(deepseek.translateBatch).mock.calls[0]![0].map(({ id }) => id)).toEqual(['c', 'd'])

      release()
      await expect(Promise.all(pending)).resolves.toHaveLength(4)
    })

    it('isolates Gemini per-quotaKey across different models', async () => {
      let selectedModel = 'gemini-2.5-flash'
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockImplementation(async (requests) => {
        await held
        return requests.map((request) => ({ id: request.id, translatedText: `g-${request.id}` }))
      })
      const perModelProfile = {
        ...DEFAULT_GEMINI_QUOTA,
        requestsPerMinute: 100,
        rpmSafetyPercent: 100,
        maxConcurrency: 1,
      }
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel,
        targetLanguage: 'zh-TW',
        geminiQuotaProfiles: {
          'gemini-2.5-flash': perModelProfile,
          'gemini-2.5-pro': perModelProfile,
        },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const flash = translator.translate({ messageId: 'flash', text: 'one', priority: 'backlog' })
      await vi.waitFor(() => expect(gemini.translateBatch).toHaveBeenCalledTimes(1))
      selectedModel = 'gemini-2.5-pro'
      const pro = translator.translate({ messageId: 'pro', text: 'two', priority: 'backlog' })
      await vi.waitFor(() => expect(gemini.translateBatch).toHaveBeenCalledTimes(2))

      expect(deepseek.translateBatch).not.toHaveBeenCalled()
      release()
      await expect(Promise.all([flash, pro])).resolves.toHaveLength(2)
    })

    it('does not let another model bypass saturated Gemini provider capacity', async () => {
      let selectedModel = 'gemini-2.5-flash'
      let releaseFlash!: () => void
      const heldFlash = new Promise<void>((resolve) => { releaseFlash = resolve })
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockImplementation(async (requests, _key, model) => {
        if (model === 'gemini-2.5-flash') await heldFlash
        return requests.map((request) => ({ id: request.id, translatedText: `g-${request.id}` }))
      })
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: `d-${request.id}` })),
      )
      const perModelProfile = {
        ...DEFAULT_GEMINI_QUOTA,
        requestsPerMinute: 100,
        rpmSafetyPercent: 100,
        maxConcurrency: 1,
        liveMaxWaitMs: 1_000,
      }
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel,
        targetLanguage: 'zh-TW',
        geminiQuotaProfiles: {
          'gemini-2.5-flash': perModelProfile,
          'gemini-2.5-pro': perModelProfile,
        },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const flashHolder = translator.translate({ messageId: 'flash-holder', text: 'one', priority: 'live' })
      await vi.waitFor(() => expect(gemini.translateBatch).toHaveBeenCalledTimes(1))
      selectedModel = 'gemini-2.5-pro'
      const pro = translator.translate({ messageId: 'pro', text: 'three', priority: 'live' })
      await vi.waitFor(() => expect(gemini.translateBatch).toHaveBeenCalledTimes(2))

      expect(deepseek.translateBatch).not.toHaveBeenCalled()

      releaseFlash()
      await expect(Promise.all([flashHolder, pro])).resolves.toHaveLength(2)
    })

    it('rechecks live priority when backlog quota denial persistence finishes', async () => {
      const now = Date.UTC(2026, 6, 13, 12)
      const local: Record<string, unknown> = {
        quotaVersion: 3,
        wallHighWaterMark: now,
        clockTrusted: true,
        buckets: {
          'gemini-2.5-flash': {
            reservations: [],
            cooldownUntil: 0,
            providerDay: getGeminiProviderDayId(now),
            requestsToday: 1,
          },
        },
      }
      const session: Record<string, unknown> = {}
      let releaseFirstWrite!: () => void
      const firstWriteHeld = new Promise<void>((resolve) => { releaseFirstWrite = resolve })
      let writes = 0
      const storage: QuotaStorage = {
        getSession: async () => session,
        setSession: async (value) => { Object.assign(session, value) },
        getLocal: async () => local,
        setLocal: async (value) => {
          if (writes++ === 0) await firstWriteHeld
          Object.assign(local, value)
        },
      }
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: `d-${request.id}` })),
      )
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
        geminiQuota: {
          ...DEFAULT_GEMINI_QUOTA,
          requestsPerMinute: 100,
          rpmSafetyPercent: 100,
          requestsPerDay: 1,
          rpdSafetyPercent: 100,
        },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = new QuotaScheduler(new GeminiQuotaStore(storage, () => now), { now: () => now })
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const backlog = translator.translate({ messageId: 'backlog', text: 'old', priority: 'backlog' })
      await vi.waitFor(() => expect(writes).toBe(1))
      const live = translator.translate({ messageId: 'live', text: 'new', priority: 'live' })
      releaseFirstWrite()

      await expect(Promise.all([backlog, live])).resolves.toHaveLength(2)
      expect(vi.mocked(deepseek.translateBatch).mock.calls.map(([requests]) => requests[0]!.id))
        .toEqual(['live', 'backlog'])
      expect(gemini.translateBatch).not.toHaveBeenCalled()
    })
  })

  describe('cache integration', () => {
    it('returns cached result without calling the provider', async () => {
      const provider = createMockProvider()
      deps.getProvider = vi.fn(() => provider)
      deps.cache.set('Hello|zh-TW|deepseek|deepseek-v4-flash', {
        id: 'msg1',
        translatedText: '你好',
      })

      const resultPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result.translatedText).toBe('你好')
      expect(provider.translateBatch).not.toHaveBeenCalled()
    })

    it('returns a selected-Gemini cache hit without creating a quota reservation', async () => {
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      const quotaStorage: QuotaStorage = {
        getSession: async () => ({}),
        setSession: async () => undefined,
        getLocal: async () => ({}),
        setLocal: async () => undefined,
      }
      const quota = new GeminiQuotaStore(quotaStorage)
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = new QuotaScheduler(quota)
      deps.cache.set('Hello|zh-TW|gemini|gemini-2.5-flash', {
        id: 'cached-id',
        translatedText: '你好',
      })
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      await expect(translator.translate({ messageId: 'message', text: 'Hello' }))
        .resolves.toEqual({ messageId: 'message', translatedText: '你好' })
      await expect(quota.getUsage()).resolves.toMatchObject({
        rollingRequests: 0,
        rollingInputTokens: 0,
        requestsToday: 0,
      })
      expect(gemini.translateBatch).not.toHaveBeenCalled()
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })

    it('caches new results after an API call', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([
        { id: 'msg1', translatedText: '你好' },
      ])
      deps.getProvider = vi.fn(() => provider)

      const promise1 = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      await promise1

      const promise2 = translator.translate({ messageId: 'msg2', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result2 = await promise2

      expect(result2.translatedText).toBe('你好')
      expect(result2.messageId).toBe('msg2')
      expect(provider.translateBatch).toHaveBeenCalledTimes(1)
    })

    it('stores batch result in cache for future lookups', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([
        { id: 'msg1', translatedText: '你好' },
      ])
      deps.getProvider = vi.fn(() => provider)

      const promise1 = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      await promise1

      expect(deps.cache.has('Hello|zh-TW|deepseek|deepseek-v4-flash')).toBe(true)
    })

    it('does not cache error results', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([
        { id: 'msg1', error: 'API error' },
      ])
      deps.getProvider = vi.fn(() => provider)

      const promise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      await promise

      expect(deps.cache.has('Hello|zh-TW|deepseek|deepseek-v4-flash')).toBe(false)
    })

    it('coalesces concurrent identical translations through one scheduler provider call', async () => {
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockImplementation(async (requests) => {
        await held
        return requests.map((request) => ({ id: request.id, translatedText: '你好' }))
      })
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
        geminiQuota: { ...DEFAULT_GEMINI_QUOTA, maxConcurrency: 2 },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      let settlements = 0
      const first = translator.translate({ messageId: 'first', text: 'Hello' }).then((result) => {
        settlements++
        return result
      })
      const second = translator.translate({ messageId: 'second', text: 'Hello' }).then((result) => {
        settlements++
        return result
      })

      await vi.waitFor(() => expect(gemini.translateBatch).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(0)
      expect(gemini.translateBatch).toHaveBeenCalledTimes(1)

      release()
      await expect(Promise.all([first, second])).resolves.toEqual([
        { messageId: 'first', translatedText: '你好' },
        { messageId: 'second', translatedText: '你好' },
      ])
      expect(settlements).toBe(2)
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })

    it('does not coalesce identical text with different source languages', async () => {
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockImplementation(async (requests) => {
        await held
        return requests.map((request) => ({ id: request.id, translatedText: request.sourceLang! }))
      })
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
        geminiQuota: {
          ...DEFAULT_GEMINI_QUOTA,
          requestsPerMinute: 100,
          rpmSafetyPercent: 100,
          maxConcurrency: 2,
        },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const english = translator.translate({ messageId: 'english', text: 'same', sourceLang: 'en' })
      const japanese = translator.translate({ messageId: 'japanese', text: 'same', sourceLang: 'ja' })

      await vi.waitFor(() => expect(gemini.translateBatch).toHaveBeenCalledTimes(2))
      release()

      await expect(Promise.all([english, japanese])).resolves.toEqual([
        { messageId: 'english', translatedText: 'en' },
        { messageId: 'japanese', translatedText: 'ja' },
      ])
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })

    it('does not coalesce live work behind an identical hung backlog translation', async () => {
      let releaseBacklog!: () => void
      const backlogHeld = new Promise<void>((resolve) => { releaseBacklog = resolve })
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockImplementation(async (requests) => {
        await backlogHeld
        return requests.map((request) => ({ id: request.id, translatedText: 'backlog-result' }))
      })
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: 'live-overflow' })),
      )
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
        geminiQuota: { ...DEFAULT_GEMINI_QUOTA, liveMaxWaitMs: 1_000 },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const backlog = translator.translate({ messageId: 'backlog', text: 'same', priority: 'backlog' })
      await vi.waitFor(() => expect(gemini.translateBatch).toHaveBeenCalledTimes(1))

      let liveSettled = false
      const live = translator.translate({ messageId: 'live', text: 'same', priority: 'live' }).then((result) => {
        liveSettled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(liveSettled).toBe(true)
      await expect(live).resolves.toEqual({ messageId: 'live', translatedText: 'live-overflow' })
      expect(deepseek.translateBatch).toHaveBeenCalledTimes(1)

      releaseBacklog()
      await expect(backlog).resolves.toEqual({ messageId: 'backlog', translatedText: 'backlog-result' })
    })

    it('coalesces backlog work behind an identical in-flight live translation', async () => {
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockImplementation(async (requests) => {
        await held
        return requests.map((request) => ({ id: request.id, translatedText: 'shared-live-result' }))
      })
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
        geminiQuota: { ...DEFAULT_GEMINI_QUOTA, maxConcurrency: 2 },
      }))
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const live = translator.translate({ messageId: 'live-leader', text: 'same', priority: 'live' })
      await vi.waitFor(() => expect(gemini.translateBatch).toHaveBeenCalledTimes(1))
      const backlog = translator.translate({ messageId: 'backlog-follower', text: 'same', priority: 'backlog' })
      await vi.advanceTimersByTimeAsync(0)

      expect(gemini.translateBatch).toHaveBeenCalledTimes(1)
      release()
      await expect(Promise.all([live, backlog])).resolves.toEqual([
        { messageId: 'live-leader', translatedText: 'shared-live-result' },
        { messageId: 'backlog-follower', translatedText: 'shared-live-result' },
      ])
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('resolves with auth error when no API key is available', async () => {
      const provider = createMockProvider()
      deps.getProvider = vi.fn(() => provider)
      deps.getApiKey = vi.fn(async () => undefined)

      const resultPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result.messageId).toBe('msg1')
      expect(result.error).toBeDefined()
      expect(result.error!.type).toBe('auth')
    })

    it('resolves with error when translateBatch throws', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockRejectedValue(new Error('Network failure'))
      deps.getProvider = vi.fn(() => provider)

      const resultPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result.messageId).toBe('msg1')
      expect(result.error).toBeDefined()
      expect(result.error!.type).toBe('network')
    })

    it('resolves with error when provider is not registered', async () => {
      deps.getProvider = vi.fn(() => undefined)

      const resultPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result.messageId).toBe('msg1')
      expect(result.error).toBeDefined()
    })

    it('handles partial failure within a batch', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([
        { id: 'msg1', translatedText: '你好' },
        { id: 'msg2', error: 'Could not translate' },
      ])
      deps.getProvider = vi.fn(() => provider)

      const promise1 = translator.translate({ messageId: 'msg1', text: 'Hello' })
      const promise2 = translator.translate({ messageId: 'msg2', text: 'World' })
      vi.advanceTimersByTime(150)

      const [result1, result2] = await Promise.all([promise1, promise2])
      expect(result1.translatedText).toBe('你好')
      expect(result1.error).toBeUndefined()
      expect(result2.translatedText).toBeUndefined()
      expect(result2.error).toBeDefined()
    })

    it('handles a missing item in the batch response', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
        requests
          .filter((r) => r.id === 'msg1')
          .map((r) => ({ id: r.id, translatedText: `T-${r.text}` })),
      )
      deps.getProvider = vi.fn(() => provider)

      const promise1 = translator.translate({ messageId: 'msg1', text: 'Hello' })
      const promise2 = translator.translate({ messageId: 'msg2', text: 'World' })
      vi.advanceTimersByTime(150)

      const [result1, result2] = await Promise.all([promise1, promise2])
      expect(result1.translatedText).toBe('T-Hello')
      expect(result2.error).toBeDefined()
      expect(result2.error!.type).toBe('invalid_response')
    })

    it('resolves exactly once when settings storage rejects', async () => {
      deps.getSettings = vi.fn(async () => { throw new Error('settings unavailable') })
      let settlements = 0
      const result = translator.translate({ messageId: 'msg1', text: 'Hello' }).then((value) => {
        settlements++
        return value
      })

      await vi.advanceTimersByTimeAsync(150)

      await expect(result).resolves.toMatchObject({
        messageId: 'msg1',
        error: { type: 'network', message: 'settings unavailable' },
      })
      expect(settlements).toBe(1)
    })

    it('returns an actionable auth error when Gemini and DeepSeek keys are both missing', async () => {
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async () => undefined)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 10 })

      const result = translator.translate({ messageId: 'msg1', text: 'Hello' })
      await vi.advanceTimersByTimeAsync(150)

      await expect(result).resolves.toMatchObject({ error: { type: 'auth' } })
      expect(gemini.translateBatch).not.toHaveBeenCalled()
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })

    it('preserves structured Gemini 429 metadata when scheduler fallback lacks a DeepSeek key', async () => {
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockResolvedValue([
        { id: 'msg1', error: 'Gemini quota exhausted', status: 429, retryAfterMs: 57_000 },
      ])
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => providerId === 'gemini' ? 'gemini-key' : undefined)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 10 })

      const result = translator.translate({ messageId: 'msg1', text: 'Hello' })
      await vi.advanceTimersByTimeAsync(150)

      await expect(result).resolves.toMatchObject({
        error: {
          type: 'rate_limited',
          retryAfterMs: 57_000,
          message: expect.stringContaining('Gemini quota exhausted'),
        },
      })
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })

    it.each([
      { fallbackFailure: 'auth' as const },
      { fallbackFailure: 'bad_request' as const },
    ])('preserves the original Gemini 429 when DeepSeek fallback returns $fallbackFailure', async ({ fallbackFailure }) => {
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockResolvedValue([
        { id: 'msg1', error: 'Gemini quota exhausted', status: 429, retryAfterMs: 57_000 },
      ])
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => {
        if (providerId === 'gemini') return 'gemini-key'
        return fallbackFailure === 'auth' ? undefined : 'deepseek-key'
      })
      deps.getProvider = vi.fn((providerId) => {
        if (providerId === 'gemini') return gemini
        return fallbackFailure === 'bad_request' ? undefined : deepseek
      })
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 10 })

      const result = translator.translate({ messageId: 'msg1', text: 'Hello' })
      await vi.advanceTimersByTimeAsync(150)

      await expect(result).resolves.toEqual({
        messageId: 'msg1',
        error: {
          type: 'rate_limited',
          retryAfterMs: 57_000,
          message: 'Gemini quota exhausted',
        },
      })
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })

    it('caches a successful scheduler Gemini 429 fallback exactly once', async () => {
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockResolvedValue([
        { id: 'msg1', error: 'Gemini quota exhausted', status: 429, retryAfterMs: 57_000 },
      ])
      vi.mocked(deepseek.translateBatch).mockResolvedValue([
        { id: 'msg1', translatedText: '你好' },
      ])
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => `key-${providerId}`)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      const cacheSet = vi.spyOn(deps.cache, 'set')
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 10 })

      const result = translator.translate({ messageId: 'msg1', text: 'Hello' })
      await vi.advanceTimersByTimeAsync(150)

      await expect(result).resolves.toEqual({ messageId: 'msg1', translatedText: '你好' })
      expect(cacheSet).toHaveBeenCalledTimes(1)
    })

    it('coalesces identical Gemini 429 fallback work into one provider and cache operation', async () => {
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockImplementation(async (requests) => requests.map((request) => ({
        id: request.id,
        error: 'Gemini quota exhausted',
        status: 429,
        retryAfterMs: 57_000,
      })))
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: '你好' })),
      )
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
        geminiQuota: { ...DEFAULT_GEMINI_QUOTA, maxConcurrency: 2 },
      }))
      deps.getApiKey = vi.fn(async (providerId) => `key-${providerId}`)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()
      const cacheSet = vi.spyOn(deps.cache, 'set')
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const results = await Promise.all([
        translator.translate({ messageId: 'first', text: 'Hello' }),
        translator.translate({ messageId: 'second', text: 'Hello' }),
      ])

      expect(results).toEqual([
        { messageId: 'first', translatedText: '你好' },
        { messageId: 'second', translatedText: '你好' },
      ])
      expect(gemini.translateBatch).toHaveBeenCalledTimes(1)
      expect(deepseek.translateBatch).toHaveBeenCalledTimes(1)
      expect(cacheSet).toHaveBeenCalledTimes(1)
    })

    it('routes production Gemini work to DeepSeek without another fetch while quota state is fail-closed', async () => {
      let wallNow = Date.UTC(2026, 6, 13, 12)
      let monotonicNow = 1_000
      const clock: Clock = {
        wallNow: () => wallNow,
        monotonicNow: () => monotonicNow,
      }
      const local: Record<string, unknown> = {}
      const session: Record<string, unknown> = {}
      const quotaStorage: QuotaStorage = {
        getLocal: async () => local,
        setLocal: async (value) => { Object.assign(local, value) },
        getSession: async () => session,
        setSession: async (value) => { Object.assign(session, value) },
      }
      const quota = new GeminiQuotaStore(quotaStorage, clock)
      const scheduler = new QuotaScheduler(quota, { clock })
      const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{ text: JSON.stringify([{ id: 'before-rollback', translated_text: 'Gemini result' }]) }],
          },
        }],
      }), { status: 200 }))
      const gemini = createGeminiProvider(fetchFn)
      const deepseek = createMockProvider('deepseek')
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: 'DeepSeek overflow' })),
      )
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => `key-${providerId}`)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = scheduler
      deps.rateLimiter = new RateLimiter({ maxBackoffMs: 60_000, clock })
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      await expect(translator.translate({
        messageId: 'before-rollback',
        text: 'first',
        priority: 'backlog',
      })).resolves.toEqual({ messageId: 'before-rollback', translatedText: 'Gemini result' })

      await Promise.resolve()
      wallNow -= 60_000
      monotonicNow += 1
      await expect(translator.translate({
        messageId: 'during-rollback',
        text: 'second',
        priority: 'backlog',
      })).resolves.toEqual({ messageId: 'during-rollback', translatedText: 'DeepSeek overflow' })

      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(deepseek.translateBatch).toHaveBeenCalledTimes(1)
      await expect(quota.getUsage('gemini-2.5-flash')).resolves.toMatchObject({ clockRollback: true })
    })

    it('keeps an admitted Gemini fetch alive until the provider timeout', async () => {
      let wallNow = Date.UTC(2026, 6, 13, 12)
      let monotonicNow = 1_000
      const clock: Clock = {
        wallNow: () => wallNow,
        monotonicNow: () => monotonicNow,
      }
      let providerSignal: AbortSignal | undefined
      const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
        providerSignal = init?.signal as AbortSignal | undefined
        return new Promise<Response>((_resolve, reject) => {
          providerSignal?.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true })
        })
      })
      const gemini = createGeminiProvider(fetchFn)
      const deepseek = createMockProvider('deepseek')
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) =>
        requests.map((request) => ({ id: request.id, translatedText: '即時備援' })),
      )
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
        geminiQuota: { ...DEFAULT_GEMINI_QUOTA, liveMaxWaitMs: 1_000 },
      }))
      deps.getApiKey = vi.fn(async (providerId) => `key-${providerId}`)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      const quotaStorage: QuotaStorage = {
        getSession: async () => ({}),
        setSession: async () => undefined,
        getLocal: async () => ({}),
        setLocal: async () => undefined,
      }
      deps.quotaScheduler = new QuotaScheduler(new GeminiQuotaStore(quotaStorage, clock), { clock })
      deps.rateLimiter = new RateLimiter({ maxBackoffMs: 60_000, clock })
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const result = translator.translate({ messageId: 'live', text: 'Hello', priority: 'live' })
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1))
      wallNow += 86_400_000
      monotonicNow += 1_000
      await vi.advanceTimersByTimeAsync(1_000)

      expect(providerSignal?.aborted).toBe(false)
      expect(deepseek.translateBatch).not.toHaveBeenCalled()

      monotonicNow += 29_000
      await vi.advanceTimersByTimeAsync(29_000)

      await expect(result).resolves.toMatchObject({
        messageId: 'live',
        error: { type: 'timeout' },
      })
      expect(providerSignal?.aborted).toBe(true)
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })
  })

  describe('queue lifecycle', () => {
    it('does not call the provider when the queue is empty', () => {
      const provider = createMockProvider()
      deps.getProvider = vi.fn(() => provider)

      vi.advanceTimersByTime(150)

      expect(provider.translateBatch).not.toHaveBeenCalled()
    })

    it('processes items added after a previous flush', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
        requests.map((r) => ({ id: r.id, translatedText: `T-${r.id}` })),
      )
      deps.getProvider = vi.fn(() => provider)

      // First batch
      const promise1 = translator.translate({ messageId: 'msg1', text: 'one' })
      vi.advanceTimersByTime(150)
      await promise1
      expect(provider.translateBatch).toHaveBeenCalledTimes(1)

      // Second batch
      const promise2 = translator.translate({ messageId: 'msg2', text: 'two' })
      vi.advanceTimersByTime(150)
      const result2 = await promise2

      expect(result2.translatedText).toBe('T-msg2')
      expect(provider.translateBatch).toHaveBeenCalledTimes(2)
    })

    it('reads fresh settings on each flush', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([
        { id: 'msg1', translatedText: 'A' },
      ])
      deps.getProvider = vi.fn(() => provider)

      const promise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      await promise

      expect(deps.getSettings).toHaveBeenCalled()
      expect(deps.getApiKey).toHaveBeenCalledWith('deepseek')
    })
  })

  describe('rate limiting', () => {
    it('falls back from a genuine Gemini 429 to DeepSeek V4 Flash', async () => {
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockResolvedValue([
        {
          id: 'msg1',
          error: 'Gemini free-tier quota exhausted',
          status: 429,
          retryAfterMs: 57_000,
        },
      ])
      vi.mocked(deepseek.translateBatch).mockResolvedValue([
        { id: 'msg1', translatedText: '你好' },
      ])
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => `key-${providerId}`)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)

      const resultPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result).toEqual({ messageId: 'msg1', translatedText: '你好' })
      expect(deepseek.translateBatch).toHaveBeenCalledWith(
        [{ id: 'msg1', text: 'Hello', sourceLang: undefined }],
        'key-deepseek',
        'deepseek-v4-flash',
        'zh-TW',
      )
      expect(deps.rateLimiter.getRemainingCooldown('gemini')).toBe(57_000)
    })

    it('routes directly to DeepSeek while Gemini is in a 429 cooldown', async () => {
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(deepseek.translateBatch).mockResolvedValue([
        { id: 'msg1', translatedText: '冷卻期間的翻譯' },
      ])
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => `key-${providerId}`)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.rateLimiter.recordError('gemini', 30_000)

      const resultPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result.translatedText).toBe('冷卻期間的翻譯')
      expect(gemini.translateBatch).not.toHaveBeenCalled()
      expect(deepseek.translateBatch).toHaveBeenCalledTimes(1)
    })

    it('reuses a cached DeepSeek fallback result during Gemini cooldown', async () => {
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => `key-${providerId}`)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.rateLimiter.recordError('gemini', 30_000)
      deps.cache.set('Hello|zh-TW|deepseek|deepseek-v4-flash', {
        id: 'old-id',
        translatedText: '快取翻譯',
      })

      const resultPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result).toEqual({ messageId: 'msg1', translatedText: '快取翻譯' })
      expect(gemini.translateBatch).not.toHaveBeenCalled()
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })

    it('reuses a cached DeepSeek result on scheduler overflow', async () => {
      const gemini = createMockProvider('gemini')
      vi.mocked(gemini.translateBatch).mockResolvedValue([
        { id: 'msg1', error: 'quota', status: 429, retryAfterMs: 30_000 },
      ])
      const deepseek = createMockProvider('deepseek')
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => providerId === 'gemini' ? 'gemini-key' : 'deepseek-key')
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.cache.set('Hello|zh-TW|deepseek|deepseek-v4-flash', {
        id: 'cached-id',
        translatedText: '快取翻譯',
      })
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 10 })

      const result = translator.translate({ messageId: 'msg1', text: 'Hello' })
      await vi.advanceTimersByTimeAsync(150)

      await expect(result).resolves.toEqual({ messageId: 'msg1', translatedText: '快取翻譯' })
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })

    it('resolves cached DeepSeek overflow before acquiring saturated provider capacity', async () => {
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(deepseek.translateBatch).mockImplementation(async (requests) => {
        await held
        return requests.map((request) => ({ id: request.id, translatedText: request.id }))
      })
      let selectedProvider: ProviderId = 'deepseek'
      deps.getSettings = vi.fn(async () => ({
        selectedProvider,
        selectedModel: selectedProvider === 'gemini' ? 'gemini-2.5-flash' : 'deepseek-v4-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => `key-${providerId}`)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)

      const quotaStorage: QuotaStorage = {
        getSession: async () => ({}),
        setSession: async () => undefined,
        getLocal: async () => ({}),
        setLocal: async () => undefined,
      }
      const quota = new GeminiQuotaStore(quotaStorage)
      await quota.openCooldown(60_000, 'gemini-2.5-flash')
      deps.quotaScheduler = new QuotaScheduler(quota, { deepseekMaxConcurrency: 2 })
      deps.cache.set('cached|zh-TW|deepseek|deepseek-v4-flash', {
        id: 'cached-before',
        translatedText: '快取翻譯',
      })
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const first = translator.translate({ messageId: 'held-1', text: 'one' })
      const second = translator.translate({ messageId: 'held-2', text: 'two' })
      await vi.waitFor(() => expect(deepseek.translateBatch).toHaveBeenCalledTimes(2))

      selectedProvider = 'gemini'
      let cachedSettled = false
      const cached = translator.translate({ messageId: 'cached', text: 'cached' }).then((result) => {
        cachedSettled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(cachedSettled).toBe(true)
      await expect(cached).resolves.toEqual({ messageId: 'cached', translatedText: '快取翻譯' })
      expect(gemini.translateBatch).not.toHaveBeenCalled()
      expect(deepseek.translateBatch).toHaveBeenCalledTimes(2)

      release()
      await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    })

    it('honors DeepSeek cooldown on scheduler overflow without probing again', async () => {
      const gemini = createMockProvider('gemini')
      vi.mocked(gemini.translateBatch).mockResolvedValue([
        { id: 'msg1', error: 'quota', status: 429, retryAfterMs: 30_000 },
      ])
      const deepseek = createMockProvider('deepseek')
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => providerId === 'gemini' ? 'gemini-key' : 'deepseek-key')
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.rateLimiter.recordError('deepseek', 10_000)
      deps.quotaScheduler = createQuotaScheduler()
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 10 })

      const result = translator.translate({ messageId: 'msg1', text: 'Hello' })
      await vi.advanceTimersByTimeAsync(150)

      await expect(result).resolves.toMatchObject({ error: { type: 'rate_limited' } })
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })

    it('records a scheduler-overflow DeepSeek 429 and prevents the next probe', async () => {
      const gemini = createMockProvider('gemini')
      vi.mocked(gemini.translateBatch).mockResolvedValue([
        { id: 'first', error: 'quota', status: 429, retryAfterMs: 30_000 },
      ])
      const deepseek = createMockProvider('deepseek')
      vi.mocked(deepseek.translateBatch).mockResolvedValue([
        { id: 'first', error: 'DeepSeek quota exhausted', status: 429, retryAfterMs: 10_000 },
      ])
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => providerId === 'gemini' ? 'gemini-key' : 'deepseek-key')
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)
      deps.quotaScheduler = createQuotaScheduler()

      const first = translator.translate({ messageId: 'first', text: 'one' })
      await vi.advanceTimersByTimeAsync(150)
      await expect(first).resolves.toMatchObject({ error: { type: 'rate_limited' } })

      const second = translator.translate({ messageId: 'second', text: 'two' })
      await vi.advanceTimersByTimeAsync(150)
      await expect(second).resolves.toMatchObject({ error: { type: 'rate_limited' } })
      expect(deepseek.translateBatch).toHaveBeenCalledTimes(1)
    })

    it('does not let a concurrent DeepSeek success erase a newer 429 cooldown', async () => {
      let finishFirst!: (results: Array<{ id: string; error: string; status: number; retryAfterMs: number }>) => void
      let finishSecond!: (results: Array<{ id: string; translatedText: string }>) => void
      const firstResponse = new Promise<Array<{ id: string; error: string; status: number; retryAfterMs: number }>>((resolve) => {
        finishFirst = resolve
      })
      const secondResponse = new Promise<Array<{ id: string; translatedText: string }>>((resolve) => {
        finishSecond = resolve
      })
      const deepseek = createMockProvider('deepseek')
      vi.mocked(deepseek.translateBatch)
        .mockImplementationOnce(() => firstResponse)
        .mockImplementationOnce(() => secondResponse)
      deps.getProvider = vi.fn(() => deepseek)
      deps.quotaScheduler = createQuotaScheduler(2)
      translator = new Translator(deps, { debounceMs: 150, maxBatchSize: 1 })

      const first = translator.translate({ messageId: 'first', text: 'one' })
      const second = translator.translate({ messageId: 'second', text: 'two' })
      await vi.waitFor(() => expect(deepseek.translateBatch).toHaveBeenCalledTimes(2))
      finishFirst([{ id: 'first', error: 'limited', status: 429, retryAfterMs: 10_000 }])
      await expect(first).resolves.toMatchObject({ error: { type: 'rate_limited' } })
      finishSecond([{ id: 'second', translatedText: 'done' }])
      await expect(second).resolves.toMatchObject({ translatedText: 'done' })

      const third = translator.translate({ messageId: 'third', text: 'three' })
      await vi.advanceTimersByTimeAsync(150)
      await expect(third).resolves.toMatchObject({ error: { type: 'rate_limited' } })
      expect(deepseek.translateBatch).toHaveBeenCalledTimes(2)
    })

    it('keeps the Gemini 429 actionable when no DeepSeek key is configured', async () => {
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockResolvedValue([
        { id: 'msg1', error: 'Gemini quota exhausted', status: 429, retryAfterMs: 57_000 },
      ])
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => providerId === 'gemini' ? 'gemini-key' : undefined)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)

      const resultPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result.error).toMatchObject({ type: 'rate_limited', retryAfterMs: 57_000 })
      expect(result.error?.message).toContain('Gemini quota exhausted')
      expect(result.error?.message).toContain('DeepSeek API key')
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })

    it('does not fall back to DeepSeek for a non-429 Gemini failure', async () => {
      const gemini = createMockProvider('gemini')
      const deepseek = createMockProvider('deepseek')
      vi.mocked(gemini.translateBatch).mockResolvedValue([
        { id: 'msg1', error: 'Invalid Gemini API key', status: 403 },
      ])
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getApiKey = vi.fn(async (providerId) => `key-${providerId}`)
      deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)

      const resultPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result.error?.type).not.toBe('rate_limited')
      expect(deepseek.translateBatch).not.toHaveBeenCalled()
    })

    it('preserves auth error status from batchResult', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([
        { id: 'msg1', error: 'Forbidden', status: 403, errorType: 'auth' },
      ])
      deps.getProvider = vi.fn(() => provider)

      const result = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)

      await expect(result).resolves.toMatchObject({
        messageId: 'msg1',
        error: { type: 'auth', status: 403 },
      })
    })

    it('maps explicit errorType rate_limited without relying on string heuristic', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([
        { id: 'msg1', error: 'Some other error', errorType: 'rate_limited', retryAfterMs: 12_500 },
      ])
      deps.getProvider = vi.fn(() => provider)

      const result = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)

      await expect(result).resolves.toEqual({
        messageId: 'msg1',
        error: { type: 'rate_limited', retryAfterMs: 12_500, message: 'Some other error' },
      })
    })

    it('uses structured Gemini 429 metadata and provider retry delay', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([
        {
          id: 'msg1',
          error: 'Quota exceeded for gemini-2.5-flash',
          status: 429,
          retryAfterMs: 44_500,
        },
      ])
      deps.getSettings = vi.fn(async () => ({
        selectedProvider: 'gemini' as ProviderId,
        selectedModel: 'gemini-2.5-flash',
        targetLanguage: 'zh-TW',
      }))
      deps.getProvider = vi.fn(() => provider)

      const resultPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result).toEqual({
        messageId: 'msg1',
        error: {
          type: 'rate_limited',
          retryAfterMs: 44_500,
          message: 'Quota exceeded for gemini-2.5-flash',
        },
      })
      expect(deps.rateLimiter.getRemainingCooldown('gemini')).toBe(44_500)
    })

    it('does not poison the rate limiter after a network exception', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch)
        .mockRejectedValueOnce(new Error('Network failure'))
        .mockResolvedValueOnce([{ id: 'msg2', translatedText: '世界' }])
      deps.getProvider = vi.fn(() => provider)

      const firstPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const firstResult = await firstPromise

      const secondPromise = translator.translate({ messageId: 'msg2', text: 'World' })
      vi.advanceTimersByTime(150)
      const secondResult = await secondPromise

      expect(firstResult.error?.type).toBe('network')
      expect(secondResult).toEqual({ messageId: 'msg2', translatedText: '世界' })
      expect(provider.translateBatch).toHaveBeenCalledTimes(2)
    })

    it('returns rate_limited error without calling provider when rate limited', async () => {
      const provider = createMockProvider()
      deps.getProvider = vi.fn(() => provider)
      deps.rateLimiter.recordError('deepseek', 10_000)

      const resultPromise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result = await resultPromise

      expect(result.error?.type).toBe('rate_limited')
      expect(provider.translateBatch).not.toHaveBeenCalled()
    })

    it('processes normally when cooldown has expired', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
        requests.map((r) => ({ id: r.id, translatedText: `T-${r.text}` })),
      )
      deps.getProvider = vi.fn(() => provider)
      deps.rateLimiter.recordError('deepseek', 5_000)

      // First call should be rate limited
      const promise1 = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      const result1 = await promise1
      expect(result1.error?.type).toBe('rate_limited')

      // After cooldown expires, reset rate limiter
      vi.advanceTimersByTime(5_001)
      deps.rateLimiter.reset('deepseek')

      const promise2 = translator.translate({ messageId: 'msg2', text: 'World' })
      vi.advanceTimersByTime(150)
      const result2 = await promise2

      expect(result2.translatedText).toBe('T-World')
      expect(provider.translateBatch).toHaveBeenCalledTimes(1)
    })

    it('resets rate limiter on successful API response', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([
        { id: 'msg1', translatedText: '你好' },
      ])
      deps.getProvider = vi.fn(() => provider)
      // Pre-record an error so limiter has state
      deps.rateLimiter.recordError('deepseek', 5_000)

      // Reset the limiter before the call (simulating the behavior after flush)
      deps.rateLimiter.reset('deepseek')

      const promise = translator.translate({ messageId: 'msg1', text: 'Hello' })
      vi.advanceTimersByTime(150)
      await promise

      expect(deps.rateLimiter.isLimited('deepseek')).toBe(false)
    })

    it('rate limits all items in a batch', async () => {
      const provider = createMockProvider()
      deps.getProvider = vi.fn(() => provider)
      deps.rateLimiter.recordError('deepseek', 10_000)

      const promises = Array.from({ length: 5 }, (_, i) =>
        translator.translate({ messageId: `msg${i}`, text: `text${i}` }),
      )
      vi.advanceTimersByTime(150)
      const results = await Promise.all(promises)

      results.forEach((r) => {
        expect(r.error?.type).toBe('rate_limited')
      })
      expect(provider.translateBatch).not.toHaveBeenCalled()
    })
  })
})
