// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TwitchMessageHandler, parseChannelFromPathname, type ContentSettings } from './twitch-handler'

const DEFAULT_SETTINGS: ContentSettings = {
  botNameBlacklist: [],
  minTextLength: 2,
  displayMode: 'below',
  translationEnabled: true,
}

const createMessageElement = (overrides?: {
  text?: string
  username?: string
  messageId?: string
}): HTMLElement => {
  const el = document.createElement('div')
  el.className = 'chat-line__message'
  el.setAttribute('data-test-user', overrides?.username ?? 'testuser')

  const body = document.createElement('span')
  body.className = 'chat-line__message-body'
  body.textContent = overrides?.text ?? 'Hello world'
  el.appendChild(body)

  const usernameEl = document.createElement('span')
  usernameEl.className = 'chat-author__display-name'
  usernameEl.textContent = overrides?.username ?? 'testuser'
  el.appendChild(usernameEl)

  return el
}

describe('TwitchMessageHandler', () => {
  let handler: TwitchMessageHandler
  let sendMessageMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sendMessageMock = vi.fn()
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: sendMessageMock },
    })
    handler = new TwitchMessageHandler()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('getChannelName', () => {
    it.each([
      ['/somerchannel', 'somerchannel'],
      ['/channel_name', 'channel_name'],
      ['/UserChannel', 'userchannel'],
      ['/', undefined],
      ['', undefined],
      ['/somechannel/video/12345', 'somechannel'],
    ])('parses %s into %s', (pathname, expected) => {
      expect(handler.getChannelName(pathname)).toBe(expected)
    })
  })

  describe('parseChannelFromPathname', () => {
    it('returns channel name for a valid Twitch channel path', () => {
      expect(parseChannelFromPathname('/somerchannel')).toBe('somerchannel')
    })

    it('returns undefined for root path', () => {
      expect(parseChannelFromPathname('/')).toBeUndefined()
    })

    it('returns undefined for empty string', () => {
      expect(parseChannelFromPathname('')).toBeUndefined()
    })

    it('ignores sub-paths after channel name', () => {
      expect(parseChannelFromPathname('/channel/video/abc')).toBe('channel')
    })

    it('returns lowercase channel name', () => {
      expect(parseChannelFromPathname('/SomeChannel')).toBe('somechannel')
    })
  })

  describe('getMessageId', () => {
    it('generates a unique message ID from element position', () => {
      const el = createMessageElement()
      const id1 = handler.getMessageId(el)
      const id2 = handler.getMessageId(el)
      expect(id1).toMatch(/^msg-\d+-/)
      expect(id1).not.toBe(id2)
    })
  })

  describe('getMessageText', () => {
    it('extracts text from a message element', () => {
      const el = createMessageElement({ text: 'Hello Twitch!' })
      expect(handler.getMessageText(el)).toBe('Hello Twitch!')
    })

    it('returns empty string when no body is found', () => {
      const el = document.createElement('div')
      expect(handler.getMessageText(el)).toBe('')
    })
  })

  describe('getMessageUsername', () => {
    it('extracts username from a message element', () => {
      const el = createMessageElement({ username: 'someuser' })
      expect(handler.getMessageUsername(el)).toBe('someuser')
    })

    it('returns empty string when no username element is found', () => {
      const el = document.createElement('div')
      expect(handler.getMessageUsername(el)).toBe('')
    })
  })

  describe('isBot', () => {
    it('returns true if username is in the blacklist', () => {
      expect(handler.isBot('streamelements', ['streamelements', 'nightbot'])).toBe(true)
    })

    it('returns false if username is not in the blacklist', () => {
      expect(handler.isBot('realuser', ['streamelements', 'nightbot'])).toBe(false)
    })

    it('returns false for empty blacklist', () => {
      expect(handler.isBot('streamelements', [])).toBe(false)
    })
  })

  describe('isAlreadyProcessed', () => {
    it('returns true if element has processed attribute', () => {
      const el = createMessageElement()
      el.setAttribute('data-tachi-lens-processed', 'true')
      expect(handler.isAlreadyProcessed(el)).toBe(true)
    })

    it('returns false if element is not processed', () => {
      const el = createMessageElement()
      expect(handler.isAlreadyProcessed(el)).toBe(false)
    })
  })

  describe('shouldTranslate', () => {
    it('returns true for a valid message', () => {
      const el = createMessageElement({ text: 'Hello world', username: 'user' })
      expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(true)
    })

    it('returns false for bot messages', () => {
      const el = createMessageElement({ text: 'Hello', username: 'nightbot' })
      expect(
        handler.shouldTranslate(el, { ...DEFAULT_SETTINGS, botNameBlacklist: ['nightbot'] }),
      ).toBe(false)
    })

    it('returns false for short messages', () => {
      const el = createMessageElement({ text: 'Hi', username: 'user' })
      expect(handler.shouldTranslate(el, { ...DEFAULT_SETTINGS, minTextLength: 5 })).toBe(false)
    })

    it('returns false for already processed messages', () => {
      const el = createMessageElement({ text: 'Hello world', username: 'user' })
      el.setAttribute('data-tachi-lens-processed', 'true')
      expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(false)
    })
  })

  describe('translateAndInject', () => {
    it('sends a translation request to the service worker', async () => {
      const el = createMessageElement({ text: 'Hello' })

      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '你好' },
      })

      await handler.translateAndInject(el, DEFAULT_SETTINGS)

      expect(sendMessageMock).toHaveBeenCalledTimes(1)
      const callArg = sendMessageMock.mock.calls[0]![0] as Record<string, unknown>
      expect(callArg.type).toBe('translate_request')
      expect((callArg.payload as Record<string, unknown>).text).toBe('Hello')
      expect(typeof (callArg.payload as Record<string, unknown>).messageId).toBe('string')
    })

    it('injects translation below the original message', async () => {
      const el = createMessageElement({ text: 'Hello' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '你好' },
      })

      await handler.translateAndInject(el, DEFAULT_SETTINGS)

      const translationEl = el.querySelector('[data-tachi-lens-translated]')
      expect(translationEl).not.toBeNull()
      expect(translationEl?.textContent).toContain('你好')
    })

    it('marks the element as processed', async () => {
      const el = createMessageElement({ text: 'Hello' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '你好' },
      })

      await handler.translateAndInject(el, DEFAULT_SETTINGS)

      expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
    })

    it('marks the element as processed (second test)', async () => {
      const el = createMessageElement({ text: 'Hello' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: handler.getMessageId(el), translatedText: '你好' },
      })

      await handler.translateAndInject(el, DEFAULT_SETTINGS)

      expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
    })

    it('does nothing for rate_limited errors (silent)', async () => {
      const el = createMessageElement({ text: 'Hello' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: {
          messageId: handler.getMessageId(el),
          error: { type: 'rate_limited', retryAfterMs: 5000, message: 'Rate limited' },
        },
      })

      await handler.translateAndInject(el, DEFAULT_SETTINGS)

      // Should NOT be marked as processed so it can be retried
      expect(el.getAttribute('data-tachi-lens-processed')).toBeNull()
      // Should NOT inject anything
      expect(el.querySelector('[data-tachi-lens-translated]')).toBeNull()
    })

    it('shows error indicator for non-rate-limit errors', async () => {
      const el = createMessageElement({ text: 'Hello' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: {
          messageId: handler.getMessageId(el),
          error: { type: 'auth', status: 401, message: 'Unauthorized' },
        },
      })

      await handler.translateAndInject(el, DEFAULT_SETTINGS)

      expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
      // Should show error indicator
      expect(el.querySelector('[data-tachi-lens-translated]')).not.toBeNull()
    })

    it('does nothing when translation is disabled', async () => {
      const el = createMessageElement({ text: 'Hello' })
      await handler.translateAndInject(el, { ...DEFAULT_SETTINGS, translationEnabled: false })

      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(el.querySelector('[data-tachi-lens-translated]')).toBeNull()
    })
  })

  describe('display modes', () => {
    it('collapses original text in collapse mode', async () => {
      const el = createMessageElement({ text: 'Hello world' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '你好世界' },
      })

      await handler.translateAndInject(el, { ...DEFAULT_SETTINGS, displayMode: 'collapse' })

      const body = el.querySelector('.chat-line__message-body') as HTMLElement
      expect(body.style.display).toBe('none')
      const trans = el.querySelector('[data-tachi-lens-translated]')
      expect(trans?.textContent).toBe('你好世界')
    })

    it('hides translation until hover in hover mode', async () => {
      const el = createMessageElement({ text: 'Hello' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '你好' },
      })

      await handler.translateAndInject(el, { ...DEFAULT_SETTINGS, displayMode: 'hover' })

      const trans = el.querySelector('[data-tachi-lens-translated]') as HTMLElement
      expect(trans).not.toBeNull()
      expect(trans.style.display).toBe('none')

      // Simulate hover
      el.dispatchEvent(new MouseEvent('mouseenter'))
      expect(trans.style.display).toBe('block')
    })
  })
})
