import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProviderId, type TranslationProvider } from '@/providers/types'
import { TranslationCache } from './cache'
import { RateLimiter } from './rate-limiter'
import { type TranslatorDependencies, Translator } from './translator'
import type { TranslationResult } from '@/shared/messages'

/**
 * Issue #60 — privacy-safe dedup / coalescing diagnostics.
 *
 * This file proves the batch-local dedup counter is observable through the
 * translator's reportDiagnosticCount callback and holds up under a Gemini 429
 * cooldown, where the queue-interaction surface (batch dedup × cooldown × cache
 * reuse) is reachable in production.
 *
 * In-flight coalescing: under production single-flight (#49) the in-flight
 * registry branch is normally served by the cache, so a white-box test pins the
 * counter wiring directly on the registry path to keep that instrumentation
 * honest and reachable.
 */
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

describe('Translator — issue #60 privacy-safe dedup/coalescing diagnostics', () => {
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

  it('counts every batch-local dedup removal and reuses cache during a Gemini 429 cooldown', async () => {
    const reportDiagnosticCount = vi.fn()
    deps.reportDiagnosticCount = reportDiagnosticCount
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
    }))
    deps.getApiKey = vi.fn(async (providerId) => `key-${providerId}`)
    deps.getProvider = vi.fn((providerId) => providerId === 'gemini' ? gemini : deepseek)

    // Flush 1: three identical uncached requests collapse into one provider
    // item. Gemini 429 opens a cooldown and the DeepSeek fallback caches the
    // shared result. The two dedup followers are counted.
    const first = await flush([
      { messageId: 'a', text: 'Hello' },
      { messageId: 'b', text: 'Hello' },
      { messageId: 'c', text: 'Hello' },
    ])

    expect(first).toEqual([
      { messageId: 'a', translatedText: '你好' },
      { messageId: 'b', translatedText: '你好' },
      { messageId: 'c', translatedText: '你好' },
    ])
    expect(gemini.translateBatch).toHaveBeenCalledTimes(1)
    expect(deepseek.translateBatch).toHaveBeenCalledTimes(1)
    expect(reportDiagnosticCount).toHaveBeenCalledTimes(2)
    expect(reportDiagnosticCount).toHaveBeenCalledWith('batch_dedup_removed')
    expect(deps.rateLimiter.getRemainingCooldown('gemini')).toBeGreaterThan(0)

    // Flush 2 during the cooldown: identical work is served from the DeepSeek
    // cache via the rate-limit fallback — no provider is called again, and the
    // within-flush follower is still counted.
    reportDiagnosticCount.mockClear()
    const second = await flush([
      { messageId: 'd', text: 'Hello' },
      { messageId: 'e', text: 'Hello' },
    ])

    expect(second).toEqual([
      { messageId: 'd', translatedText: '你好' },
      { messageId: 'e', translatedText: '你好' },
    ])
    expect(gemini.translateBatch).toHaveBeenCalledTimes(1)
    expect(deepseek.translateBatch).toHaveBeenCalledTimes(1)
    expect(reportDiagnosticCount).toHaveBeenCalledTimes(1)
    expect(reportDiagnosticCount).toHaveBeenCalledWith('batch_dedup_removed')
  })

  it('reports the in-flight coalescing counter when equivalent work finds the registry (white-box)', async () => {
    const reportDiagnosticCount = vi.fn()
    deps.reportDiagnosticCount = reportDiagnosticCount
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockImplementation(async (requests) =>
      requests.map((r) => ({ id: r.id, translatedText: `T-${r.text}` })),
    )
    deps.getProvider = vi.fn(() => provider)

    // Seed the in-flight registry as if a live request for 'Hello' were already
    // admitted. Under production single-flight (#49) this branch is normally
    // served by the cache, so the counter wiring on the registry path is pinned
    // directly (white-box) to keep the instrumentation honest.
    const translatorInternal = translator as unknown as {
      inFlightTranslations: Map<string, Promise<TranslationResult>>
    }
    const cacheKey = deps.cache.buildKey('Hello', 'zh-TW', 'deepseek', 'deepseek-v4-flash')

    let release!: (result: TranslationResult) => void
    const held = new Promise<TranslationResult>((resolve) => { release = resolve })
    translatorInternal.inFlightTranslations.set(`live:${cacheKey}`, held)

    const resultPromise = translator.translate({ messageId: 'dup', text: 'Hello', priority: 'live' })
    await vi.advanceTimersByTimeAsync(300)

    // The coalesced request resolves from the in-flight entry and is counted,
    // never reaching the provider.
    expect(reportDiagnosticCount).toHaveBeenCalledWith('in_flight_coalesced')
    expect(provider.translateBatch).not.toHaveBeenCalled()

    release({ messageId: 'dup', translatedText: '你好' })
    await expect(resultPromise).resolves.toEqual({ messageId: 'dup', translatedText: '你好' })
  })
})
