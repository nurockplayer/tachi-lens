// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('content script entry', () => {
  beforeEach(() => {
    vi.resetModules()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  describe('reportDiagnostic', () => {
    it('removes translation failure detail before it crosses the runtime boundary', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('chrome', {
        runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
      })
      const { reportDiagnostic } = await import('./twitch-entry')

      reportDiagnostic('translation_failed', 'Private chat text and key sk-secret-key')

      const message = sendMessage.mock.calls
        .map(([value]) => value as { type?: string; payload?: Record<string, unknown> })
        .find((value) => value.type === 'diagnostic_event' && value.payload?.stage === 'translation_failed')
      expect(message).toBeDefined()
      expect(message?.payload?.detail).toBeUndefined()
    })

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

  describe('chat observation', () => {
    it('processes every fallback message inserted in one wrapper', async () => {
      vi.useFakeTimers()
      document.body.innerHTML =
        '<div data-test-selector="chat-scrollable-area__message-container"></div>'

      const sendMessage = vi.fn(async (message: { type: string; payload?: { text?: string } }) => {
        if (message.type === 'get_content_settings') {
          return {
            type: 'content_settings',
            payload: { translationEnabled: true, minTextLength: 1 },
          }
        }
        if (message.type === 'translate_request') {
          return {
            type: 'translate_response',
            payload: { messageId: 'any-id', translatedText: `translated:${message.payload?.text}` },
          }
        }
        return undefined
      })
      vi.stubGlobal('chrome', {
        runtime: { sendMessage, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
      })

      await import('./twitch-entry')

      const wrapper = document.createElement('div')
      for (const text of ['first message', 'second message']) {
        const message = document.createElement('div')
        message.setAttribute('data-test-selector', 'chat-message')
        message.innerHTML = [
          '<span data-a-target="chat-message-username">viewer</span>',
          `<span data-a-target="chat-message-text">${text}</span>`,
        ].join('')
        wrapper.appendChild(message)
      }
      document.querySelector('[data-test-selector="chat-scrollable-area__message-container"]')!
        .appendChild(wrapper)

      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(300)

      expect(sendMessage.mock.calls
        .filter(([message]) => message.type === 'translate_request')
        .map(([message]) => message.payload?.text)).toEqual(['first message', 'second message'])

      vi.useRealTimers()
      vi.unstubAllGlobals()
    })
  })
})
