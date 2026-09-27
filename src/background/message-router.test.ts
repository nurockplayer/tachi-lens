import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProviderId, type TranslationProvider } from '@/providers/types'
import { TranslationCache } from './cache'
import { RateLimiter } from './rate-limiter'
import { Translator } from './translator'
import { createMessageRouter, type RouterDependencies } from './message-router'
import { maskApiKey } from '@/storage/settings'

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
    { batchWindowMs: 300, maxBatchSize: 10 },
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
      extensionId: 'extension-id',
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

  describe('provider credential scope', () => {
    it('routes explicit speech overrides through masked popup previews', async () => {
      const saveApiKey = vi.fn(async () => undefined)
      const deleteApiKey = vi.fn(async () => undefined)
      const saveSpeechApiKeyOverride = vi.fn(async () => undefined)
      const deleteSpeechApiKeyOverride = vi.fn(async () => undefined)
      const { router } = makeRouter({
        saveApiKey,
        deleteApiKey,
        getMaskedApiKeyForPopup: vi.fn(async () => 'shared***view'),
        saveSpeechApiKeyOverride,
        deleteSpeechApiKeyOverride,
        getMaskedSpeechApiKeyForPopup: vi.fn(async () => 'over***view'),
      })
      const sendResponse = vi.fn()

      router.handleMessage({
        type: 'save_api_key',
        payload: { providerId: 'gemini', apiKey: 'fixture-speech-secret', scope: 'speech' },
      }, {
        id: 'extension-id',
        url: 'chrome-extension://extension-id/src/popup/index.html',
        tab: { url: 'chrome-extension://extension-id/src/popup/index.html' },
      }, sendResponse)
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
        type: 'save_api_key_result',
        payload: { success: true, preview: maskApiKey('fixture-speech-secret') },
      }))
      expect(saveSpeechApiKeyOverride).toHaveBeenCalledWith('gemini', 'fixture-speech-secret')
      expect(saveApiKey).not.toHaveBeenCalled()
      expect(JSON.stringify(sendResponse.mock.calls)).not.toContain('fixture-speech-secret')

      sendResponse.mockClear()
      router.handleMessage({
        type: 'delete_api_key',
        payload: { providerId: 'gemini', scope: 'speech' },
      }, {
        id: 'extension-id',
        url: 'chrome-extension://extension-id/src/popup/index.html',
        tab: { url: 'chrome-extension://extension-id/src/popup/index.html' },
      }, sendResponse)
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
        type: 'delete_api_key_result', payload: { success: true },
      }))
      expect(deleteSpeechApiKeyOverride).toHaveBeenCalledWith('gemini')
      expect(deleteApiKey).not.toHaveBeenCalled()
    })

    it('rejects credential mutation from content scripts and malformed key types', () => {
      const saveApiKey = vi.fn(async () => undefined)
      const { router } = makeRouter({ saveApiKey })
      const sendResponse = vi.fn()
      const payload = { type: 'save_api_key', payload: { providerId: 'gemini', apiKey: 'key' } }

      expect(router.handleMessage(payload, { id: 'extension-id', tab: { url: 'https://www.twitch.tv/channel' } }, sendResponse)).toBe(false)
      expect(router.handleMessage({ ...payload, payload: { providerId: 'gemini', apiKey: 42 } }, {
        id: 'extension-id', url: 'chrome-extension://extension-id/src/popup/index.html',
      }, sendResponse)).toBe(false)
      expect(saveApiKey).not.toHaveBeenCalled()
      expect(sendResponse).not.toHaveBeenCalled()
    })

    it('returns a bounded failed acknowledgement when credential persistence fails', async () => {
      const { router } = makeRouter({
        saveSpeechApiKeyOverride: vi.fn(async () => { throw new Error('storage unavailable') }),
      })
      const sendResponse = vi.fn()

      expect(router.handleMessage({
        type: 'save_api_key',
        payload: { providerId: 'gemini', apiKey: 'fixture-secret', scope: 'speech' },
      }, {
        id: 'extension-id',
        url: 'chrome-extension://extension-id/src/popup/index.html',
        tab: { url: 'chrome-extension://extension-id/src/popup/index.html' },
      }, sendResponse)).toBe(true)
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
        type: 'save_api_key_result', payload: { success: false, error: 'Credential save failed' },
      }))
      expect(JSON.stringify(sendResponse.mock.calls)).not.toContain('fixture-secret')
    })

    it('acknowledges a committed save when the separate preview read fails', async () => {
      const saveApiKey = vi.fn(async () => undefined)
      const { router } = makeRouter({
        saveApiKey,
        getMaskedApiKeyForPopup: vi.fn(async () => { throw new Error('preview read unavailable') }),
      })
      const sendResponse = vi.fn()

      router.handleMessage({
        type: 'save_api_key',
        payload: { providerId: 'gemini', apiKey: '  fixture-committed-key  ' },
      }, {
        id: 'extension-id',
        url: 'chrome-extension://extension-id/src/popup/index.html',
      }, sendResponse)

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
        type: 'save_api_key_result',
        payload: { success: true, preview: maskApiKey('fixture-committed-key') },
      }))
      expect(saveApiKey).toHaveBeenCalledWith('gemini', '  fixture-committed-key  ')
      expect(JSON.stringify(sendResponse.mock.calls)).not.toContain('fixture-committed-key')
    })

    it('marks a failed bounded preview read as unavailable instead of absent', async () => {
      const { router } = makeRouter({
        getMaskedSpeechApiKeyForPopup: vi.fn(async () => { throw new Error('preview read unavailable') }),
      })
      const sendResponse = vi.fn()

      router.handleMessage({
        type: 'get_api_key_preview', payload: { providerId: 'gemini', scope: 'speech' },
      }, {
        id: 'extension-id', url: 'chrome-extension://extension-id/src/popup/index.html',
      }, sendResponse)

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({
        type: 'api_key_preview', payload: { preview: '', success: false },
      }))
    })

    it('serializes same-provider save and delete mutations in request order', async () => {
      let finishSave!: () => void
      const saveGate = new Promise<void>((resolve) => { finishSave = resolve })
      const operations: string[] = []
      const { router } = makeRouter({
        saveSpeechApiKeyOverride: vi.fn(async () => { operations.push('save-start'); await saveGate; operations.push('save-finish') }),
        deleteSpeechApiKeyOverride: vi.fn(async () => { operations.push('delete') }),
      })
      const sender = {
        id: 'extension-id', url: 'chrome-extension://extension-id/src/popup/index.html',
        tab: { url: 'chrome-extension://extension-id/src/popup/index.html' },
      }
      const sendResponse = vi.fn()

      router.handleMessage({ type: 'save_api_key', payload: { providerId: 'gemini', apiKey: 'first', scope: 'speech' } }, sender, sendResponse)
      router.handleMessage({ type: 'delete_api_key', payload: { providerId: 'gemini', scope: 'speech' } }, sender, sendResponse)
      await vi.waitFor(() => expect(operations).toEqual(['save-start']))
      finishSave()
      await vi.waitFor(() => expect(operations).toEqual(['save-start', 'save-finish', 'delete']))
    })

    it('serializes different-provider saves across the shared map read-modify-write', async () => {
      let apiKeys: Record<string, string> = {}
      let previews: Record<string, string> = {}
      const started: string[] = []
      const releases: Array<() => void> = []
      const saveApiKey = vi.fn(async (providerId: ProviderId, apiKey: string) => {
        const keysSnapshot = { ...apiKeys }
        const previewsSnapshot = { ...previews }
        started.push(providerId)
        await new Promise<void>((resolve) => releases.push(resolve))
        apiKeys = { ...keysSnapshot, [providerId]: apiKey.trim() }
        previews = { ...previewsSnapshot, [providerId]: maskApiKey(apiKey.trim()) }
      })
      const { router } = makeRouter({
        saveApiKey,
        getMaskedApiKeyForPopup: vi.fn(async (providerId) => previews[providerId] ?? ''),
      })
      const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/popup/index.html' }
      const sendResponse = vi.fn()

      router.handleMessage({ type: 'save_api_key', payload: { providerId: 'gemini', apiKey: 'gem-key' } }, sender, sendResponse)
      router.handleMessage({ type: 'save_api_key', payload: { providerId: 'deepseek', apiKey: 'deep-key' } }, sender, sendResponse)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      const simultaneousMutations = started.length

      releases[0]!()
      await vi.waitFor(() => expect(started).toHaveLength(2))
      releases[1]!()
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(2))

      expect(simultaneousMutations).toBe(1)
      expect(apiKeys).toEqual({ gemini: 'gem-key', deepseek: 'deep-key' })
      expect(previews).toEqual({ gemini: maskApiKey('gem-key'), deepseek: maskApiKey('deep-key') })
    })

    it('serializes a different-provider save and delete without losing or restoring map entries', async () => {
      let apiKeys: Record<string, string> = { deepseek: 'deep-old' }
      let previews: Record<string, string> = { deepseek: maskApiKey('deep-old') }
      const started: string[] = []
      const releases: Array<() => void> = []
      const mutate = async (kind: string, providerId: ProviderId, apiKey?: string): Promise<void> => {
        const keysSnapshot = { ...apiKeys }
        const previewsSnapshot = { ...previews }
        started.push(kind)
        await new Promise<void>((resolve) => releases.push(resolve))
        if (kind === 'save') {
          apiKeys = { ...keysSnapshot, [providerId]: apiKey!.trim() }
          previews = { ...previewsSnapshot, [providerId]: maskApiKey(apiKey!.trim()) }
        } else {
          delete keysSnapshot[providerId]
          delete previewsSnapshot[providerId]
          apiKeys = keysSnapshot
          previews = previewsSnapshot
        }
      }
      const { router } = makeRouter({
        saveApiKey: vi.fn(async (providerId: ProviderId, apiKey: string) => mutate('save', providerId, apiKey)),
        deleteApiKey: vi.fn(async (providerId: ProviderId) => mutate('delete', providerId)),
        getMaskedApiKeyForPopup: vi.fn(async (providerId) => previews[providerId] ?? ''),
      })
      const sender = { id: 'extension-id', url: 'chrome-extension://extension-id/src/popup/index.html' }
      const sendResponse = vi.fn()

      router.handleMessage({ type: 'save_api_key', payload: { providerId: 'gemini', apiKey: 'gem-new' } }, sender, sendResponse)
      router.handleMessage({ type: 'delete_api_key', payload: { providerId: 'deepseek' } }, sender, sendResponse)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      const simultaneousMutations = started.length

      releases[0]!()
      await vi.waitFor(() => expect(started).toHaveLength(2))
      releases[1]!()
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(2))

      expect(simultaneousMutations).toBe(1)
      expect(apiKeys).toEqual({ gemini: 'gem-new' })
      expect(previews).toEqual({ gemini: maskApiKey('gem-new') })
    })
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

      vi.advanceTimersByTime(300)
      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledTimes(1)
      })

      const response = sendResponse.mock.calls[0]![0]
      expect(response.type).toBe('translate_response')
      expect(response.payload.messageId).toBe('m1')
    })

    it('short-circuits a request when persisted chat translation is disabled', async () => {
      const translator = {
        translate: vi.fn(),
      } as unknown as Translator
      const getContentSettings = vi.fn(async () => ({ translationEnabled: false }))
      const { router } = makeRouter({ translator, getContentSettings })
      const sendResponse = vi.fn()

      const result = router.handleMessage(
        { type: 'translate_request', payload: { messageId: 'm-disabled', text: 'Hello' } },
        undefined,
        sendResponse,
      )

      expect(result).toBe(true)

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({
          type: 'translate_response',
          payload: { messageId: 'm-disabled' },
        })
      })
      expect(getContentSettings).toHaveBeenCalledWith()
      expect(translator.translate).not.toHaveBeenCalled()
    })

    it('checks the sender tab channel when guarding a translation request', async () => {
      const translator = {
        translate: vi.fn(),
      } as unknown as Translator
      const getContentSettings = vi.fn(async (channelName?: string) => ({
        translationEnabled: channelName !== 'channel-off',
      }))
      const { router } = makeRouter({ translator, getContentSettings })
      const sendResponse = vi.fn()

      router.handleMessage(
        { type: 'translate_request', payload: { messageId: 'm-channel-off', text: 'Hello' } },
        { tab: { url: 'https://www.twitch.tv/channel-off' } },
        sendResponse,
      )

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({
          type: 'translate_response',
          payload: { messageId: 'm-channel-off' },
        })
      })
      expect(getContentSettings).toHaveBeenCalledWith('channel-off')
      expect(translator.translate).not.toHaveBeenCalled()
    })

    it('checks the actual channel for a Twitch popout chat sender', async () => {
      const translator = {
        translate: vi.fn(),
      } as unknown as Translator
      const getContentSettings = vi.fn(async (channelName?: string) => ({
        translationEnabled: channelName !== 'channel-off',
      }))
      const { router } = makeRouter({ translator, getContentSettings })
      const sendResponse = vi.fn()

      router.handleMessage(
        { type: 'translate_request', payload: { messageId: 'm-popout-off', text: 'Hello' } },
        { tab: { url: 'https://www.twitch.tv/popout/channel-off/chat' } },
        sendResponse,
      )

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({
          type: 'translate_response',
          payload: { messageId: 'm-popout-off' },
        })
      })
      expect(getContentSettings).toHaveBeenCalledWith('channel-off')
      expect(translator.translate).not.toHaveBeenCalled()
    })

    it('carries the trusted sender channel into queued translation work', async () => {
      const translate = vi.fn(async (request: { messageId: string }) => ({
        messageId: request.messageId,
        translatedText: 'translated',
      }))
      const translator = { translate } as unknown as Translator
      const getContentSettings = vi.fn(async () => ({ translationEnabled: true }))
      const { router } = makeRouter({ translator, getContentSettings })
      const sendResponse = vi.fn()
      const payload = { messageId: 'm-channel-on', text: 'Hello' }

      router.handleMessage(
        { type: 'translate_request', payload },
        { tab: { url: 'https://www.twitch.tv/channel-on' } },
        sendResponse,
      )

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1))
      expect(translate).toHaveBeenCalledWith(payload, { channelName: 'channel-on' })
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

    it('does not expose a rejected translation error to the content script', async () => {
      const translator = {
        translate: vi.fn(async () => {
          throw new Error('settings unavailable for sk-secret-key')
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
      expect(response.payload.error.message).toBe('Translation request failed')
      expect(JSON.stringify(response)).not.toContain('sk-secret-key')
    })

    it('does not expose provider error content to the content script', async () => {
      const translator = {
        translate: vi.fn(async () => ({
          messageId: 'm1',
          error: {
            type: 'bad_request' as const,
            status: 400,
            message: 'Request contained Private chat text and key sk-secret-key',
          },
        })),
      } as unknown as Translator
      const { router } = makeRouter({ translator })
      const sendResponse = vi.fn()

      router.handleMessage(
        { type: 'translate_request', payload: { messageId: 'm1', text: 'Private chat text' } },
        undefined,
        sendResponse,
      )

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledTimes(1)
      })

      const response = sendResponse.mock.calls[0]![0]
      expect(response.payload.error.message).toBe('Translation request failed')
      expect(JSON.stringify(response)).not.toContain('Private chat text')
      expect(JSON.stringify(response)).not.toContain('sk-secret-key')
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

    it('delivers the Chinese variant mode in the content_settings response', async () => {
      const getContentSettings = vi.fn(async () => ({
        translationEnabled: true,
        targetLanguage: 'zh-TW',
        chineseVariantMode: 'translate_other_script',
      }))
      const { router } = makeRouter({ getContentSettings })
      const sendResponse = vi.fn()

      router.handleMessage(
        { type: 'get_content_settings', payload: { channelName: 'mychannel' } },
        undefined,
        sendResponse,
      )

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledTimes(1)
      })

      expect(sendResponse.mock.calls[0]![0]).toEqual({
        type: 'content_settings',
        payload: {
          translationEnabled: true,
          targetLanguage: 'zh-TW',
          chineseVariantMode: 'translate_other_script',
        },
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
