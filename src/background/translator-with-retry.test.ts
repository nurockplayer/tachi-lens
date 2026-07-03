import { describe, expect, it, vi, beforeEach } from 'vitest'
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

const createTranslator = (opts?: { maxRetries?: number }) =>
  new TranslatorWithRetry(
    {
      cache: new TranslationCache(),
      rateLimiter: new RateLimiter({ maxBackoffMs: 60_000 }),
      getSettings: async () => mockSettings,
      getApiKey: async () => mockApiKey,
      getProvider: () => mockProvider,
      maxRetries: opts?.maxRetries ?? 3,
    },
  )

describe('TranslatorWithRetry', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns success on first attempt', async () => {
    mockProvider.translateBatch.mockResolvedValue([{ id: 'msg1', translatedText: 'OK' }])
    expect(await createTranslator().translate({ messageId: 'msg1', text: 'Hi' }))
      .toEqual({ messageId: 'msg1', translatedText: 'OK' })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(1)
  })

  it('retries on rate limit then succeeds', async () => {
    mockProvider.translateBatch
      .mockResolvedValueOnce([{ id: 'msg1', translatedText: undefined, error: 'Rate limited (429)' }])
      .mockResolvedValueOnce([{ id: 'msg1', translatedText: 'OK' }])

    expect(await createTranslator().translate({ messageId: 'msg1', text: 'Hi' }))
      .toEqual({ messageId: 'msg1', translatedText: 'OK' })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(2)
  })

  it('gives up after max retries', async () => {
    mockProvider.translateBatch.mockResolvedValue([{ id: 'msg1', translatedText: undefined, error: 'Rate limited (429)' }])

    const result = await createTranslator({ maxRetries: 2 }).translate({ messageId: 'msg1', text: 'Hi' })
    expect(result).toEqual({
      messageId: 'msg1',
      error: { type: 'rate_limited', message: 'Rate limited (429)', retryAfterMs: 1_000 },
    })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(3)
  })

  it('does not retry non-rate-limit errors', async () => {
    mockProvider.translateBatch.mockResolvedValue([{ id: 'msg1', translatedText: undefined, error: 'Invalid API key' }])

    expect(await createTranslator().translate({ messageId: 'msg1', text: 'Hi' }))
      .toEqual({ messageId: 'msg1', error: { type: 'unknown', message: 'Invalid API key' } })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(1)
  })

  it('retries on network error then succeeds', async () => {
    mockProvider.translateBatch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce([{ id: 'msg1', translatedText: 'OK' }])

    expect(await createTranslator().translate({ messageId: 'msg1', text: 'Hi' }))
      .toEqual({ messageId: 'msg1', translatedText: 'OK' })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(2)
  })

  it('returns network error after max retries', async () => {
    mockProvider.translateBatch.mockRejectedValue(new Error('Network error'))

    const result = await createTranslator({ maxRetries: 2 }).translate({ messageId: 'msg1', text: 'Hi' })
    expect(result).toEqual({ messageId: 'msg1', error: { type: 'network', message: 'Network error' } })
    expect(mockProvider.translateBatch).toHaveBeenCalledTimes(3)
  })
})