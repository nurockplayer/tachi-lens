import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProviderId, type TranslationProvider } from '@/providers/types'
import { TranslationCache } from './cache'
import { RateLimiter } from './rate-limiter'
import { Translator } from './translator'
import { createMessageRouter, type RouterDependencies } from './message-router'

const createMockProvider = (): TranslationProvider => ({
  id: 'deepseek',
  displayName: 'DeepSeek',
  models: [],
  defaultModel: 'deepseek-v4-flash',
  translateBatch: vi.fn<TranslationProvider['translateBatch']>().mockImplementation(
    async (requests) => requests.map((r) => ({ id: r.id, translatedText: `T-${r.text}` })),
  ),
  validateKey: vi.fn<TranslationProvider['validateKey']>().mockResolvedValue({ valid: true }),
})

const makeRouter = (routerDepOverrides?: Partial<RouterDependencies>) => {
  const cache = new TranslationCache()
  const rateLimiter = new RateLimiter({ maxBackoffMs: 60000 })
  const translator = new Translator(
    {
      cache,
      rateLimiter,
      getSettings: vi.fn(async () => ({
        selectedProvider: 'deepseek' as ProviderId,
        selectedModel: 'deepseek-v4-flash',
        targetLanguage: 'zh-TW',
      })),
      getApiKey: vi.fn(async () => 'test-key'),
      getProvider: vi.fn(() => createMockProvider()),
    },
    { debounceMs: 150, maxBatchSize: 10 },
  )

  return {
    router: createMessageRouter({
      translator,
      getApiKey: vi.fn(async (providerId: ProviderId) => `key-${providerId}`),
      getProvider: vi.fn(() => createMockProvider()),
      getRuntimeState: vi.fn(async () => ({
        activeProvider: 'deepseek' as ProviderId,
        validationInProgress: false,
      })),
      getContentSettings: vi.fn(async () => ({
        translationEnabled: true,
        targetLanguage: 'zh-TW',
      })),
      ...routerDepOverrides,
    }),
    translator,
  }
}

describe('MessageRouter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('translate_request', () => {
    it('routes a valid translation request to the translator', async () => {
      const { router } = makeRouter()
      const sendResponse = vi.fn()

      const result = router.handleMessage(
        { type: 'translate_request', payload: { messageId: 'm1', text: 'Hello' } },
        undefined,
        sendResponse,
      )

      expect(result).toBe(true)

      vi.advanceTimersByTime(150)
      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledTimes(1)
      })

      const response = sendResponse.mock.calls[0]![0]
      expect(response.type).toBe('translate_response')
      expect(response.payload.messageId).toBe('m1')
    })

    it('returns false for an invalid translate_request payload', () => {
      const { router } = makeRouter()
      const sendResponse = vi.fn()

      const result = router.handleMessage(
        { type: 'translate_request', payload: { messageId: 123 } },
        undefined,
        sendResponse,
      )

      expect(result).toBe(false)
      expect(sendResponse).not.toHaveBeenCalled()
    })

    it('sends a structured response when translation rejects', async () => {
      const translator = {
        translate: vi.fn(async () => {
          throw new Error('settings unavailable')
        }),
      } as unknown as Translator
      const { router } = makeRouter({ translator })
      const sendResponse = vi.fn()

      const result = router.handleMessage(
        { type: 'translate_request', payload: { messageId: 'm1', text: 'Hello' } },
        undefined,
        sendResponse,
      )

      expect(result).toBe(true)

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledTimes(1)
      })

      const response = sendResponse.mock.calls[0]![0]
      expect(response.type).toBe('translate_response')
      expect(response.payload.messageId).toBe('m1')
      expect(response.payload.error.message).toBe('settings unavailable')
    })
  })

  describe('get_content_settings', () => {
    it('returns merged content settings from the service worker', async () => {
      const getContentSettings = vi.fn(async () => ({
        translationEnabled: true,
        targetLanguage: 'ja',
      }))
      const { router } = makeRouter({ getContentSettings })
      const sendResponse = vi.fn()

      const result = router.handleMessage(
        { type: 'get_content_settings', payload: { channelName: 'somechannel' } },
        undefined,
        sendResponse,
      )

      expect(result).toBe(true)

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledTimes(1)
      })

      expect(getContentSettings).toHaveBeenCalledWith('somechannel')
      expect(sendResponse.mock.calls[0]![0]).toEqual({
        type: 'content_settings',
        payload: { translationEnabled: true, targetLanguage: 'ja' },
      })
    })
  })

  describe('validate_key', () => {
    it('validates an API key and sends the result', async () => {
      const provider = createMockProvider()
      vi.mocked(provider.validateKey).mockResolvedValue({ valid: true })
      const { router } = makeRouter({
        getProvider: vi.fn(() => provider),
      })
      const sendResponse = vi.fn()

      const result = router.handleMessage(
        { type: 'validate_key', payload: { providerId: 'deepseek' } },
        undefined,
        sendResponse,
      )

      expect(result).toBe(true)

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledTimes(1)
      })

      const response = sendResponse.mock.calls[0]![0]
      expect(response.type).toBe('key_validation_result')
      expect(response.payload.valid).toBe(true)
    })

    it('returns invalid result when provider is not found', async () => {
      const { router } = makeRouter({
        getProvider: vi.fn(() => undefined),
      })
      const sendResponse = vi.fn()

      router.handleMessage(
        { type: 'validate_key', payload: { providerId: 'unknown' } },
        undefined,
        sendResponse,
      )

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledTimes(1)
      })

      const response = sendResponse.mock.calls[0]![0]
      expect(response.type).toBe('key_validation_result')
      expect(response.payload.valid).toBe(false)
    })
  })

  describe('provider_status', () => {
    it('returns the current runtime state', async () => {
      const { router } = makeRouter()
      const sendResponse = vi.fn()

      const result = router.handleMessage(
        { type: 'provider_status', payload: {} },
        undefined,
        sendResponse,
      )

      expect(result).toBe(true)

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledTimes(1)
      })

      const response = sendResponse.mock.calls[0]![0]
      expect(response.type).toBe('provider_status')
      expect(response.payload.activeProvider).toBe('deepseek')
    })
  })

  describe('unknown messages', () => {
    it('returns false for an unknown message type', () => {
      const { router } = makeRouter()

      const result = router.handleMessage(
        { type: 'unknown_type', payload: {} },
        undefined,
        vi.fn(),
      )

      expect(result).toBe(false)
    })

    it('returns false for a non-object message', () => {
      const { router } = makeRouter()

      const result = router.handleMessage('not a message', undefined, vi.fn())

      expect(result).toBe(false)
    })
  })
})
