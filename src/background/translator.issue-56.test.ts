import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProviderId, type TranslationProvider } from '@/providers/types'
import { buildTranslationIdentity } from '@/shared/translation-identity'
import { TranslationCache } from './cache'
import { RateLimiter } from './rate-limiter'
import { type TranslatorDependencies, Translator } from './translator'
import type { TranslationResult } from '@/shared/messages'

/**
 * Issue #56 — within a single Translator flush, requests sharing the same
 * canonical translation identity must produce exactly one provider batch item,
 * and that outcome must fan out to every original request and messageId.
 *
 * Dedup is batch-local only: it never coalesces work across separate flushes
 * (in-flight coalescing is owned by #58).
 */

const cacheKey = (
  text: string,
  provider: string,
  model: string,
  sourceLang?: string,
): string => buildTranslationIdentity({
  text,
  targetLang: 'zh-TW',
  provider,
  model,
  sourceLang,
})

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

describe('Translator — issue #56 batch-local deduplication', () => {
  let deps: TranslatorDependencies
  let translator: Translator

  beforeEach(() => {
    vi.useFakeTimers()
    deps = defaultDeps()
    translator = new Translator(deps, { batchWindowMs: 300, maxBatchSize: 10 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Enqueue a set of requests and flush them on the shared 300 ms batch window. */
  const flush = async (requests: Array<{ messageId: string; text: string; sourceLang?: string }>): Promise<TranslationResult[]> => {
    const promises = requests.map((request) => translator.translate(request))
    await vi.advanceTimersByTimeAsync(300)
    return Promise.all(promises)
  }

  it('sends exactly one provider item for ten identical requests in one flush', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
      requests.map((r) => ({ id: r.id, translatedText: `T-${r.id}` })),
    )
    deps.getProvider = vi.fn(() => provider)

    const results = await flush(
      Array.from({ length: 10 }, (_, i) => ({ messageId: `msg${i}`, text: 'Hello' })),
    )

    expect(provider.translateBatch).toHaveBeenCalledTimes(1)
    const sent = vi.mocked(provider.translateBatch).mock.calls[0]![0]
    expect(sent).toHaveLength(1)
    expect(sent[0]!.id).toBe('msg0')
    expect(sent[0]!.text).toBe('Hello')
    expect(results).toHaveLength(10)
  })

  it('fans a successful translation out to every grouped request ID', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockResolvedValue([
      { id: 'msg0', translatedText: '你好' },
    ])
    deps.getProvider = vi.fn(() => provider)

    const results = await flush(
      Array.from({ length: 10 }, (_, i) => ({ messageId: `msg${i}`, text: 'Hello' })),
    )

    results.forEach((result, index) => {
      expect(result.messageId).toBe(`msg${index}`)
      expect(result.translatedText).toBe('你好')
      expect(result.error).toBeUndefined()
    })
    expect(provider.translateBatch).toHaveBeenCalledTimes(1)
  })

  it('fans a structured provider error out to every grouped request ID', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockResolvedValue([
      { id: 'msg0', error: 'quota exhausted', status: 429, retryAfterMs: 57_000, errorType: 'rate_limited' },
    ])
    deps.getProvider = vi.fn(() => provider)

    const results = await flush(
      Array.from({ length: 5 }, (_, i) => ({ messageId: `msg${i}`, text: 'Hello' })),
    )

    results.forEach((result, index) => {
      expect(result.messageId).toBe(`msg${index}`)
      expect(result.translatedText).toBeUndefined()
      expect(result.error).toEqual({
        type: 'rate_limited',
        retryAfterMs: 57_000,
        message: 'quota exhausted',
      })
    })
    expect(provider.translateBatch).toHaveBeenCalledTimes(1)
  })

  it('keeps distinct identities as separate provider items with deterministic mapping', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
      requests.map((r) => ({ id: r.id, translatedText: `T-${r.text}` })),
    )
    deps.getProvider = vi.fn(() => provider)

    // Two identities (one unique, one duplicated) share one flush.
    const results = await flush([
      { messageId: 'unique', text: 'Hello' },
      { messageId: 'dup-a', text: 'World' },
      { messageId: 'dup-b', text: 'World' },
    ])

    expect(provider.translateBatch).toHaveBeenCalledTimes(1)
    const sent = vi.mocked(provider.translateBatch).mock.calls[0]![0]
    expect(sent).toHaveLength(2)
    const byText = new Map(sent.map((r) => [r.text, r.id]))
    expect(byText.get('Hello')).toBe('unique')
    expect(byText.get('World')).toBe('dup-a')

    expect(results).toEqual([
      { messageId: 'unique', translatedText: 'T-Hello' },
      { messageId: 'dup-a', translatedText: 'T-World' },
      { messageId: 'dup-b', translatedText: 'T-World' },
    ])
  })

  it('keeps the mapping correct when the provider returns items in reverse order', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
      [...requests].reverse().map((r) => ({ id: r.id, translatedText: `T-${r.text}` })),
    )
    deps.getProvider = vi.fn(() => provider)

    const results = await flush([
      { messageId: 'unique', text: 'Hello' },
      { messageId: 'dup-a', text: 'World' },
      { messageId: 'dup-b', text: 'World' },
    ])

    expect(results).toEqual([
      { messageId: 'unique', translatedText: 'T-Hello' },
      { messageId: 'dup-a', translatedText: 'T-World' },
      { messageId: 'dup-b', translatedText: 'T-World' },
    ])
  })

  it('does not deduplicate requests with different source-language hints', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
      requests.map((r) => ({ id: r.id, translatedText: `${r.sourceLang ?? 'none'}` })),
    )
    deps.getProvider = vi.fn(() => provider)

    const results = await flush([
      { messageId: 'en', text: 'same', sourceLang: 'en' },
      { messageId: 'ja', text: 'same', sourceLang: 'ja' },
      { messageId: 'none', text: 'same' },
    ])

    expect(provider.translateBatch).toHaveBeenCalledTimes(1)
    const sent = vi.mocked(provider.translateBatch).mock.calls[0]![0]
    expect(sent).toHaveLength(3)
    expect(results).toEqual([
      { messageId: 'en', translatedText: 'en' },
      { messageId: 'ja', translatedText: 'ja' },
      { messageId: 'none', translatedText: 'none' },
    ])
  })

  it('does not coalesce across flushes once the first flush has settled and failed', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch)
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockImplementation(async (requests) =>
        requests.map((r) => ({ id: r.id, translatedText: `T-${r.text}` })),
      )
    deps.getProvider = vi.fn(() => provider)

    const first = await flush([{ messageId: 'one', text: 'Hello' }])
    const second = await flush([{ messageId: 'two', text: 'Hello' }])

    // The first flush failed without caching, so the in-flight registry is
    // gone by the second flush — identical work must not coalesce across
    // flushes (that is #58). A fresh provider call serves the retry.
    expect(first).toEqual([{ messageId: 'one', error: { type: 'network', message: 'transient failure' } }])
    expect(second).toEqual([{ messageId: 'two', translatedText: 'T-Hello' }])
    expect(provider.translateBatch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(provider.translateBatch).mock.calls[0]![0]).toHaveLength(1)
    expect(vi.mocked(provider.translateBatch).mock.calls[1]![0]).toHaveLength(1)
  })

  it('does not deduplicate across flushes with different target languages', async () => {
    let targetLanguage = 'zh-TW'
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
      requests.map((r) => ({ id: r.id, translatedText: `T-${r.text}` })),
    )
    deps.getProvider = vi.fn(() => provider)
    deps.getSettings = vi.fn(async () => ({
      selectedProvider: 'deepseek' as ProviderId,
      selectedModel: 'deepseek-v4-flash',
      targetLanguage,
    }))

    const first = await flush([{ messageId: 'one', text: 'Hello' }])
    targetLanguage = 'ja'
    const second = await flush([{ messageId: 'two', text: 'Hello' }])

    // A different target language is a different identity, so each flush
    // produces its own provider item even though the text is identical.
    expect(first).toEqual([{ messageId: 'one', translatedText: 'T-Hello' }])
    expect(second).toEqual([{ messageId: 'two', translatedText: 'T-Hello' }])
    expect(provider.translateBatch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(provider.translateBatch).mock.calls[1]![3]).toBe('ja')
  })

  it('resolves duplicated requests from cache without a provider call', async () => {
    const provider = createMockProvider()
    deps.getProvider = vi.fn(() => provider)
    deps.cache.set(cacheKey('Hello', 'deepseek', 'deepseek-v4-flash'), {
      id: 'cached-id',
      translatedText: '你好',
    })

    const results = await flush([
      { messageId: 'msg1', text: 'Hello' },
      { messageId: 'msg2', text: 'Hello' },
    ])

    expect(results).toEqual([
      { messageId: 'msg1', translatedText: '你好' },
      { messageId: 'msg2', translatedText: '你好' },
    ])
    expect(provider.translateBatch).not.toHaveBeenCalled()
  })

  it('keeps empty translations invalid for every grouped request and never caches them', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockResolvedValue([
      { id: 'msg0', translatedText: '' },
    ])
    deps.getProvider = vi.fn(() => provider)

    const results = await flush(
      Array.from({ length: 4 }, (_, i) => ({ messageId: `msg${i}`, text: 'Hello' })),
    )

    results.forEach((result, index) => {
      expect(result.messageId).toBe(`msg${index}`)
      expect(result.translatedText).toBeUndefined()
      expect(result.error?.type).toBe('invalid_response')
    })
    expect(provider.translateBatch).toHaveBeenCalledTimes(1)
    expect(deps.cache.has(cacheKey('Hello', 'deepseek', 'deepseek-v4-flash'))).toBe(false)
  })

  it('does not merge groups across a mixed duplicate and unique flush deterministically', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
      requests.map((r) => ({ id: r.id, translatedText: `T-${r.id}` })),
    )
    deps.getProvider = vi.fn(() => provider)

    const results = await flush([
      { messageId: 'a1', text: 'alpha' },
      { messageId: 'b1', text: 'beta' },
      { messageId: 'a2', text: 'alpha' },
      { messageId: 'b2', text: 'beta' },
      { messageId: 'a3', text: 'alpha' },
      { messageId: 'c1', text: 'gamma' },
    ])

    // The provider sees one item per unique identity. Every duplicate maps back
    // to its own group leader's outcome, never to another group's.
    expect(provider.translateBatch).toHaveBeenCalledTimes(1)
    const sent = vi.mocked(provider.translateBatch).mock.calls[0]![0]
    expect(sent).toHaveLength(3)
    expect(new Set(sent.map((r) => r.text))).toEqual(new Set(['alpha', 'beta', 'gamma']))

    const byMessageId = new Map(results.map((r) => [r.messageId, r]))
    expect(byMessageId.get('a1')).toEqual({ messageId: 'a1', translatedText: 'T-a1' })
    expect(byMessageId.get('a2')).toEqual({ messageId: 'a2', translatedText: 'T-a1' })
    expect(byMessageId.get('a3')).toEqual({ messageId: 'a3', translatedText: 'T-a1' })
    expect(byMessageId.get('b1')).toEqual({ messageId: 'b1', translatedText: 'T-b1' })
    expect(byMessageId.get('b2')).toEqual({ messageId: 'b2', translatedText: 'T-b1' })
    expect(byMessageId.get('c1')).toEqual({ messageId: 'c1', translatedText: 'T-c1' })
  })

  it('settles every grouped Promise exactly once', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockResolvedValue([
      { id: 'msg0', translatedText: '你好' },
    ])
    deps.getProvider = vi.fn(() => provider)

    const settlements = new Map<string, number>()
    const results = await flush(
      Array.from({ length: 10 }, (_, i) => ({ messageId: `msg${i}`, text: 'Hello' })),
    ).then((values) => values.map((value) => {
      settlements.set(value.messageId, (settlements.get(value.messageId) ?? 0) + 1)
      return value
    }))

    expect(results).toHaveLength(10)
    results.forEach((result) => expect(settlements.get(result.messageId)).toBe(1))
  })
})
