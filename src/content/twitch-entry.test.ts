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
    it('merges settings into chrome.storage.local', async () => {
      vi.stubGlobal('chrome', {
        storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } },
        runtime: { onMessage: { addListener: vi.fn() } },
      })

      const { handleSettingsUpdate } = await import('./twitch-entry')
      const setSpy = vi.mocked(chrome.storage.local.set)

      await handleSettingsUpdate({ translationEnabled: false })

      expect(setSpy).toHaveBeenCalledWith({
        userSettings: { translationEnabled: false },
      })

      vi.unstubAllGlobals()
    })

    it('merges with existing settings', async () => {
      vi.stubGlobal('chrome', {
        storage: {
          local: {
            get: vi.fn().mockResolvedValue({ userSettings: { displayMode: 'hover' } }),
            set: vi.fn(),
          },
        },
        runtime: { onMessage: { addListener: vi.fn() } },
      })

      const { handleSettingsUpdate } = await import('./twitch-entry')

      await handleSettingsUpdate({ translationEnabled: false })

      expect(vi.mocked(chrome.storage.local.set)).toHaveBeenCalledWith({
        userSettings: { displayMode: 'hover', translationEnabled: false },
      })

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
