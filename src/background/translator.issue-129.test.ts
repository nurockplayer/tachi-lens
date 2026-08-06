import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProviderId, type TranslationProvider } from '@/providers/types'
import { buildTranslationIdentity } from '@/shared/translation-identity'
import { TranslationCache } from './cache'
import { RateLimiter } from './rate-limiter'
import { type TranslatorDependencies, Translator } from './translator'

/**
 * Issue #129 — a provider batch result with an empty, whitespace-only, or
 * missing translation must surface as an invalid_response and must never be
 * cached, so the Content Script keeps the message retryable.
 *
 * These tests exercise the Translator with a mock provider that returns
 * empty/missing translatedText directly (bypassing the shared parser), which
 * is the defense-in-depth layer the #129 fix adds.
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

describe('Translator — issue #129 empty/missing translation handling', () => {
  let deps: TranslatorDependencies
  let translator: Translator

  beforeEach(() => {
    vi.useFakeTimers()
    deps = defaultDeps()
    translator = new Translator(deps, { batchWindowMs: 300, maxBatchSize: 10 })
  })

  const translate = async (text: string, messageId = 'msg1') => {
    const result = translator.translate({ messageId, text })
    vi.advanceTimersByTime(300)
    return result
  }

  it('surfaces an empty translatedText as an invalid_response', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockResolvedValue([
      { id: 'msg1', translatedText: '' },
    ])
    deps.getProvider = vi.fn(() => provider)

    const result = await translate('こんにちは')

    expect(result.translatedText).toBeUndefined()
    expect(result.error?.type).toBe('invalid_response')
  })

  it('surfaces a whitespace-only translatedText as an invalid_response', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockResolvedValue([
      { id: 'msg1', translatedText: '   ' },
    ])
    deps.getProvider = vi.fn(() => provider)

    const result = await translate('こんにちは')

    expect(result.translatedText).toBeUndefined()
    expect(result.error?.type).toBe('invalid_response')
  })

  it('does not cache an empty or missing translation', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockResolvedValue([
      { id: 'msg1', translatedText: '' },
    ])
    deps.getProvider = vi.fn(() => provider)

    await translate('こんにちは')

    expect(deps.cache.has(cacheKey('こんにちは', 'deepseek', 'deepseek-v4-flash'))).toBe(false)
  })

  it('maps a mixed batch so valid translations succeed and empty ones become invalid', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockResolvedValue([
      { id: 'msg1', translatedText: 'こんにちは' },
      { id: 'msg2', translatedText: '' },
    ])
    deps.getProvider = vi.fn(() => provider)

    const result1 = translator.translate({ messageId: 'msg1', text: 'こんにちは' })
    const result2 = translator.translate({ messageId: 'msg2', text: 'おはよう' })
    vi.advanceTimersByTime(300)

    const [r1, r2] = await Promise.all([result1, result2])
    expect(r1.translatedText).toBe('こんにちは')
    expect(r1.error).toBeUndefined()
    expect(r2.translatedText).toBeUndefined()
    expect(r2.error?.type).toBe('invalid_response')

    // Only the valid item is cached.
    expect(deps.cache.has(cacheKey('こんにちは', 'deepseek', 'deepseek-v4-flash'))).toBe(true)
    expect(deps.cache.has(cacheKey('おはよう', 'deepseek', 'deepseek-v4-flash'))).toBe(false)
  })

  it('maps a provider result that failed JSON parsing to an invalid_response', async () => {
    // Simulates what prompt.ts produces for a JSON parse failure: the
    // BatchItemResult carries errorType 'invalid_response' and no translatedText.
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockResolvedValue([
      { id: 'msg1', error: 'Failed to parse translation response', errorType: 'invalid_response' },
    ])
    deps.getProvider = vi.fn(() => provider)

    const result = await translate('こんにちは')

    expect(result.translatedText).toBeUndefined()
    expect(result.error?.type).toBe('invalid_response')
  })

  it('maps a provider result with an unexpected top-level format to an invalid_response', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockResolvedValue([
      { id: 'msg1', error: 'Unexpected response format', errorType: 'invalid_response' },
    ])
    deps.getProvider = vi.fn(() => provider)

    const result = await translate('こんにちは')

    expect(result.translatedText).toBeUndefined()
    expect(result.error?.type).toBe('invalid_response')
  })

  it('keeps a valid translation result unchanged', async () => {
    const provider = createMockProvider()
    vi.mocked(provider.translateBatch).mockResolvedValue([
      { id: 'msg1', translatedText: 'こんにちは' },
    ])
    deps.getProvider = vi.fn(() => provider)

    const result = await translate('こんにちは')

    expect(result.translatedText).toBe('こんにちは')
    expect(result.error).toBeUndefined()
  })
})
