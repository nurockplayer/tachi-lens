import { describe, expect, it, vi } from 'vitest'
import {
  getProvider,
  getProviderMetadata,
  isAllowedProviderEndpoint,
  listProviderMetadata,
  providerExists,
} from './registry'

const mockFetchOk = () => vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

describe('provider registry', () => {
  it('lists first-phase providers in a stable UI order', () => {
    expect(listProviderMetadata().map((provider) => provider.id)).toEqual(['gemini', 'deepseek', 'openai', 'claude'])
  })

  it('exposes provider-owned model lists and default models', () => {
    expect(getProviderMetadata('gemini')).toMatchObject({
      id: 'gemini',
      defaultModel: 'gemini-3.8-flash',
      models: [
        { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
        { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
        { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
      ],
    })

    expect(getProviderMetadata('deepseek')).toMatchObject({
      id: 'deepseek',
      defaultModel: 'deepseek-flash',
      models: [
        { id: 'deepseek-flash', displayName: 'DeepSeek Flash' },
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

  describe('getProvider', () => {
    it('returns a TranslationProvider for each registered provider id', () => {
      for (const id of ['gemini', 'deepseek', 'openai', 'claude'] as const) {
        const provider = getProvider(id, mockFetchOk())

        expect(provider).toBeDefined()
        expect(provider!.id).toBe(id)
        expect(provider!.models.length).toBeGreaterThan(0)
        expect(typeof provider!.translateBatch).toBe('function')
        expect(typeof provider!.validateKey).toBe('function')
      }
    })

    it('returns undefined for unknown provider id', () => {
      expect(getProvider('unknown' as never)).toBeUndefined()
    })
  })
})
