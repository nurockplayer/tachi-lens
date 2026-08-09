import { describe, expect, it, vi } from 'vitest'
import {
  getSpeechProvider,
  getSpeechProviderMetadata,
  isAllowedSpeechProviderEndpoint,
  listSpeechProviderMetadata,
} from './speech-registry'

const mockFetchOk = () => vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

describe('speech provider registry', () => {
  it('lists exactly one speech provider (Gemini) in v0.3', () => {
    expect(listSpeechProviderMetadata().map((provider) => provider.id)).toEqual(['gemini'])
  })

  it('exposes the Gemini speech model list and default model', () => {
    expect(getSpeechProviderMetadata('gemini')).toMatchObject({
      id: 'gemini',
      displayName: 'Gemini',
      defaultModel: 'gemini-2.5-flash',
      models: [
        { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
        { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
      ],
      endpointOrigins: ['https://generativelanguage.googleapis.com'],
    })
  })

  it('guards unknown speech provider ids', () => {
    expect(getSpeechProviderMetadata('not-real')).toBeUndefined()
    expect(getSpeechProviderMetadata('deepseek')).toBeUndefined()
  })

  it('allows only the registered Gemini HTTPS origin for speech', () => {
    expect(isAllowedSpeechProviderEndpoint('gemini', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')).toBe(true)
    expect(isAllowedSpeechProviderEndpoint('gemini', 'https://evil.example/v1beta/models')).toBe(false)
    expect(isAllowedSpeechProviderEndpoint('gemini', 'http://generativelanguage.googleapis.com/v1beta')).toBe(false)
    expect(isAllowedSpeechProviderEndpoint('unknown', 'https://generativelanguage.googleapis.com/v1beta')).toBe(false)
  })

  describe('getSpeechProvider', () => {
    it('returns a SpeechProvider for the gemini speech provider id', () => {
      const provider = getSpeechProvider('gemini', mockFetchOk())

      expect(provider).toBeDefined()
      expect(provider!.id).toBe('gemini')
      expect(provider!.defaultModel).toBe('gemini-2.5-flash')
      expect(provider!.models.length).toBeGreaterThan(0)
      expect(typeof provider!.transcribeChunk).toBe('function')
      expect(typeof provider!.validateKey).toBe('function')
    })

    it('returns undefined for an unknown speech provider id', () => {
      expect(getSpeechProvider('unknown' as never)).toBeUndefined()
    })
  })
})
