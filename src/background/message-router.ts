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
