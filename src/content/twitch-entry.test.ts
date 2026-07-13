// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('content script entry', () => {
  beforeEach(() => {
    vi.resetModules()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  describe('reportDiagnostic', () => {
    it('deduplicates identical translation failures within one second', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-13T00:00:00Z'))
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('chrome', {
        runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
      })
      const { reportDiagnostic } = await import('./twitch-entry')

      reportDiagnostic('translation_failed', 'Gemini quota exhausted')
      reportDiagnostic('translation_failed', 'Gemini quota exhausted')

      expect(sendMessage.mock.calls.filter(([message]) =>
        (message as { type?: string; payload?: { stage?: string } }).type === 'diagnostic_event'
          && (message as { payload?: { stage?: string } }).payload?.stage === 'translation_failed',
      )).toHaveLength(1)

      vi.advanceTimersByTime(1_001)
      reportDiagnostic('translation_failed', 'Gemini quota exhausted')

      expect(sendMessage.mock.calls.filter(([message]) =>
        (message as { type?: string; payload?: { stage?: string } }).type === 'diagnostic_event'
          && (message as { payload?: { stage?: string } }).payload?.stage === 'translation_failed',
      )).toHaveLength(2)

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })
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
      expect(sendMessage.mock.calls.filter(([message]) =>
        (message as { type?: string }).type === 'get_content_settings',
      )).toHaveLength(1)

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
