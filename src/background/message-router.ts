import type { ProviderId, TranslationProvider } from '../providers/types'
import {
  isBaseMessage,
  isCredentialDeleteRequestMessage,
  isCredentialPreviewRequestMessage,
  isCredentialSaveRequestMessage,
  isContentSettingsRequestMessage,
  isTranslationRequestMessage,
} from '../shared/messages'
import type { TranslationRequest, TranslationResult } from '../shared/messages'
import type { CredentialScope } from '../shared/messages'
import { maskApiKey, type RuntimeState } from '../storage/settings'
import type { SpeechProviderId } from '@/providers/speech-types'
import { Translator } from './translator'

export interface RouterDependencies {
  translator: Translator
  getApiKey: (providerId: ProviderId) => Promise<string | undefined>
  getProvider: (providerId: ProviderId) => TranslationProvider | undefined
  getRuntimeState: () => Promise<RuntimeState | undefined>
  getContentSettings?: (channelName?: string) => Promise<unknown>
  saveApiKey?: (providerId: ProviderId, apiKey: string) => Promise<void>
  deleteApiKey?: (providerId: ProviderId) => Promise<void>
  getMaskedApiKeyForPopup?: (providerId: ProviderId) => Promise<string | undefined>
  saveSpeechApiKeyOverride?: (providerId: SpeechProviderId, apiKey: string) => Promise<void>
  deleteSpeechApiKeyOverride?: (providerId: SpeechProviderId) => Promise<void>
  getMaskedSpeechApiKeyForPopup?: (providerId: SpeechProviderId) => Promise<string | undefined>
  extensionId?: string
}

type SendResponse = (response: unknown) => void

const CONTENT_SAFE_TRANSLATION_ERROR_MESSAGE = 'Translation request failed'

const sanitizeTranslationResultForContent = (result: TranslationResult): TranslationResult => {
  if (!result.error) return result

  return {
    ...result,
    error: {
      ...result.error,
      message: CONTENT_SAFE_TRANSLATION_ERROR_MESSAGE,
    },
  }
}

const isChatTranslationDisabled = (settings: unknown): boolean =>
  typeof settings === 'object' && settings !== null && !Array.isArray(settings) &&
  (settings as { translationEnabled?: unknown }).translationEnabled === false

interface RuntimeMessageSender {
  tab?: { url?: unknown }
  url?: unknown
  id?: unknown
}

const isTrustedPopupSender = (sender: unknown, extensionId: string | undefined): boolean => {
  if (!extensionId || typeof sender !== 'object' || sender === null || Array.isArray(sender)) return false
  const candidate = sender as RuntimeMessageSender
  if (candidate.id !== extensionId || typeof candidate.url !== 'string') return false
  try {
    const url = new URL(candidate.url)
    // Extension Popup pages may run in a browser tab during packaged tests or
    // developer workflows. Sender URL and extension ID, rather than `tab`
    // absence, identify the credential UI; Twitch/content URLs never match.
    return url.protocol === 'chrome-extension:' && url.host === extensionId &&
      url.pathname === '/src/popup/index.html'
  } catch {
    return false
  }
}

const credentialMutationQueues = new Map<string, Promise<void>>()

const enqueueCredentialMutation = (key: string, operation: () => Promise<void>): Promise<void> => {
  const previous = credentialMutationQueues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  credentialMutationQueues.set(key, next)
  void next.finally(() => {
    if (credentialMutationQueues.get(key) === next) credentialMutationQueues.delete(key)
  }).catch(() => undefined)
  return next
}

/**
 * Resolve the Twitch channel associated with a content-script sender without
 * widening the translation-request protocol. Chrome's sender URL is trusted
 * runtime metadata; arbitrary payload fields are not.
 */
const getChannelNameFromSender = (sender: unknown): string | undefined => {
  if (typeof sender !== 'object' || sender === null || Array.isArray(sender)) return undefined

  const candidate = sender as RuntimeMessageSender
  const tabUrl = candidate.tab?.url
  const senderUrl = typeof tabUrl === 'string' ? tabUrl : candidate.url
  if (typeof senderUrl !== 'string') return undefined

  try {
    const url = new URL(senderUrl)
    const hostname = url.hostname.toLowerCase()
    if (hostname !== 'twitch.tv' && !hostname.endsWith('.twitch.tv')) return undefined

    const segments = url.pathname.split('/').filter(Boolean)
    const channel = segments[0]?.toLowerCase() === 'popout' ? segments[1] : segments[0]
    return channel?.toLowerCase()
  } catch {
    return undefined
  }
}

export interface MessageRouter {
  handleMessage(
    message: unknown,
    _sender: unknown,
    sendResponse: SendResponse,
  ): boolean
}

const handleTranslationRequest = async (
  payload: TranslationRequest,
  sender: unknown,
  sendResponse: SendResponse,
  deps: RouterDependencies,
): Promise<void> => {
  try {
    const channelName = getChannelNameFromSender(sender)
    const settings = channelName === undefined
      ? await deps.getContentSettings?.()
      : await deps.getContentSettings?.(channelName)
    if (isChatTranslationDisabled(settings)) {
      sendResponse({
        type: 'translate_response',
        payload: { messageId: payload.messageId },
      })
      return
    }

    const result = channelName === undefined
      ? await deps.translator.translate(payload)
      : await deps.translator.translate(payload, { channelName })
    sendResponse({
      type: 'translate_response',
      payload: sanitizeTranslationResultForContent(result),
    })
  } catch {
    sendResponse({
      type: 'translate_response',
      payload: {
        messageId: payload.messageId,
        error: { type: 'unknown', message: CONTENT_SAFE_TRANSLATION_ERROR_MESSAGE },
      },
    })
  }
}

export const createMessageRouter = (deps: RouterDependencies): MessageRouter => ({
  handleMessage(message, sender, sendResponse) {
    if (isTranslationRequestMessage(message)) {
      void handleTranslationRequest(message.payload, sender, sendResponse, deps)

      return true
    }

    if (isContentSettingsRequestMessage(message)) {
      if (!deps.getContentSettings) {
        sendResponse({
          type: 'content_settings',
          payload: { error: 'getContentSettings not available' },
        })

        return false
      }

      deps
        .getContentSettings(message.payload?.channelName)
        .then((settings) => sendResponse({ type: 'content_settings', payload: settings }))
        .catch((err: unknown) =>
          sendResponse({
            type: 'content_settings',
            payload: { error: getErrorMessage(err) },
          }),
        )

      return true
    }

    if (isCredentialSaveRequestMessage(message)) {
      if (!isTrustedPopupSender(sender, deps.extensionId)) return false
      void enqueueCredentialMutation('credential', () =>
        handleSaveApiKey(message.payload, sendResponse, deps),
      )
      return true
    }

    if (isCredentialDeleteRequestMessage(message)) {
      if (!isTrustedPopupSender(sender, deps.extensionId)) return false
      void enqueueCredentialMutation('credential', () =>
        handleDeleteApiKey(message.payload, sendResponse, deps),
      )
      return true
    }

    if (isCredentialPreviewRequestMessage(message)) {
      if (!isTrustedPopupSender(sender, deps.extensionId)) return false
      void handleGetApiKeyPreview(message.payload, sendResponse, deps)
      return true
    }

    if (isBaseMessage(message)) {
      if (message.type === 'validate_key') {
        handleValidateKey(message.payload, sendResponse, deps)

        return true
      }

      if (message.type === 'provider_status') {
        deps
          .getRuntimeState()
          .then((state) =>
            sendResponse({
              type: 'provider_status',
              payload: state ?? {},
            }),
          )

        return true
      }

    }

    return false
  },
})

const handleValidateKey = async (
  payload: unknown,
  sendResponse: SendResponse,
  deps: RouterDependencies,
): Promise<void> => {
  const providerId = (payload as Record<string, unknown>)?.providerId as string | undefined

  if (!providerId) {
    sendResponse({
      type: 'key_validation_result',
      payload: { valid: false, error: 'Missing providerId' },
    })

    return
  }

  const provider = deps.getProvider(providerId as ProviderId)

  if (!provider) {
    sendResponse({
      type: 'key_validation_result',
      payload: { valid: false, error: `Provider "${providerId}" not found` },
    })

    return
  }

  const apiKey = await deps.getApiKey(providerId as ProviderId)

  if (!apiKey) {
    sendResponse({
      type: 'key_validation_result',
      payload: { valid: false, error: 'No API key configured' },
    })

    return
  }

  const result = await provider.validateKey(apiKey)

  sendResponse({ type: 'key_validation_result', payload: result })
}

const handleSaveApiKey = async (
  payload: { providerId: string; apiKey: string; scope?: CredentialScope },
  sendResponse: SendResponse,
  deps: RouterDependencies,
): Promise<void> => {
  try {
    const speechScope = payload.scope === 'speech'
    if (speechScope) {
      if (!deps.saveSpeechApiKeyOverride) throw new Error('speech credential storage unavailable')
      await deps.saveSpeechApiKeyOverride(payload.providerId as SpeechProviderId, payload.apiKey)
    } else {
      if (!deps.saveApiKey) throw new Error('shared credential storage unavailable')
      await deps.saveApiKey(payload.providerId as ProviderId, payload.apiKey)
    }
    const preview = maskApiKey(payload.apiKey.trim())
    sendResponse({ type: 'save_api_key_result', payload: { success: true, preview } })
  } catch {
    sendResponse({ type: 'save_api_key_result', payload: { success: false, error: 'Credential save failed' } })
  }
}

const handleDeleteApiKey = async (
  payload: { providerId: string; scope?: CredentialScope },
  sendResponse: SendResponse,
  deps: RouterDependencies,
): Promise<void> => {
  try {
    if (payload.scope === 'speech') {
      if (!deps.deleteSpeechApiKeyOverride) throw new Error('speech credential storage unavailable')
      await deps.deleteSpeechApiKeyOverride(payload.providerId as SpeechProviderId)
    } else {
      if (!deps.deleteApiKey) throw new Error('shared credential storage unavailable')
      await deps.deleteApiKey(payload.providerId as ProviderId)
    }
    sendResponse({ type: 'delete_api_key_result', payload: { success: true } })
  } catch {
    sendResponse({ type: 'delete_api_key_result', payload: { success: false, error: 'Credential delete failed' } })
  }
}

const handleGetApiKeyPreview = async (
  payload: { providerId: string; scope?: CredentialScope },
  sendResponse: SendResponse,
  deps: RouterDependencies,
): Promise<void> => {
  try {
    const preview = payload.scope === 'speech'
      ? await deps.getMaskedSpeechApiKeyForPopup?.(payload.providerId as SpeechProviderId)
      : await deps.getMaskedApiKeyForPopup?.(payload.providerId as ProviderId)
    sendResponse({ type: 'api_key_preview', payload: { preview: preview ?? '' } })
  } catch {
    sendResponse({ type: 'api_key_preview', payload: { preview: '' } })
  }
}

const getErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Unknown runtime error'
