// Translator with Retry Tests
// Tests for automatic retry on rate limit errors.

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

const createTranslator = () =>
  new TranslatorWithRetry(
    {
      cache: new TranslationCache(),
      rateLimiter: new RateLimiter({ maxBackoffMs: 60_000 }),
      getSettings: async () => mockSettings,
      getApiKey: async () => mockApiKey,
      getProvider: () => mockProvider,
      maxRetries: 3,
    },
    { debounceMs: 0, maxBatchSize: 1 }, // Force single request per batch
  )

describe('TranslatorWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('succeeds on first attempt when no error', async () => {
    mockProvider.translateBatch.mockResolvedValue([
      { id: 'msg1', translatedText: '翻譯結果' },
    ])

    const translator = createTranslator()
    const result = await translator.translate({ messageId: 'msg1', text: 'Hello' })

    expect(result).toEqual({ messageId: 'msg1', translatedText: '翻譯結果' })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(1)
  })

  it('retries on rate limit error and succeeds on second attempt', async () => {
    mockProvider.translateBatch
      .mockResolvedValueOnce([
        { id: 'msg1', translatedText: undefined, error: 'Rate limited' },
      ])
      .mockResolvedValueOnce([
        { id: 'msg1', translatedText: '翻譯結果' },
      ])

    const translator = createTranslator()
    const result = await translator.translate({ messageId: 'msg1', text: 'Hello' })

    expect(result).toEqual({ messageId: 'msg1', translatedText: '翻譯結果' })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(2)
  })

  it('gives up after max retries and returns last error', async () => {
    mockProvider.translateBatch.mockResolvedValue([
      { id: 'msg1', translatedText: undefined, error: 'Rate limited' },
    ])

    const translator = createTranslator()
    const result = await translator.translate({ messageId: 'msg1', text: 'Hello' })

    expect(result).toEqual({
      messageId: 'msg1',
      error: { type: 'rate_limited', message: 'Rate limited', retryAfterMs: 1_000 },
    })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(4) // 1 initial + 3 retries
  })

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
  })

  it('respects retry-after delay from provider', async () => {
    mockProvider.translateBatch
      .mockResolvedValueOnce([
        { id: 'msg1', translatedText: undefined, error: 'Rate limited' },
      ])
      .mockResolvedValueOnce([
        { id: 'msg1', translatedText: '翻譯結果' },
      ])

    const translator = createTranslator()
    const result = await translator.translate({ messageId: 'msg1', text: 'Hello' })

    expect(result).toEqual({ messageId: 'msg1', translatedText: '翻譯結果' })
  })

  it('handles network errors during retry', async () => {
    mockProvider.translateBatch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce([
        { id: 'msg1', translatedText: '翻譯結果' },
      ])

    const translator = createTranslator()
    const result = await translator.translate({ messageId: 'msg1', text: 'Hello' })

    expect(result).toEqual({ messageId: 'msg1', translatedText: '翻譯結果' })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(2)
  })

  it('returns unknown error after max retries on network errors', async () => {
    mockProvider.translateBatch.mockRejectedValue(new Error('Network error'))

    const translator = createTranslator()
    const result = await translator.translate({ messageId: 'msg1', text: 'Hello' })

    expect(result).toEqual({
      messageId: 'msg1',
      error: { type: 'unknown', message: 'Network error' },
    })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(4) // 1 initial + 3 retries
  })
})