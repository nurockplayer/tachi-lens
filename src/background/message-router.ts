import type { ProviderId, TranslationProvider } from '../providers/types'
import {
  isBaseMessage,
  isTranslationRequestMessage,
} from '../shared/messages'
import type { RuntimeState } from '../storage/settings'
import { Translator } from './translator'

export interface RouterDependencies {
  translator: Translator
  getApiKey: (providerId: ProviderId) => Promise<string | undefined>
  getProvider: (providerId: ProviderId) => TranslationProvider | undefined
  getRuntimeState: () => Promise<RuntimeState | undefined>
  saveApiKey?: (providerId: ProviderId, apiKey: string) => Promise<void>
  deleteApiKey?: (providerId: ProviderId) => Promise<void>
  getMaskedApiKeyForPopup?: (providerId: ProviderId) => Promise<string | undefined>
}

type SendResponse = (response: unknown) => void

export interface MessageRouter {
  handleMessage(
    message: unknown,
    _sender: unknown,
    sendResponse: SendResponse,
  ): boolean
}

export const createMessageRouter = (deps: RouterDependencies): MessageRouter => ({
  handleMessage(message, _sender, sendResponse) {
    if (isTranslationRequestMessage(message)) {
      deps.translator
        .translate(message.payload)
        .then((result) => sendResponse({ type: 'translate_response', payload: result }))

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

      if (message.type === 'save_api_key') {
        handleSaveApiKey(message.payload, sendResponse, deps)

        return true
      }

      if (message.type === 'delete_api_key') {
        handleDeleteApiKey(message.payload, sendResponse, deps)

        return true
      }

      if (message.type === 'get_api_key_preview') {
        handleGetApiKeyPreview(message.payload, sendResponse, deps)

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
  payload: unknown,
  sendResponse: SendResponse,
  deps: RouterDependencies,
): Promise<void> => {
  const p = payload as Record<string, unknown> | undefined
  const providerId = p?.providerId as string | undefined
  const apiKey = p?.apiKey as string | undefined

  if (!providerId) {
    sendResponse({ type: 'save_api_key_result', payload: { success: false, error: 'Missing providerId' } })
    return
  }

  if (!deps.saveApiKey) {
    sendResponse({ type: 'save_api_key_result', payload: { success: false, error: 'saveApiKey not available' } })
    return
  }

  await deps.saveApiKey(providerId as ProviderId, apiKey ?? '')

  const preview = await deps.getMaskedApiKeyForPopup?.(providerId as ProviderId)

  sendResponse({ type: 'save_api_key_result', payload: { success: true, preview } })
}

const handleDeleteApiKey = async (
  payload: unknown,
  sendResponse: SendResponse,
  deps: RouterDependencies,
): Promise<void> => {
  const providerId = (payload as Record<string, unknown> | undefined)?.providerId as string | undefined

  if (!providerId) {
    sendResponse({ type: 'delete_api_key_result', payload: { success: false, error: 'Missing providerId' } })
    return
  }

  await deps.deleteApiKey?.(providerId as ProviderId)
  sendResponse({ type: 'delete_api_key_result', payload: { success: true } })
}

const handleGetApiKeyPreview = async (
  payload: unknown,
  sendResponse: SendResponse,
  deps: RouterDependencies,
): Promise<void> => {
  const providerId = (payload as Record<string, unknown> | undefined)?.providerId as string | undefined

  if (!providerId) {
    sendResponse({ type: 'api_key_preview', payload: { preview: '' } })
    return
  }

  const preview = await deps.getMaskedApiKeyForPopup?.(providerId as ProviderId)

  sendResponse({ type: 'api_key_preview', payload: { preview: preview ?? '' } })
}
