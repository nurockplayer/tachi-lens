// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TwitchMessageHandler, parseChannelFromPathname, type ContentSettings } from './twitch-handler'
import type { PageSelectors } from './twitch-selectors'
import type { DiagnosticStage } from '@/shared/messages'

const DEFAULT_SETTINGS: ContentSettings & { targetLanguage: string } = {
  botNameBlacklist: [],
  minTextLength: 2,
  displayMode: 'below',
  translationEnabled: true,
  targetLanguage: 'zh-TW',
  chineseVariantMode: 'skip_all_chinese',
  filterConfig: {
    skipEmotesOnly: true,
    skipCheermotes: true,
    skipSlashMe: true,
    skipWhispers: true,
    skipReplies: true,
    skipLinksOnly: true,
    skipNumbersOnly: true,
    skipSystemMessages: true,
  },
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

  describe('custom selectors', () => {
    it('uses custom CHAT_USERNAME selector when provided', () => {
      const customSelectors: PageSelectors = {
        CHAT_CONTAINER: '#custom-container',
        CHAT_MESSAGE: '.custom-msg',
        CHAT_MESSAGE_BODY: '.custom-body',
        CHAT_USERNAME: '.custom-username',
      }
      const customHandler = new TwitchMessageHandler(customSelectors)

      const el = document.createElement('div')
      const usernameEl = document.createElement('span')
      usernameEl.className = 'custom-username'
      usernameEl.textContent = 'custom-user'
      el.appendChild(usernameEl)

      expect(customHandler.getMessageUsername(el)).toBe('custom-user')
    })

    it('uses custom CHAT_MESSAGE_BODY selector when provided', () => {
      const customSelectors: PageSelectors = {
        CHAT_CONTAINER: '#custom-container',
        CHAT_MESSAGE: '.custom-msg',
        CHAT_MESSAGE_BODY: '.custom-body-text',
        CHAT_USERNAME: '.custom-username',
      }
      const customHandler = new TwitchMessageHandler(customSelectors)

      const el = document.createElement('div')
      const body = document.createElement('span')
      body.className = 'custom-body-text'
      body.textContent = 'Custom body text'
      el.appendChild(body)

      expect(customHandler.getMessageText(el)).toBe('Custom body text')
    })

    it('falls back to default selectors when none provided', () => {
      // Without custom selectors, uses existing class-based selectors
      const el = createMessageElement({ text: 'Hello default', username: 'defaultuser' })
      expect(handler.getMessageText(el)).toBe('Hello default')
      expect(handler.getMessageUsername(el)).toBe('defaultuser')
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

    it('does not auto-skip kanji-only Japanese when the target language is Traditional Chinese', () => {
      const el = createMessageElement({
        text: '開始',
        username: 'user',
      })

      expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(true)
    })

    it('does not mistake Twitch’s reply action icon for a reply message', () => {
      const el = createMessageElement({ text: 'これは通常のメッセージです', username: 'user' })
      const replyActionIcon = document.createElement('div')
      replyActionIcon.className = 'chat-line__reply-icon chat-line__icon'
      el.appendChild(replyActionIcon)

      expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(true)
    })

    describe('target-language skip (#55)', () => {
      it('skips Traditional Chinese text for a zh-TW target in skip_all_chinese mode', () => {
        const el = createMessageElement({ text: '這個很熱', username: 'user' })
        expect(
          handler.shouldTranslate(el, {
            ...DEFAULT_SETTINGS,
            targetLanguage: 'zh-TW',
            chineseVariantMode: 'skip_all_chinese',
          }),
        ).toBe(false)
      })

      it('skips Simplified Chinese text for a zh-TW target in skip_all_chinese mode', () => {
        const el = createMessageElement({ text: '这个很热', username: 'user' })
        expect(
          handler.shouldTranslate(el, {
            ...DEFAULT_SETTINGS,
            targetLanguage: 'zh-TW',
            chineseVariantMode: 'skip_all_chinese',
          }),
        ).toBe(false)
      })

      it('skips Simplified Chinese text for a zh-CN target in skip_all_chinese mode', () => {
        const el = createMessageElement({ text: '这个很热', username: 'user' })
        expect(
          handler.shouldTranslate(el, {
            ...DEFAULT_SETTINGS,
            targetLanguage: 'zh-CN',
            chineseVariantMode: 'skip_all_chinese',
          }),
        ).toBe(false)
      })

      it('sends Simplified Chinese text for a zh-TW target in translate_other_script mode', () => {
        const el = createMessageElement({ text: '这个很热', username: 'user' })
        expect(
          handler.shouldTranslate(el, {
            ...DEFAULT_SETTINGS,
            targetLanguage: 'zh-TW',
            chineseVariantMode: 'translate_other_script',
          }),
        ).toBe(true)
      })

      it('sends Traditional Chinese text for a zh-CN target in translate_other_script mode (inverse behavior)', () => {
        const el = createMessageElement({ text: '這個很熱', username: 'user' })
        expect(
          handler.shouldTranslate(el, {
            ...DEFAULT_SETTINGS,
            targetLanguage: 'zh-CN',
            chineseVariantMode: 'translate_other_script',
          }),
        ).toBe(true)
      })

      it('skips Traditional Chinese text for a zh-CN target in skip_all_chinese mode', () => {
        const el = createMessageElement({ text: '這個很熱', username: 'user' })
        expect(
          handler.shouldTranslate(el, {
            ...DEFAULT_SETTINGS,
            targetLanguage: 'zh-CN',
            chineseVariantMode: 'skip_all_chinese',
          }),
        ).toBe(false)
      })

      it('does not skip Japanese text with Kana for a zh-TW target', () => {
        const el = createMessageElement({ text: '今天は暑い', username: 'user' })
        expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(true)
      })

      it('does not skip Korean text for a zh-CN target', () => {
        const el = createMessageElement({ text: '안녕하세요', username: 'user' })
        expect(
          handler.shouldTranslate(el, {
            ...DEFAULT_SETTINGS,
            targetLanguage: 'zh-CN',
          }),
        ).toBe(true)
      })

      it('does not skip mixed Latin and Han text (hello 大家好)', () => {
        const el = createMessageElement({ text: 'hello 大家好', username: 'user' })
        expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(true)
      })

      it.each(['手紙', '電話', '自動車', '目的', '終了'])(
        'does not skip kana-less Japanese %s for a zh-TW target in skip_all_chinese',
        (text) => {
          const el = createMessageElement({ text, username: 'user' })
          expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(true)
        },
      )

      it('does not skip non-Chinese text for a zh target', () => {
        const el = createMessageElement({ text: 'Hello world', username: 'user' })
        expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(true)
      })

      it('does not skip Chinese text when no targetLanguage is configured', () => {
        const el = createMessageElement({ text: '这个很热', username: 'user' })
        expect(
          handler.shouldTranslate(el, { ...DEFAULT_SETTINGS, targetLanguage: undefined }),
        ).toBe(true)
      })
    })

    describe('skipEmotesOnly with CJK text (issue #37)', () => {
      const createElementWithBadge = (bodyText: string): HTMLElement => {
        const el = document.createElement('div')
        el.className = 'chat-line__message'

        // Badge image OUTSIDE the message body (simulating Twitch badges)
        const badge = document.createElement('img')
        badge.alt = 'badge'
        badge.src = 'https://static-cdn.jtvnw.net/badges/v1/badge.png'
        el.appendChild(badge)

        const body = document.createElement('span')
        body.className = 'chat-line__message-body'
        body.textContent = bodyText
        el.appendChild(body)

        const usernameEl = document.createElement('span')
        usernameEl.className = 'chat-author__display-name'
        usernameEl.textContent = 'testuser'
        el.appendChild(usernameEl)

        return el
      }

      it('badge image + こんばんは should translate (not emote-only)', () => {
        const el = createElementWithBadge('こんばんは')
        expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(true)
      })

      it('badge image + 草 should translate (not emote-only)', () => {
        const el = createElementWithBadge('草')
        expect(handler.shouldTranslate(el, { ...DEFAULT_SETTINGS, minTextLength: 1 })).toBe(true)
      })

      it('badge image + long Japanese without spaces should translate', () => {
        const el = createElementWithBadge('オニチャ懐かしい麦茶の味して美味しい')
        expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(true)
      })

      it('Japanese text with numbers should translate (not emote-only)', () => {
        const el = createElementWithBadge('もう100回見た')
        expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(true)
      })

      it('emote images only in body with no visible text should skip', () => {
        const el = document.createElement('div')
        el.className = 'chat-line__message'

        const body = document.createElement('span')
        body.className = 'chat-line__message-body'
        const emoteImg = document.createElement('img')
        emoteImg.className = 'tw-image tw-emote'
        emoteImg.alt = 'Kappa'
        emoteImg.src = '//cdn.7tv.cdn/emote.png'
        body.appendChild(emoteImg)
        el.appendChild(body)

        const usernameEl = document.createElement('span')
        usernameEl.className = 'chat-author__display-name'
        usernameEl.textContent = 'testuser'
        el.appendChild(usernameEl)

        expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(false)
      })

      it('emote image + visible text in body should translate', () => {
        const el = document.createElement('div')
        el.className = 'chat-line__message'

        const body = document.createElement('span')
        body.className = 'chat-line__message-body'
        body.appendChild(document.createTextNode('かわいい '))
        const emoteImg = document.createElement('img')
        emoteImg.className = 'tw-image tw-emote'
        emoteImg.alt = 'Kappa'
        emoteImg.src = '//cdn.7tv.cdn/emote.png'
        body.appendChild(emoteImg)
        el.appendChild(body)

        const usernameEl = document.createElement('span')
        usernameEl.className = 'chat-author__display-name'
        usernameEl.textContent = 'testuser'
        el.appendChild(usernameEl)

        expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(true)
      })

      it('emote image + nested visible text in body should translate', () => {
        const el = document.createElement('div')
        el.className = 'chat-line__message'

        const body = document.createElement('span')
        body.className = 'chat-line__message-body'
        const textFragment = document.createElement('span')
        textFragment.className = 'text-fragment'
        textFragment.textContent = 'かわいい '
        body.appendChild(textFragment)

        const emoteImg = document.createElement('img')
        emoteImg.className = 'tw-image tw-emote'
        emoteImg.alt = 'Kappa'
        body.appendChild(emoteImg)
        el.appendChild(body)

        const usernameEl = document.createElement('span')
        usernameEl.className = 'chat-author__display-name'
        usernameEl.textContent = 'testuser'
        el.appendChild(usernameEl)

        expect(handler.shouldTranslate(el, DEFAULT_SETTINGS)).toBe(true)
      })
    })
  })

  describe('translateAndInject', () => {
    it('marks a hydrated emote-only message as processed instead of retryable', async () => {
      const el = document.createElement('div')
      el.className = 'chat-line__message'

      const body = document.createElement('span')
      body.className = 'chat-line__message-body'
      const emoteImg = document.createElement('img')
      emoteImg.className = 'tw-image tw-emote'
      emoteImg.alt = 'Kappa'
      body.appendChild(emoteImg)
      el.appendChild(body)

      const usernameEl = document.createElement('span')
      usernameEl.className = 'chat-author__display-name'
      usernameEl.textContent = 'testuser'
      el.appendChild(usernameEl)

      await handler.translateAndInject(el, DEFAULT_SETTINGS)

      expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
      expect(sendMessageMock).not.toHaveBeenCalled()
    })

    it('reports the request, response, and injection stages without chat text', async () => {
      const reporter = vi.fn<(stage: DiagnosticStage, detail?: string) => void>()
      const HandlerWithDiagnostics = TwitchMessageHandler as unknown as new (
        selectors?: PageSelectors,
        diagnosticReporter?: (stage: DiagnosticStage, detail?: string) => void,
      ) => TwitchMessageHandler
      const diagnosticHandler = new HandlerWithDiagnostics(undefined, reporter)
      const el = createMessageElement({ text: 'Private chat text' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '翻譯結果' },
      })

      await diagnosticHandler.translateAndInject(el, DEFAULT_SETTINGS)

      expect(reporter).toHaveBeenCalledWith('translation_requested')
      expect(reporter).toHaveBeenCalledWith('translation_received')
      expect(reporter).toHaveBeenCalledWith('translation_injected')
      expect(JSON.stringify(reporter.mock.calls)).not.toContain('Private chat text')
    })

    it('does not expose the provider 429 reason in diagnostics', async () => {
      const reporter = vi.fn<(stage: DiagnosticStage, detail?: string) => void>()
      const diagnosticHandler = new TwitchMessageHandler(undefined, reporter)
      const el = createMessageElement({ text: 'Hello' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: {
          messageId: 'any-id',
          error: {
            type: 'rate_limited',
            retryAfterMs: 44_500,
            message: 'Quota exceeded for gemini-2.5-flash',
          },
        },
      })

      const result = await diagnosticHandler.translateAndInject(el, DEFAULT_SETTINGS)

      expect(reporter).toHaveBeenCalledWith('translation_failed')
      expect(result).toEqual({ retryAfterMs: 44_500 })
    })

    it('does not expose provider error content in diagnostics', async () => {
      const reporter = vi.fn<(stage: DiagnosticStage, detail?: string) => void>()
      const diagnosticHandler = new TwitchMessageHandler(undefined, reporter)
      const el = createMessageElement({ text: 'Private chat text' })
      const sensitiveProviderError = 'Request contained Private chat text and key sk-secret-key'
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: {
          messageId: 'any-id',
          error: { type: 'bad_request', status: 400, message: sensitiveProviderError },
        },
      })

      await diagnosticHandler.translateAndInject(el, DEFAULT_SETTINGS)

      expect(reporter).toHaveBeenCalledWith('translation_failed')
      expect(JSON.stringify(reporter.mock.calls)).not.toContain(sensitiveProviderError)
      expect(JSON.stringify(reporter.mock.calls)).not.toContain('sk-secret-key')
    })

    it('leaves an empty message shell retryable until its text is rendered', async () => {
      const el = document.createElement('div')
      el.className = 'chat-line__message'

      await handler.translateAndInject(el, DEFAULT_SETTINGS)

      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(el.getAttribute('data-tachi-lens-processed')).toBeNull()
    })

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

    it('uses the safe runtime sender for error notifications', async () => {
      const runtimeMessageSender = vi.fn()
        .mockResolvedValueOnce({
          kind: 'ok',
          value: {
            type: 'translate_response',
            payload: {
              messageId: 'any-id',
              error: { type: 'auth', status: 401, message: 'Unauthorized' },
            },
          },
        })
        .mockResolvedValueOnce({ kind: 'context_invalidated' })
      const handlerWithSafeSender = new TwitchMessageHandler(
        undefined,
        undefined,
        runtimeMessageSender,
      )

      await handlerWithSafeSender.translateAndInject(createMessageElement({ text: 'Hello' }), DEFAULT_SETTINGS)

      expect(runtimeMessageSender).toHaveBeenCalledTimes(2)
      expect(runtimeMessageSender.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        type: 'error_notification',
      }))
    })

    it('leaves messages retryable when runtime messaging fails', async () => {
      const el = createMessageElement({ text: 'Hello' })
      sendMessageMock.mockRejectedValue(new Error('Receiving end does not exist'))

      await handler.translateAndInject(el, DEFAULT_SETTINGS)

      expect(el.getAttribute('data-tachi-lens-processed')).toBeNull()
      expect(el.querySelector('[data-tachi-lens-translated]')).toBeNull()
    })

    it('does nothing when translation is disabled', async () => {
      const el = createMessageElement({ text: 'Hello' })
      await handler.translateAndInject(el, { ...DEFAULT_SETTINGS, translationEnabled: false })

      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(el.querySelector('[data-tachi-lens-translated]')).toBeNull()
    })

    it('does not send translate_request for a same-target-language message and marks it processed', async () => {
      const el = createMessageElement({ text: '这个很热', username: 'user' })

      await handler.translateAndInject(el, {
        ...DEFAULT_SETTINGS,
        targetLanguage: 'zh-TW',
        chineseVariantMode: 'skip_all_chinese',
      })

      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
      expect(el.querySelector('[data-tachi-lens-translated]')).toBeNull()
    })

    // Issue #182: the exact observed live-chat messages must not emit a
    // translate_request when the target language is Chinese.
    it.each([
      '那是肯定沒有',
      '不客氣',
      '我才',
      '那要打訊號什麼的',
      '把手機的畫面傳到電腦用OBS開台就可以不用斷',
    ])('does not send translate_request for #182 message %s and marks it processed', async (text) => {
      const el = createMessageElement({ text, username: 'user' })

      await handler.translateAndInject(el, {
        ...DEFAULT_SETTINGS,
        targetLanguage: 'zh-TW',
        chineseVariantMode: 'skip_all_chinese',
      })

      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
      expect(el.querySelector('[data-tachi-lens-translated]')).toBeNull()
    })

    it.each([
      '那是肯定沒有',
      '不客氣',
      '我才',
      '那要打訊號什麼的',
      '把手機的畫面傳到電腦用OBS開台就可以不用斷',
    ])('does not send translate_request for #182 message %s against a zh-CN target', async (text) => {
      const el = createMessageElement({ text, username: 'user' })

      await handler.translateAndInject(el, {
        ...DEFAULT_SETTINGS,
        targetLanguage: 'zh-CN',
        chineseVariantMode: 'skip_all_chinese',
      })

      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
    })

    it('does not send translate_request for same-script text in translate_other_script mode', async () => {
      const el = createMessageElement({ text: '這個很熱', username: 'user' })

      await handler.translateAndInject(el, {
        ...DEFAULT_SETTINGS,
        targetLanguage: 'zh-TW',
        chineseVariantMode: 'translate_other_script',
      })

      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
      expect(el.querySelector('[data-tachi-lens-translated]')).toBeNull()
    })

    it('sends translate_request for Simplified Chinese text against a zh-TW translate_other_script target', async () => {
      const el = createMessageElement({ text: '这个很热', username: 'user' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '好熱' },
      })

      await handler.translateAndInject(el, {
        ...DEFAULT_SETTINGS,
        targetLanguage: 'zh-TW',
        chineseVariantMode: 'translate_other_script',
      })

      expect(sendMessageMock).toHaveBeenCalledTimes(1)
      const callArg = sendMessageMock.mock.calls[0]![0] as Record<string, unknown>
      expect(callArg.type).toBe('translate_request')
      expect((callArg.payload as Record<string, unknown>).text).toBe('这个很热')
    })

    it('sends translate_request for mixed Simplified/Traditional text against a zh-TW translate_other_script target', async () => {
      const el = createMessageElement({ text: '这个熱吧', username: 'user' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '好熱' },
      })

      await handler.translateAndInject(el, {
        ...DEFAULT_SETTINGS,
        targetLanguage: 'zh-TW',
        chineseVariantMode: 'translate_other_script',
      })

      expect(sendMessageMock).toHaveBeenCalledTimes(1)
      expect((sendMessageMock.mock.calls[0]![0] as { type: string }).type).toBe('translate_request')
    })

    // Conservative safeguards at the Content Script boundary: kana-less
    // Japanese and mixed-language text must still emit translate_request even
    // when the target language is Chinese.
    it.each(['手紙', '電話', '自動車', '目的', '終了'])(
      'sends translate_request for kana-less Japanese %s against a zh-TW skip_all_chinese target',
      async (text) => {
        const el = createMessageElement({ text, username: 'user' })
        sendMessageMock.mockResolvedValue({
          type: 'translate_response',
          payload: { messageId: 'any-id', translatedText: '手紙（日文）' },
        })

        await handler.translateAndInject(el, {
          ...DEFAULT_SETTINGS,
          targetLanguage: 'zh-TW',
          chineseVariantMode: 'skip_all_chinese',
        })

        expect(sendMessageMock).toHaveBeenCalledTimes(1)
        expect((sendMessageMock.mock.calls[0]![0] as { type: string }).type).toBe('translate_request')
      },
    )

    // #182 follow-up: weak Kanji (個/用/不/可/能) must not accumulate into a
    // confident-Chinese signal, so kana-less Japanese compounds still translate.
    it.each(['個人利用不可', '使用不可能'])(
      'sends translate_request for kana-less Japanese %s against a zh-TW skip_all_chinese target',
      async (text) => {
        const el = createMessageElement({ text, username: 'user' })
        sendMessageMock.mockResolvedValue({
          type: 'translate_response',
          payload: { messageId: 'any-id', translatedText: '（日文）' },
        })

        await handler.translateAndInject(el, {
          ...DEFAULT_SETTINGS,
          targetLanguage: 'zh-TW',
          chineseVariantMode: 'skip_all_chinese',
        })

        expect(sendMessageMock).toHaveBeenCalledTimes(1)
        expect((sendMessageMock.mock.calls[0]![0] as { type: string }).type).toBe('translate_request')
      },
    )

    // #182 follow-up: Japanese-use Kanji (simplified 没 U+6CA1) must not act as
    // decisive Mandarin evidence, and short Japanese phrases with a Latin
    // acronym must not skip on weak accumulation.
    it.each(['没収', '水没', '没入', '個人利用不可OBS', '使用不可能OBS'])(
      'sends translate_request for Japanese %s against a zh-TW skip_all_chinese target',
      async (text) => {
        const el = createMessageElement({ text, username: 'user' })
        sendMessageMock.mockResolvedValue({
          type: 'translate_response',
          payload: { messageId: 'any-id', translatedText: '（日文）' },
        })

        await handler.translateAndInject(el, {
          ...DEFAULT_SETTINGS,
          targetLanguage: 'zh-TW',
          chineseVariantMode: 'skip_all_chinese',
        })

        expect(sendMessageMock).toHaveBeenCalledTimes(1)
        expect((sendMessageMock.mock.calls[0]![0] as { type: string }).type).toBe('translate_request')
      },
    )

    it.each(['使用不可能w', '個人利用不可w', '使用不可能ｗ', '個人利用不可ｗ'])(
      'sends translate_request for Japanese with a trailing Latin letter %s against a zh-TW target',
      async (text) => {
        const el = createMessageElement({ text, username: 'user' })
        sendMessageMock.mockResolvedValue({
          type: 'translate_response',
          payload: { messageId: 'any-id', translatedText: '（日文）' },
        })

        await handler.translateAndInject(el, {
          ...DEFAULT_SETTINGS,
          targetLanguage: 'zh-TW',
          chineseVariantMode: 'skip_all_chinese',
        })

        expect(sendMessageMock).toHaveBeenCalledTimes(1)
        expect((sendMessageMock.mock.calls[0]![0] as { type: string }).type).toBe('translate_request')
      },
    )

    // 什 (U+4EC0) is Japanese-use Kanji (什器): must still translate.
    it.each(['什器', '什物', '什錦'])(
      'sends translate_request for kana-less Japanese %s against a zh-TW skip_all_chinese target',
      async (text) => {
        const el = createMessageElement({ text, username: 'user' })
        sendMessageMock.mockResolvedValue({
          type: 'translate_response',
          payload: { messageId: 'any-id', translatedText: '（日文）' },
        })

        await handler.translateAndInject(el, {
          ...DEFAULT_SETTINGS,
          targetLanguage: 'zh-TW',
          chineseVariantMode: 'skip_all_chinese',
        })

        expect(sendMessageMock).toHaveBeenCalledTimes(1)
        expect((sendMessageMock.mock.calls[0]![0] as { type: string }).type).toBe('translate_request')
      },
    )

    // Foreign-dominant mixed messages with a marker/strong char must translate
    // the foreign portion rather than skipping the whole message.
    it.each(['hello 這個', 'English 對啊'])(
      'sends translate_request for foreign-dominant mixed message %s against a zh-TW target',
      async (text) => {
        const el = createMessageElement({ text, username: 'user' })
        sendMessageMock.mockResolvedValue({
          type: 'translate_response',
          payload: { messageId: 'any-id', translatedText: '（翻譯）' },
        })

        await handler.translateAndInject(el, {
          ...DEFAULT_SETTINGS,
          targetLanguage: 'zh-TW',
          chineseVariantMode: 'skip_all_chinese',
        })

        expect(sendMessageMock).toHaveBeenCalledTimes(1)
        expect((sendMessageMock.mock.calls[0]![0] as { type: string }).type).toBe('translate_request')
      },
    )

    // Han-only Mandarin built from weak chars plus a pronoun (我要用你的) and
    // phrase-with-emoji (不客氣❤️) are confidently Chinese: no request.
    it.each(['我要用你的', '不客氣❤️'])(
      'does not send translate_request for confident Chinese %s against a zh-TW target',
      async (text) => {
        const el = createMessageElement({ text, username: 'user' })
        await handler.translateAndInject(el, {
          ...DEFAULT_SETTINGS,
          targetLanguage: 'zh-TW',
          chineseVariantMode: 'skip_all_chinese',
        })

        expect(sendMessageMock).not.toHaveBeenCalled()
        expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
      },
    )

    // #182 follow-up: 他 in 他人 is a kana-less Japanese compound, not a
    // Mandarin pronoun, and long Japanese signage with an acronym must not
    // skip on length/dominance + weak aggregate alone. These must translate.
    it.each([
      '他人使用不可',
      '他人利用不可',
      '個人情報利用不可無断転載禁止w',
      '個人情報利用不可無断転載禁止',
    ])('sends translate_request for Japanese %s against a zh-TW skip_all_chinese target', async (text) => {
      const el = createMessageElement({ text, username: 'user' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '（日文）' },
      })

      await handler.translateAndInject(el, {
        ...DEFAULT_SETTINGS,
        targetLanguage: 'zh-TW',
        chineseVariantMode: 'skip_all_chinese',
      })

      expect(sendMessageMock).toHaveBeenCalledTimes(1)
      expect((sendMessageMock.mock.calls[0]![0] as { type: string }).type).toBe('translate_request')
    })

    it('does not send translate_request for 他很好 against a zh-TW target', async () => {
      // 他→很 is a Mandarin pronoun in context; the aggregate path skips it.
      const el = createMessageElement({ text: '他很好', username: 'user' })
      await handler.translateAndInject(el, {
        ...DEFAULT_SETTINGS,
        targetLanguage: 'zh-TW',
        chineseVariantMode: 'skip_all_chinese',
      })

      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
    })

    // #182 follow-up: 個人的使用禁止 is kana-less Japanese despite the 的
    // followed by 使, and astral-plane foreign letters must be detected. These
    // must still translate.
    it.each([
      '個人的使用禁止',
      '個人的利用禁止',
      '個人的利用不可',
      '個人的使用不可',
      '個人的利用可能',
      '個人的使用不可能',
      '𝕙𝕖𝕝𝕝𝕠 這個',
    ])(
      'sends translate_request for Japanese/mixed %s against a zh-TW skip_all_chinese target',
      async (text) => {
        const el = createMessageElement({ text, username: 'user' })
        sendMessageMock.mockResolvedValue({
          type: 'translate_response',
          payload: { messageId: 'any-id', translatedText: '（翻譯）' },
        })

        await handler.translateAndInject(el, {
          ...DEFAULT_SETTINGS,
          targetLanguage: 'zh-TW',
          chineseVariantMode: 'skip_all_chinese',
        })

        expect(sendMessageMock).toHaveBeenCalledTimes(1)
        expect((sendMessageMock.mock.calls[0]![0] as { type: string }).type).toBe('translate_request')
      },
    )

    it('does not send translate_request for 不客氣👨👩👧 against a zh-TW target', async () => {
      // Joined emoji ZWJ is a Cf format char; the phrase must still match.
      const el = createMessageElement({ text: '不客氣👨👩👧', username: 'user' })
      await handler.translateAndInject(el, {
        ...DEFAULT_SETTINGS,
        targetLanguage: 'zh-TW',
        chineseVariantMode: 'skip_all_chinese',
      })

      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
    })

    // #182 follow-up: 個人的使用不可 (的 followed by 使, weak=4), 他用途不可
    // (他 = Japanese "other" prefix), and the common courtesy phrase 謝謝.
    // The former two must translate; 謝謝 must skip.
    it.each(['個人的使用不可', '他用途不可', '他利用不可'])(
      'sends translate_request for kana-less Japanese %s against a zh-TW target',
      async (text) => {
        const el = createMessageElement({ text, username: 'user' })
        sendMessageMock.mockResolvedValue({
          type: 'translate_response',
          payload: { messageId: 'any-id', translatedText: '（日文）' },
        })

        await handler.translateAndInject(el, {
          ...DEFAULT_SETTINGS,
          targetLanguage: 'zh-TW',
          chineseVariantMode: 'skip_all_chinese',
        })

        expect(sendMessageMock).toHaveBeenCalledTimes(1)
        expect((sendMessageMock.mock.calls[0]![0] as { type: string }).type).toBe('translate_request')
      },
    )

    it.each(['謝謝', '谢谢'])(
      'does not send translate_request for common courtesy %s against a zh-TW target',
      async (text) => {
        const el = createMessageElement({ text, username: 'user' })
        await handler.translateAndInject(el, {
          ...DEFAULT_SETTINGS,
          targetLanguage: 'zh-TW',
          chineseVariantMode: 'skip_all_chinese',
        })

        expect(sendMessageMock).not.toHaveBeenCalled()
        expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
      },
    )

    it('sends translate_request for mixed Latin and Han text against a zh-TW skip_all_chinese target', async () => {
      const el = createMessageElement({ text: 'hello 大家好', username: 'user' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '哈囉大家好' },
      })

      await handler.translateAndInject(el, {
        ...DEFAULT_SETTINGS,
        targetLanguage: 'zh-TW',
        chineseVariantMode: 'skip_all_chinese',
      })

      expect(sendMessageMock).toHaveBeenCalledTimes(1)
      expect((sendMessageMock.mock.calls[0]![0] as { type: string }).type).toBe('translate_request')
    })

    it('sends translate_request for Japanese with Kana against a zh-TW skip_all_chinese target', async () => {
      const el = createMessageElement({ text: '今天は暑い', username: 'user' })
      sendMessageMock.mockResolvedValue({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '今天好熱' },
      })

      await handler.translateAndInject(el, {
        ...DEFAULT_SETTINGS,
        targetLanguage: 'zh-TW',
        chineseVariantMode: 'skip_all_chinese',
      })

      expect(sendMessageMock).toHaveBeenCalledTimes(1)
      expect((sendMessageMock.mock.calls[0]![0] as { type: string }).type).toBe('translate_request')
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
