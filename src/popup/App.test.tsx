// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, maskApiKey } from '@/storage/settings'
import { PROVIDER_IDS } from '@/providers/types'
import { listProviderMetadata } from '@/providers/registry'
import { App, extractChannelFromUrl } from './App'

describe('extractChannelFromUrl', () => {
  it('extracts channel name from a standard Twitch URL', () => {
    expect(extractChannelFromUrl('https://www.twitch.tv/somerchannel')).toBe('somerchannel')
  })

  it('extracts channel name from twitch.tv base domain', () => {
    expect(extractChannelFromUrl('https://twitch.tv/mychannel')).toBe('mychannel')
  })

  it('returns lowercase channel name', () => {
    expect(extractChannelFromUrl('https://www.twitch.tv/SomeChannel')).toBe('somechannel')
  })

  it('returns undefined for non-Twitch URLs', () => {
    expect(extractChannelFromUrl('https://www.youtube.com')).toBeUndefined()
  })

  it('returns undefined for Twitch root URL', () => {
    expect(extractChannelFromUrl('https://www.twitch.tv')).toBeUndefined()
  })

  it('returns undefined for Twitch subdomain pages', () => {
    expect(extractChannelFromUrl('https://dashboard.twitch.tv')).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(extractChannelFromUrl('')).toBeUndefined()
  })

  it('ignores sub-paths after channel name', () => {
    expect(extractChannelFromUrl('https://www.twitch.tv/somerchannel/video/12345')).toBe(
      'somerchannel',
    )
  })
})

describe('Popup App', () => {
  it('exports a valid React component', () => {
    expect(App).toBeTypeOf('function')
  })

  it('has a default target language of zh-TW', () => {
    expect(DEFAULT_SETTINGS.targetLanguage).toBe('zh-TW')
  })

  it('knows all provider IDs', () => {
    expect(PROVIDER_IDS).toHaveLength(4)
    expect(PROVIDER_IDS).toContain('gemini')
    expect(PROVIDER_IDS).toContain('deepseek')
    expect(PROVIDER_IDS).toContain('openai')
    expect(PROVIDER_IDS).toContain('claude')
  })

  it('lists provider metadata for the popup form', () => {
    const providers = listProviderMetadata()
    expect(providers).toHaveLength(4)
    for (const p of providers) {
      expect(p.id).toBeTypeOf('string')
      expect(p.displayName).toBeTypeOf('string')
      expect(p.models.length).toBeGreaterThanOrEqual(1)
      expect(p.defaultModel).toBeTypeOf('string')
    }
  })

  it('defaults to deepseek as provider', () => {
    expect(DEFAULT_SETTINGS.selectedProvider).toBe('deepseek')
    expect(DEFAULT_SETTINGS.selectedModel).toBe('deepseek-v4-flash')
  })

  it('defaults to below display mode', () => {
    expect(DEFAULT_SETTINGS.displayMode).toBe('below')
  })

  it('masks API keys correctly for display', () => {
    expect(maskApiKey('sk-abc123xyz')).toMatch(/^sk-.*xyz$/)
    expect(maskApiKey('sk-abc123xyz')).not.toContain('abc123')
  })

  it('has a provider option for each registered provider', () => {
    const providers = listProviderMetadata()
    const providerOptions = providers.map((p) => ({
      value: p.id,
      label: p.displayName,
    }))

    expect(providerOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'gemini' }),
        expect.objectContaining({ value: 'deepseek' }),
        expect.objectContaining({ value: 'openai' }),
        expect.objectContaining({ value: 'claude' }),
      ]),
    )
  })
})
