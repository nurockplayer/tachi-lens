// Speech provider registry — v0.3 speech translation wave (Spec §5).
// Mirrors registry.ts for the chat pipeline but is deliberately a separate
// module: speech has its own provider set (only Gemini in v0.3), its own
// metadata map, and its own endpoint allow-list.

import { createGeminiSpeechProvider } from './speech-gemini'
import {
  SPEECH_GEMINI_DEFAULT_MODEL,
  SPEECH_GEMINI_MODELS,
  isSpeechProviderId,
  type SpeechProvider,
  type SpeechProviderId,
} from './speech-types'
import type { ProviderModel } from './types'

export interface SpeechProviderMetadata {
  id: SpeechProviderId
  displayName: string
  models: readonly ProviderModel[]
  defaultModel: string
  endpointOrigins: readonly string[]
}

const SPEECH_PROVIDERS: Record<SpeechProviderId, SpeechProviderMetadata> = {
  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    defaultModel: SPEECH_GEMINI_DEFAULT_MODEL,
    models: SPEECH_GEMINI_MODELS,
    endpointOrigins: ['https://generativelanguage.googleapis.com'],
  },
}

export const listSpeechProviderMetadata = (): SpeechProviderMetadata[] =>
  Object.values(SPEECH_PROVIDERS)

export const getSpeechProviderMetadata = (providerId: string): SpeechProviderMetadata | undefined =>
  isSpeechProviderId(providerId) ? SPEECH_PROVIDERS[providerId] : undefined

export const isAllowedSpeechProviderEndpoint = (providerId: string, endpoint: string): boolean => {
  const provider = getSpeechProviderMetadata(providerId)

  if (!provider) {
    return false
  }

  try {
    const url = new URL(endpoint)

    return url.protocol === 'https:' && provider.endpointOrigins.includes(url.origin)
  } catch {
    return false
  }
}

type SpeechProviderFactory = (fetchFn?: typeof globalThis.fetch) => SpeechProvider

const SPEECH_PROVIDER_FACTORIES: Record<SpeechProviderId, SpeechProviderFactory> = {
  gemini: createGeminiSpeechProvider,
}

/** Create a SpeechProvider instance for the given id. */
export const getSpeechProvider = (
  providerId: SpeechProviderId,
  fetchFn?: typeof globalThis.fetch,
): SpeechProvider | undefined => {
  const factory = SPEECH_PROVIDER_FACTORIES[providerId]

  return factory ? factory(fetchFn) : undefined
}
