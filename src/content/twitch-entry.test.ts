// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/storage/settings', () => ({
  getUserSettings: vi.fn(async () => ({
    selectedProvider: 'deepseek',
    selectedModel: 'deepseek-v4-flash',
    targetLanguage: 'zh-TW',
    botNameBlacklist: [],
    minTextLength: 2,
    displayMode: 'below',
    translationEnabled: true,
  })),
  getChannelSettings: vi.fn(async () => undefined),
  mergeSettings: vi.fn((global: unknown) => global),
}))

describe('content script entry', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  describe('handleSettingsUpdate', () => {
    it('invalidates the settings cache (does not write storage directly)', async () => {
      vi.stubGlobal('chrome', {
        storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } },
        runtime: { onMessage: { addListener: vi.fn() } },
      })

      const { handleSettingsUpdate, getSettings } = await import('./twitch-entry')

      // getSettings reads raw storage
      chrome.storage.local.get = vi.fn().mockResolvedValue({
        userSettings: { translationEnabled: true },
      })

      const before = await getSettings()
      expect(before).toEqual({ translationEnabled: true })

      // handleSettingsUpdate should NOT write to storage
      await handleSettingsUpdate({ translationEnabled: false })
      expect(vi.mocked(chrome.storage.local.set)).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })
  })

  describe('getSettings', () => {
    it('returns settings from chrome.storage.local', async () => {
      vi.stubGlobal('chrome', {
        storage: {
          local: {
            get: vi.fn().mockResolvedValue({ userSettings: { targetLanguage: 'en' } }),
            set: vi.fn(),
          },
        },
        runtime: { onMessage: { addListener: vi.fn() } },
      })

      const { getSettings } = await import('./twitch-entry')
      const result = await getSettings()

      expect(result).toEqual({ targetLanguage: 'en' })

      vi.unstubAllGlobals()
    })
  })
})
