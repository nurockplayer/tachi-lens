import { CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS, createClaudeProvider } from './claude'
import { DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_MODELS, createDeepSeekProvider } from './deepseek'
import { GEMINI_DEFAULT_MODEL, GEMINI_MODELS, createGeminiProvider } from './gemini'
import { OPENAI_DEFAULT_MODEL, OPENAI_MODELS, createOpenAIProvider } from './openai'
import { isProviderId, PROVIDER_IDS, type ProviderId, type ProviderModel } from './types'
import type { TranslationProvider } from './types'

export interface ProviderMetadata {
  id: ProviderId
  displayName: string
  models: ProviderModel[]
  defaultModel: string
  endpointOrigins: readonly string[]
}

const PROVIDERS: Record<ProviderId, ProviderMetadata> = {
  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    defaultModel: GEMINI_DEFAULT_MODEL,
    models: GEMINI_MODELS,
    endpointOrigins: ['https://generativelanguage.googleapis.com'],
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    defaultModel: DEEPSEEK_DEFAULT_MODEL,
    models: DEEPSEEK_MODELS,
    endpointOrigins: ['https://api.deepseek.com'],
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    defaultModel: OPENAI_DEFAULT_MODEL,
    models: OPENAI_MODELS,
    endpointOrigins: ['https://api.openai.com'],
  },
  claude: {
    id: 'claude',
    displayName: 'Claude',
    defaultModel: CLAUDE_DEFAULT_MODEL,
    models: CLAUDE_MODELS,
    endpointOrigins: ['https://api.anthropic.com'],
  },
}

export const listProviderMetadata = (): ProviderMetadata[] =>
  PROVIDER_IDS.map((providerId) => PROVIDERS[providerId])

export const providerExists = (providerId: string): providerId is ProviderId => isProviderId(providerId)

export const getProviderMetadata = (providerId: string): ProviderMetadata | undefined =>
  providerExists(providerId) ? PROVIDERS[providerId] : undefined

export const isAllowedProviderEndpoint = (providerId: string, endpoint: string): boolean => {
  const provider = getProviderMetadata(providerId)

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

type ProviderFactory = (fetchFn?: typeof globalThis.fetch) => TranslationProvider

const PROVIDER_FACTORIES: Record<ProviderId, ProviderFactory> = {
  gemini: createGeminiProvider,
  deepseek: createDeepSeekProvider,
  openai: createOpenAIProvider,
  claude: createClaudeProvider,
}

/** Create a TranslationProvider instance for the given id. */
export const getProvider = (
  providerId: ProviderId,
  fetchFn?: typeof globalThis.fetch,
): TranslationProvider | undefined => {
  const factory = PROVIDER_FACTORIES[providerId]

  return factory ? factory(fetchFn) : undefined
}
