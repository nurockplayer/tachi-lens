// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TwitchMessageHandler } from './twitch-handler'

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
      expect(handler.shouldTranslate(el, { botNameBlacklist: [], minTextLength: 2 })).toBe(true)
    })

    it('returns false for bot messages', () => {
      const el = createMessageElement({ text: 'Hello', username: 'nightbot' })
      expect(
        handler.shouldTranslate(el, { botNameBlacklist: ['nightbot'], minTextLength: 2 }),
      ).toBe(false)
    })

    it('returns false for short messages', () => {
      const el = createMessageElement({ text: 'Hi', username: 'user' })
      expect(handler.shouldTranslate(el, { botNameBlacklist: [], minTextLength: 5 })).toBe(false)
    })

    it('returns false for already processed messages', () => {
      const el = createMessageElement({ text: 'Hello world', username: 'user' })
      el.setAttribute('data-tachi-lens-processed', 'true')
      expect(handler.shouldTranslate(el, { botNameBlacklist: [], minTextLength: 2 })).toBe(false)
    })
  })

  describe('translateAndInject', () => {
    it('sends a translation request to the service worker', async () => {
      const el = createMessageElement({ text: 'Hello' })

      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '你好' },
      })

      await handler.translateAndInject(el, {
        botNameBlacklist: [],
        minTextLength: 2,
      })

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

      await handler.translateAndInject(el, {
        botNameBlacklist: [],
        minTextLength: 2,
      })

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

      await handler.translateAndInject(el, {
        botNameBlacklist: [],
        minTextLength: 2,
      })

      expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
    })

    it('marks the element as processed', async () => {
      const el = createMessageElement({ text: 'Hello' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: handler.getMessageId(el), translatedText: '你好' },
      })

      await handler.translateAndInject(el, {
        botNameBlacklist: [],
        minTextLength: 2,
      })

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

      await handler.translateAndInject(el, {
        botNameBlacklist: [],
        minTextLength: 2,
      })

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

      await handler.translateAndInject(el, {
        botNameBlacklist: [],
        minTextLength: 2,
      })

      expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
    })
  })
})
