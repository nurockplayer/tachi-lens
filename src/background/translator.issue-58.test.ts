import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProviderId, type TranslationProvider } from '@/providers/types'
import { TranslationCache } from './cache'
import { RateLimiter } from './rate-limiter'
import { type TranslatorDependencies, Translator } from './translator'
import type { TranslationResult } from '@/shared/messages'

/**
 * Issue #58 — coalesce identical in-flight translation requests across
 * overlapping Translator flushes.
 *
 * A Service Worker memory-only in-flight registry keyed by translation
 * identity (the canonical identity from #54) prevents equivalent work from
 * reaching a provider more than once. The entry must be removed reliably after
 * both success and failure so the registry can never retain settled Promises.
 *
 * The cache handles the reuse-after-settlement path; these tests prove the
 * registry itself does not leak settled work.
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

describe('Translator — issue #58 in-flight coalescing', () => {
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

  it('removes the in-flight entry after success so a later identical request re-invokes the provider', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockImplementation(async (requests) => {
      await held
      return requests.map((r) => ({ id: r.id, translatedText: `T-${r.text}` }))
    })
    deps.getProvider = vi.fn(() => provider)

    // Flush #1: the request is held in flight, then settles successfully.
    const firstPromise = translator.translate({ messageId: 'one', text: 'Hello' })
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => expect(provider.translateBatch).toHaveBeenCalledTimes(1))

    release()
    const first = await firstPromise
    expect(first).toEqual({ messageId: 'one', translatedText: 'T-Hello' })
    expect(provider.translateBatch).toHaveBeenCalledTimes(1)

    // Drop the cache: the only way the second request could avoid a fresh
    // provider call is a leaked in-flight registry entry retaining the settled
    // Promise from the first request.
    deps.cache.clear()

    // Flush #2: identical text after success. A fresh provider call proves the
    // in-flight entry was removed after success and no settled Promise was kept.
    const second = await flush([{ messageId: 'two', text: 'Hello' }])
    expect(second).toEqual([{ messageId: 'two', translatedText: 'T-Hello' }])
    expect(provider.translateBatch).toHaveBeenCalledTimes(2)
  })
})
