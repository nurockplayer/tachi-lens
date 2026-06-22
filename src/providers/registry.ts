import { isProviderId, PROVIDER_IDS, type ProviderId, type ProviderModel } from './types'

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
    defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
    ],
    endpointOrigins: ['https://generativelanguage.googleapis.com'],
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    defaultModel: 'deepseek-v4-flash',
    models: [
      { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
    ],
    endpointOrigins: ['https://api.deepseek.com'],
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    models: [
      { id: 'gpt-4o-mini', displayName: 'GPT-4o mini' },
      { id: 'gpt-4o', displayName: 'GPT-4o' },
    ],
    endpointOrigins: ['https://api.openai.com'],
  },
  claude: {
    id: 'claude',
    displayName: 'Claude',
    defaultModel: 'claude-3-5-haiku-latest',
    models: [
      { id: 'claude-3-5-haiku-latest', displayName: 'Claude 3.5 Haiku' },
      { id: 'claude-3-5-sonnet-latest', displayName: 'Claude 3.5 Sonnet' },
    ],
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
