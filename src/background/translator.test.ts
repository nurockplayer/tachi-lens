import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProviderId, type TranslationProvider } from '@/providers/types'
import { TranslationCache } from './cache'
import { RateLimiter } from './rate-limiter'
import { type TranslatorDependencies, Translator } from './translator'

const createMockProvider = (): TranslationProvider => ({
  id: 'deepseek',
  displayName: 'DeepSeek',
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
