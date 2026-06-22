import { describe, expect, it } from 'vitest'
import {
  getProviderMetadata,
  isAllowedProviderEndpoint,
  listProviderMetadata,
  providerExists,
} from './registry'

describe('provider registry', () => {
  it('lists first-phase providers in a stable UI order', () => {
    expect(listProviderMetadata().map((provider) => provider.id)).toEqual(['gemini', 'deepseek', 'openai', 'claude'])
  })

  it('exposes provider-owned model lists and default models', () => {
    expect(getProviderMetadata('deepseek')).toMatchObject({
      id: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      models: [
        { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
      ],
    })
  })

  it('guards unknown provider ids', () => {
    expect(providerExists('deepseek')).toBe(true)
    expect(providerExists('not-real')).toBe(false)
    expect(getProviderMetadata('not-real')).toBeUndefined()
  })

  it('allows only registered HTTPS provider endpoints', () => {
    expect(isAllowedProviderEndpoint('openai', 'https://api.openai.com/v1/chat/completions')).toBe(true)
    expect(isAllowedProviderEndpoint('openai', 'https://evil.example/v1/chat/completions')).toBe(false)
    expect(isAllowedProviderEndpoint('openai', 'http://api.openai.com/v1/chat/completions')).toBe(false)
  })
})
