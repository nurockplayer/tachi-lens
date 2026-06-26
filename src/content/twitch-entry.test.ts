// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
      const setSpy = vi.mocked(chrome.storage.local.set)

      // getSettings reads raw storage
      vi.mocked(chrome.storage.local.get).mockResolvedValueOnce({
        userSettings: { translationEnabled: true },
      })

      const before = await getSettings()
      expect(before).toEqual({ translationEnabled: true })

      // handleSettingsUpdate should NOT write to storage
      await handleSettingsUpdate({ translationEnabled: false })
      expect(setSpy).not.toHaveBeenCalled()

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
