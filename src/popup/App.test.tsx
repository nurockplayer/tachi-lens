// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, maskApiKey } from '@/storage/settings'
import { PROVIDER_IDS } from '@/providers/types'
import { listProviderMetadata } from '@/providers/registry'
import { App } from './App'
import { t } from '@/shared/i18n'

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

  describe('error notifications', () => {
    beforeEach(() => {
      vi.stubGlobal('chrome', {
        runtime: {
          onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
          sendMessage: vi.fn(),
        },
        storage: {
          local: {
            get: vi.fn().mockResolvedValue({
              userSettings: DEFAULT_SETTINGS,
              providerApiKeyPreviews: {},
            }),
            set: vi.fn(),
          },
        },
        i18n: {
          getMessage: vi.fn(() => ''),
        },
      })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('renders error notification area', () => {
      expect(t('errorNotificationTitle')).toBeTypeOf('string')
      expect(t('dismiss')).toBeTypeOf('string')
      expect(t('errorAuth')).toBe('API Key 無效')
    })
  })
})
