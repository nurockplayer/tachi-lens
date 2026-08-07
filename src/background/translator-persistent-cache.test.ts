// L1/L2 persistent-translation-cache integration tests (#104).
//
// The production translator resolves requests through a layered cache:
//   request → L1 (in-memory TranslationCache) → L2 (IndexedDB
//   TranslationCacheDb) → provider on miss.
//
// This suite injects a shape-compatible persistent-cache stub so it can assert
// the translator's control flow (L1 hit fast path, on-demand L2 lookup, L2
// write-through, cache-layer failure fallback) without a real IndexedDB. The
// IndexedDB adapter's own semantics (TTL, contract invalidation, malformed
// records, bounded eviction) are covered by translation-cache-db.test.ts.

import { describe, expect, it, vi } from 'vitest'
import type { ProviderId, TranslationProvider } from '@/providers/types'
import { buildTranslationIdentity } from '@/shared/translation-identity'
import type { TranslationResult } from '@/shared/messages'
import { TranslationCache } from './cache'
import { RateLimiter } from './rate-limiter'
import type { QuotaScheduler } from './quota-scheduler'
import type { TranslationCacheRecord } from './translation-cache-db'
import { type PersistentTranslationCache, type TranslatorDependencies, Translator } from './translator'

const cacheKey = (
  text: string,
  provider = 'deepseek',
  model = 'deepseek-v4-flash',
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
  displayName: id,
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

/** In-memory persistent-cache stub sharing a backing store across instances. */
const createPersistentCache = (): {
  store: Map<string, TranslationCacheRecord>
  pc: PersistentTranslationCache & { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }
} => {
  const store = new Map<string, TranslationCacheRecord>()
  const pc = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, record: TranslationCacheRecord) => { store.set(key, record) }),
  }
  return { store, pc }
}

const translate = async (
  translator: Translator,
  request: { messageId: string; text: string; sourceLang?: string },
): Promise<TranslationResult> => translator.translate(request)

const OPTIONS = { batchWindowMs: 300, maxBatchSize: 1 }

describe('Translator persistent cache (L1/L2)', () => {
  describe('L1 hit', () => {
    it('serves an L1 hit without touching IndexedDB or the provider', async () => {
      const provider = createMockProvider()
      const { pc } = createPersistentCache()
      const deps = defaultDeps({ getProvider: vi.fn(() => provider), persistentCache: pc })
      deps.cache.set(cacheKey('Hello'), { id: 'msg1', translatedText: '你好' })

      const result = await translate(new Translator(deps, OPTIONS), { messageId: 'msg1', text: 'Hello' })

      expect(result.translatedText).toBe('你好')
      expect(pc.get).not.toHaveBeenCalled()
      expect(provider.translateBatch).not.toHaveBeenCalled()
    })
  })

  describe('L2 hit', () => {
    it('promotes an L2 hit into L1 and settles without provider work', async () => {
      const provider = createMockProvider()
      const { store, pc } = createPersistentCache()
      const key = cacheKey('Hello')
      store.set(key, { key, translatedText: '你好', storedAt: Date.now() })
      const deps = defaultDeps({ getProvider: vi.fn(() => provider), persistentCache: pc })

      const result = await translate(new Translator(deps, OPTIONS), { messageId: 'msg1', text: 'Hello' })

      expect(result.translatedText).toBe('你好')
      expect(provider.translateBatch).not.toHaveBeenCalled()
      expect(pc.get).toHaveBeenCalledWith(key)
      // L1 is hydrated for subsequent requests.
      expect(deps.cache.get(key)?.translatedText).toBe('你好')
    })

    it('hydrates L1 so a repeated request never re-queries L2', async () => {
      const provider = createMockProvider()
      const { store, pc } = createPersistentCache()
      const key = cacheKey('Hello')
      store.set(key, { key, translatedText: '你好', storedAt: Date.now() })
      const deps = defaultDeps({ getProvider: vi.fn(() => provider), persistentCache: pc })
      const translator = new Translator(deps, OPTIONS)

      const first = await translate(translator, { messageId: 'msg1', text: 'Hello' })
      const second = await translate(translator, { messageId: 'msg2', text: 'Hello' })

      expect(first.translatedText).toBe('你好')
      expect(second.translatedText).toBe('你好')
      expect(pc.get).toHaveBeenCalledTimes(1)
      expect(provider.translateBatch).not.toHaveBeenCalled()
    })

    it('does not create a quota reservation for an L2 hit', async () => {
      const gemini = createMockProvider('gemini')
      const { store, pc } = createPersistentCache()
      const key = cacheKey('Hello', 'gemini', 'gemini-2.5-flash')
      store.set(key, { key, translatedText: '你好', storedAt: Date.now() })
      const schedule = vi.fn()
      const deps = defaultDeps({
        getSettings: vi.fn(async () => ({
          selectedProvider: 'gemini' as ProviderId,
          selectedModel: 'gemini-2.5-flash',
          targetLanguage: 'zh-TW',
        })),
        getProvider: vi.fn(() => gemini),
        persistentCache: pc,
        quotaScheduler: { schedule } as unknown as QuotaScheduler,
      })

      const result = await translate(new Translator(deps, OPTIONS), { messageId: 'msg1', text: 'Hello' })

      expect(result.translatedText).toBe('你好')
      expect(schedule).not.toHaveBeenCalled()
      expect(gemini.translateBatch).not.toHaveBeenCalled()
    })
  })

  describe('complete miss', () => {
    it('reaches the provider path with unchanged routing semantics', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([{ id: 'msg1', translatedText: '你好' }])
      const { pc } = createPersistentCache()
      const deps = defaultDeps({ getProvider: vi.fn(() => provider), persistentCache: pc })

      const result = await translate(new Translator(deps, OPTIONS), { messageId: 'msg1', text: 'Hello' })

      expect(result.translatedText).toBe('你好')
      expect(provider.translateBatch).toHaveBeenCalledTimes(1)
      expect(pc.get).toHaveBeenCalled()
    })
  })

  describe('write-through', () => {
    it('persists a successful provider result to L2 after populating L1', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([{ id: 'msg1', translatedText: '你好' }])
      const { pc } = createPersistentCache()
      const deps = defaultDeps({ getProvider: vi.fn(() => provider), persistentCache: pc })

      await translate(new Translator(deps, OPTIONS), { messageId: 'msg1', text: 'Hello' })

      const key = cacheKey('Hello')
      expect(deps.cache.has(key)).toBe(true)
      expect(pc.put).toHaveBeenCalledTimes(1)
      expect(pc.put).toHaveBeenCalledWith(key, expect.objectContaining({ key, translatedText: '你好' }))
    })

    it('does not persist an empty translation as a successful L2 record', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([{ id: 'msg1', translatedText: '   ' }])
      const { pc } = createPersistentCache()
      const deps = defaultDeps({ getProvider: vi.fn(() => provider), persistentCache: pc })

      const result = await translate(new Translator(deps, OPTIONS), { messageId: 'msg1', text: 'Hello' })

      expect(result.error).toBeDefined()
      expect(pc.put).not.toHaveBeenCalled()
    })
  })

  describe('provider/settings isolation', () => {
    it('never reuses an L2 record written under a different provider/model', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([{ id: 'msg1', translatedText: '你好' }])
      const { store, pc } = createPersistentCache()
      const foreignKey = cacheKey('Hello', 'openai', 'gpt-4o')
      store.set(foreignKey, { key: foreignKey, translatedText: '別家翻譯', storedAt: Date.now() })
      const deps = defaultDeps({ getProvider: vi.fn(() => provider), persistentCache: pc })

      const result = await translate(new Translator(deps, OPTIONS), { messageId: 'msg1', text: 'Hello' })

      expect(result.translatedText).toBe('你好')
      expect(provider.translateBatch).toHaveBeenCalledTimes(1)
    })
  })

  describe('failure fallback', () => {
    it('falls back to the provider when the L2 open/read rejects', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([{ id: 'msg1', translatedText: '你好' }])
      const { pc } = createPersistentCache()
      pc.get.mockRejectedValue(new Error('IndexedDB unavailable'))
      const deps = defaultDeps({ getProvider: vi.fn(() => provider), persistentCache: pc })

      const result = await translate(new Translator(deps, OPTIONS), { messageId: 'msg1', text: 'Hello' })

      expect(result.translatedText).toBe('你好')
      expect(provider.translateBatch).toHaveBeenCalledTimes(1)
    })

    it('does not turn a successful translation into an error when the L2 write fails', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([{ id: 'msg1', translatedText: '你好' }])
      const { pc } = createPersistentCache()
      pc.put.mockRejectedValue(new Error('storage quota exceeded'))
      const deps = defaultDeps({ getProvider: vi.fn(() => provider), persistentCache: pc })

      const result = await translate(new Translator(deps, OPTIONS), { messageId: 'msg1', text: 'Hello' })

      expect(result.error).toBeUndefined()
      expect(result.translatedText).toBe('你好')
    })

    it('treats an empty/malformed L2 record as a miss and translates via the provider', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([{ id: 'msg1', translatedText: '你好' }])
      const { store, pc } = createPersistentCache()
      const key = cacheKey('Hello')
      store.set(key, { key, translatedText: '   ', storedAt: Date.now() })
      const deps = defaultDeps({ getProvider: vi.fn(() => provider), persistentCache: pc })

      const result = await translate(new Translator(deps, OPTIONS), { messageId: 'msg1', text: 'Hello' })

      expect(result.translatedText).toBe('你好')
      expect(provider.translateBatch).toHaveBeenCalledTimes(1)
    })
  })

  describe('restart persistence and expiry', () => {
    it('reuses a valid L2 record after Service Worker recreation (fresh L1, same L2 store)', async () => {
      const providerA = createMockProvider()
      vi.mocked(providerA.translateBatch).mockResolvedValue([{ id: 'msg1', translatedText: '你好' }])
      const { store, pc } = createPersistentCache()

      // First instance: provider success triggers an L2 write-through.
      const depsA = defaultDeps({ getProvider: vi.fn(() => providerA), persistentCache: pc })
      await translate(new Translator(depsA, OPTIONS), { messageId: 'msg1', text: 'Hello' })
      expect(store.size).toBe(1)

      // Recreation: a fresh L1 with the same persistent backing store.
      const providerB = createMockProvider()
      const depsB = defaultDeps({ getProvider: vi.fn(() => providerB), persistentCache: pc })
      const result = await translate(new Translator(depsB, OPTIONS), { messageId: 'msg2', text: 'Hello' })

      expect(result.translatedText).toBe('你好')
      expect(providerB.translateBatch).not.toHaveBeenCalled()
    })

    it('treats an expired record as a miss after recreation', async () => {
      // The L2 adapter returns null for an expired/contract-incompatible
      // record; the translator must route that miss through the provider path.
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([{ id: 'msg1', translatedText: '你好' }])
      const { pc } = createPersistentCache()
      pc.get.mockResolvedValue(null)
      const deps = defaultDeps({ getProvider: vi.fn(() => provider), persistentCache: pc })

      const result = await translate(new Translator(deps, OPTIONS), { messageId: 'msg1', text: 'Hello' })

      expect(result.translatedText).toBe('你好')
      expect(provider.translateBatch).toHaveBeenCalledTimes(1)
    })
  })

  describe('recovery', () => {
    it('recovers to L2 hits after a transient L2 read failure', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.translateBatch).mockResolvedValue([{ id: 'msg1', translatedText: '你好' }])
      const { store, pc } = createPersistentCache()
      const worldKey = cacheKey('World')
      store.set(worldKey, { key: worldKey, translatedText: '世界', storedAt: Date.now() })
      const deps = defaultDeps({ getProvider: vi.fn(() => provider), persistentCache: pc })
      const translator = new Translator(deps, OPTIONS)

      pc.get.mockRejectedValueOnce(new Error('transient open failure'))
      const failed = await translate(translator, { messageId: 'msg1', text: 'Hello' })
      expect(failed.translatedText).toBe('你好')
      expect(provider.translateBatch).toHaveBeenCalledTimes(1)

      // The same persistent store is reachable again: a fresh key hits L2.
      const recovered = await translate(translator, { messageId: 'msg2', text: 'World' })
      expect(recovered.translatedText).toBe('世界')
      expect(provider.translateBatch).toHaveBeenCalledTimes(1)
    })
  })
})
