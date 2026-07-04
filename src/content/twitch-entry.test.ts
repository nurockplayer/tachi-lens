// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('content script entry', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  describe('handleSettingsUpdate', () => {
    it('invalidates the settings cache (does not write storage directly)', async () => {
      const sendMessage = vi.fn().mockResolvedValue({
        type: 'content_settings',
        payload: { translationEnabled: true },
      })
      vi.stubGlobal('chrome', {
        runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
      })

      const { handleSettingsUpdate, getSettings } = await import('./twitch-entry')

      const before = await getSettings()
      expect(before).toEqual({ translationEnabled: true })

      // handleSettingsUpdate should only invalidate the in-memory cache.
      await handleSettingsUpdate({ translationEnabled: false })
      expect(sendMessage).toHaveBeenCalledTimes(1)

      vi.unstubAllGlobals()
    })
  })

  describe('getSettings', () => {
    it('returns settings from the service worker', async () => {
      const sendMessage = vi.fn().mockResolvedValue({
        type: 'content_settings',
        payload: { targetLanguage: 'en' },
      })
      vi.stubGlobal('chrome', {
        runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
      })

      const { getSettings } = await import('./twitch-entry')
      const result = await getSettings('mychannel')

      expect(result).toEqual({ targetLanguage: 'en' })
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'get_content_settings',
        payload: { channelName: 'mychannel' },
      })

      vi.unstubAllGlobals()
    })
  })
})
