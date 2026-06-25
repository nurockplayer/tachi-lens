// Translator with Retry Tests
// Tests for automatic retry on rate limit errors.
// NOTE: uses real timers since Translator's flush mechanism relies on setTimeout.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { TranslationCache } from './cache'
import { RateLimiter } from './rate-limiter'
import { TranslatorWithRetry } from './translator-with-retry'

const mockSettings = {
  selectedProvider: 'deepseek' as const,
  selectedModel: 'deepseek-v4-flash',
  targetLanguage: 'zh-TW',
}

const mockApiKey = 'test-api-key'

const mockProvider = {
  id: 'deepseek' as const,
  displayName: 'DeepSeek',
  models: [{ id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' }],
  defaultModel: 'deepseek-v4-flash',
  translateBatch: vi.fn(),
  validateKey: vi.fn(),
}

const createTranslator = (
  overrides: { debounceMs?: number; maxRetries?: number } = {},
) =>
  new TranslatorWithRetry(
    {
      cache: new TranslationCache(),
      rateLimiter: new RateLimiter({ maxBackoffMs: 60_000 }),
      getSettings: async () => mockSettings,
      getApiKey: async () => mockApiKey,
      getProvider: () => mockProvider,
      maxRetries: overrides.maxRetries ?? 3,
    },
    { debounceMs: overrides.debounceMs ?? 0, maxBatchSize: 1 },
  )

describe('TranslatorWithRetry', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('succeeds on first attempt when no error', async () => {
    mockProvider.translateBatch.mockResolvedValue([
      { id: 'msg1', translatedText: '翻譯結果' },
    ])

    const translator = createTranslator()
    const result = await translator.translate({ messageId: 'msg1', text: 'Hello' })

    expect(result).toEqual({ messageId: 'msg1', translatedText: '翻譯結果' })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('retries on rate limit error and succeeds on second attempt', async () => {
    mockProvider.translateBatch
      .mockResolvedValueOnce([
        { id: 'msg1', translatedText: undefined, error: 'Rate limited (429)' },
      ])
      .mockResolvedValueOnce([
        { id: 'msg1', translatedText: '翻譯結果' },
      ])

    const translator = createTranslator({ debounceMs: 0 })
    const result = await translator.translate({ messageId: 'msg1', text: 'Hello' })

    expect(result).toEqual({ messageId: 'msg1', translatedText: '翻譯結果' })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(2)
  }, 15_000)

  it('gives up after max retries and returns last error', async () => {
    mockProvider.translateBatch.mockResolvedValue([
      { id: 'msg1', translatedText: undefined, error: 'Rate limited (429)' },
    ])

    const translator = createTranslator({ maxRetries: 2 })
    const result = await translator.translate({ messageId: 'msg1', text: 'Hello' })

    expect(result).toEqual({
      messageId: 'msg1',
      error: { type: 'rate_limited', message: 'Rate limited (429)', retryAfterMs: 1_000 },
    })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  }, 15_000)

  it('does not retry on non-rate-limit errors', async () => {
    mockProvider.translateBatch.mockResolvedValue([
      { id: 'msg1', translatedText: undefined, error: 'Invalid API key' },
    ])

    const translator = createTranslator()
    const result = await translator.translate({ messageId: 'msg1', text: 'Hello' })

    expect(result).toEqual({
      messageId: 'msg1',
      error: { type: 'unknown', message: 'Invalid API key' },
    })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('handles network errors during retry', async () => {
    mockProvider.translateBatch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce([
        { id: 'msg1', translatedText: '翻譯結果' },
      ])

    const translator = createTranslator({ debounceMs: 0 })
    const result = await translator.translate({ messageId: 'msg1', text: 'Hello' })

    expect(result).toEqual({ messageId: 'msg1', translatedText: '翻譯結果' })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(2)
  }, 15_000)

  it('returns network error after max retries on network errors', async () => {
    mockProvider.translateBatch.mockRejectedValue(new Error('Network error'))

    const translator = createTranslator({ maxRetries: 2 })
    const result = await translator.translate({ messageId: 'msg1', text: 'Hello' })

    expect(result).toEqual({
      messageId: 'msg1',
      error: { type: 'network', message: 'Network error' },
    })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  }, 15_000)
})