// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
      )).toHaveLength(2)

      vi.unstubAllGlobals()
    })

    it('does not let an older settings refresh overwrite the latest cache', async () => {
      const resolvers: Array<(value: unknown) => void> = []
      const sendMessage = vi.fn((message: { type: string }) => {
        if (message.type === 'get_content_settings') {
          return new Promise((resolve) => resolvers.push(resolve))
        }
        return Promise.resolve(undefined)
      })
      vi.stubGlobal('chrome', {
        runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
      })

      const { _test, handleSettingsUpdate } = await import('./twitch-entry')
      const older = handleSettingsUpdate({ translationEnabled: false })
      await vi.waitFor(() => expect(resolvers).toHaveLength(1))
      const latest = handleSettingsUpdate({ translationEnabled: true })
      await vi.waitFor(() => expect(resolvers).toHaveLength(2))

      resolvers[1]!({ type: 'content_settings', payload: { translationEnabled: true } })
      await latest
      resolvers[0]!({ type: 'content_settings', payload: { translationEnabled: false } })
      await older

      expect(_test.resolvedContentSettings?.translationEnabled).toBe(true)
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

  describe('content settings Chinese variant fallback', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    const setupChatObservation = (payload: Record<string, unknown>): void => {
      const sendMessage = vi.fn(async (message: { type: string }) => {
        if (message.type === 'get_content_settings') {
          return { type: 'content_settings', payload }
        }
        if (message.type === 'translate_request') {
          return { type: 'translate_response', payload: { messageId: 'any-id', translatedText: 'ok' } }
        }
        return undefined
      })
      vi.stubGlobal('chrome', {
        runtime: { sendMessage, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
      })
      document.body.innerHTML =
        '<div data-test-selector="chat-scrollable-area__message-container"></div>'
    }

    const processMessageToBuildCache = async (): Promise<void> => {
      const container = document.querySelector(
        '[data-test-selector="chat-scrollable-area__message-container"]',
      )!
      const message = document.createElement('div')
      message.className = 'chat-line__message'
      message.innerHTML = [
        '<span class="chat-author__display-name">viewer</span>',
        '<span data-a-target="chat-line-message-body">你好</span>',
      ].join('')
      container.appendChild(message)

      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()
      await Promise.resolve()
    }

    it('falls back to the default mode when the payload omits it', async () => {
      setupChatObservation({ translationEnabled: true, minTextLength: 1 })
      const { _test } = await import('./twitch-entry')

      await processMessageToBuildCache()

      expect(_test.resolvedContentSettings?.chineseVariantMode).toBe('skip_all_chinese')

      vi.unstubAllGlobals()
    })

    it('falls back to the default mode when the payload has an invalid value', async () => {
      setupChatObservation({ translationEnabled: true, minTextLength: 1, chineseVariantMode: 'bogus-mode' })
      const { _test } = await import('./twitch-entry')

      await processMessageToBuildCache()

      expect(_test.resolvedContentSettings?.chineseVariantMode).toBe('skip_all_chinese')

      vi.unstubAllGlobals()
    })

    it('keeps a valid mode delivered by the service worker', async () => {
      setupChatObservation({ translationEnabled: true, minTextLength: 1, chineseVariantMode: 'translate_other_script' })
      const { _test } = await import('./twitch-entry')

      await processMessageToBuildCache()

      expect(_test.resolvedContentSettings?.chineseVariantMode).toBe('translate_other_script')

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

  describe('speech subtitle overlay message wiring', () => {
    const loadEntry = async (
      sendMessage: ReturnType<typeof vi.fn>,
    ): Promise<(message: unknown) => void> => {
      let onMessage: ((message: unknown) => void) | undefined
      const addListener = vi.fn((listener: (message: unknown) => void) => {
        onMessage = listener
      })
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage,
          onMessage: { addListener, removeListener: vi.fn() },
        },
      })
      // Module init registers onRuntimeMessage via main().
      await import('./twitch-entry')
      return (message: unknown) => onMessage!(message)
    }

    const overlayHost = (): HTMLElement | null =>
      document.querySelector('[data-tachi-lens-subtitle-overlay]')

    it('mounts the overlay on speech_state capturing and destroys it on idle', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const dispatch = await loadEntry(sendMessage)

      expect(overlayHost()).toBeNull()
      dispatch({ type: 'speech_state', payload: { state: 'capturing' } })
      expect(overlayHost()).not.toBeNull()

      dispatch({ type: 'speech_state', payload: { state: 'transcribing' } })
      expect(overlayHost()).not.toBeNull()

      dispatch({ type: 'speech_state', payload: { state: 'idle' } })
      expect(overlayHost()).toBeNull()

      vi.unstubAllGlobals()
    })

    it('renders a caption inside the overlay shadow root', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const dispatch = await loadEntry(sendMessage)

      dispatch({ type: 'speech_state', payload: { state: 'capturing' } })
      dispatch({ type: 'speech_caption', payload: { id: 'c1', text: 'Hello world', interim: false } })

      const shadow = overlayHost()!.shadowRoot!
      expect(shadow.querySelector('.tachi-lens-caption-row')?.textContent).toBe('Hello world')

      vi.unstubAllGlobals()
    })

    it('clears captions on speech_caption_cleared silence and keeps the overlay', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const dispatch = await loadEntry(sendMessage)

      dispatch({ type: 'speech_state', payload: { state: 'capturing' } })
      dispatch({ type: 'speech_caption', payload: { id: 'c1', text: 'x', interim: false } })
      expect(overlayHost()!.shadowRoot!.querySelector('.tachi-lens-caption-row')).not.toBeNull()

      dispatch({ type: 'speech_caption_cleared', payload: { reason: 'silence' } })
      expect(overlayHost()!.shadowRoot!.querySelector('.tachi-lens-caption-row')).toBeNull()
      expect(overlayHost()).not.toBeNull()

      vi.unstubAllGlobals()
    })

    it('shows the sanitized error chip on speech_state error and auto-hides on recovery', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const dispatch = await loadEntry(sendMessage)

      dispatch({ type: 'speech_state', payload: { state: 'error', errorKey: 'speechErrorAuth' } })
      const chip = overlayHost()!.shadowRoot!.querySelector('.tachi-lens-error-chip')!
      expect(chip.classList.contains('hidden')).toBe(false)
      expect(chip.textContent).toBe('語音驗證失敗，請檢查語音 API Key')

      dispatch({ type: 'speech_state', payload: { state: 'capturing' } })
      expect(chip.classList.contains('hidden')).toBe(true)

      vi.unstubAllGlobals()
    })

    it('sends speech_control toggle when the collapse handle is clicked', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const dispatch = await loadEntry(sendMessage)

      dispatch({ type: 'speech_state', payload: { state: 'capturing' } })
      const handle = overlayHost()!.shadowRoot!.querySelector<HTMLButtonElement>('.tachi-lens-collapse-handle')!
      expect(handle).not.toBeNull()
      handle.click()
      await Promise.resolve()

      expect(sendMessage).toHaveBeenCalledWith({
        type: 'speech_control',
        payload: { action: 'toggle' },
      })

      vi.unstubAllGlobals()
    })

    it('applies speech_settings_updated to the overlay', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const dispatch = await loadEntry(sendMessage)

      dispatch({ type: 'speech_state', payload: { state: 'capturing' } })
      dispatch({ type: 'speech_settings_updated', payload: { captionMaxLines: 3, captionOpacity: 50 } })

      const root = overlayHost()!.shadowRoot!.querySelector('.tachi-lens-overlay-root') as HTMLElement
      expect(root.style.opacity).toBe('0.5')

      for (let i = 1; i <= 4; i++) {
        dispatch({ type: 'speech_caption', payload: { id: `c${i}`, text: `line ${i}`, interim: false } })
      }
      const rows = overlayHost()!.shadowRoot!.querySelectorAll('.tachi-lens-caption-row')
      expect(rows).toHaveLength(3)
      expect(rows[0]!.textContent).toBe('line 2')

      vi.unstubAllGlobals()
    })

    it('merges partial speech presentation updates for a later overlay mount', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const dispatch = await loadEntry(sendMessage)

      dispatch({ type: 'speech_settings_updated', payload: { captionMaxLines: 3 } })
      dispatch({ type: 'speech_settings_updated', payload: { captionOpacity: 50 } })
      dispatch({ type: 'speech_state', payload: { state: 'capturing' } })

      const root = overlayHost()!.shadowRoot!.querySelector('.tachi-lens-overlay-root') as HTMLElement
      expect(root.style.opacity).toBe('0.5')

      for (let i = 1; i <= 4; i++) {
        dispatch({ type: 'speech_caption', payload: { id: `c${i}`, text: `line ${i}`, interim: false } })
      }
      expect(overlayHost()!.shadowRoot!.querySelectorAll('.tachi-lens-caption-row')).toHaveLength(3)

      vi.unstubAllGlobals()
    })

    it('keeps speech subtitles isolated when chat translation is disabled', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const dispatch = await loadEntry(sendMessage)

      dispatch({ type: 'speech_state', payload: { state: 'capturing' } })
      dispatch({ type: 'speech_caption', payload: { id: 'c1', text: 'speech stays visible', interim: false } })
      dispatch({ type: 'settings_updated', payload: { translationEnabled: false } })

      expect(overlayHost()).not.toBeNull()
      expect(overlayHost()?.shadowRoot?.querySelector('.tachi-lens-caption-row')?.textContent)
        .toBe('speech stays visible')

      dispatch({ type: 'speech_settings_updated', payload: { captionOpacity: 50 } })
      const root = overlayHost()!.shadowRoot!.querySelector('.tachi-lens-overlay-root') as HTMLElement
      expect(root.style.opacity).toBe('0.5')

      vi.unstubAllGlobals()
    })
  })
})
