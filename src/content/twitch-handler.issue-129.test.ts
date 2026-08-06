// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TwitchMessageHandler, type ContentSettings } from './twitch-handler'

/**
 * Issue #129 — Content Script retry contract for invalid provider results.
 *
 * Empty / whitespace / missing translation results arrive as
 * `error.type === 'invalid_response'`. The Content Script must keep the
 * message retryable for the first two attempts (no processed flag, no error
 * node, no notification), settle terminally on the third, and clear retry
 * state on a later success. Retry state is per-element and text-identity
 * aware: when Twitch reuses a DOM element for different text, the count
 * restarts.
 */

const DEFAULT_SETTINGS: ContentSettings = {
  botNameBlacklist: [],
  minTextLength: 2,
  displayMode: 'below',
  translationEnabled: true,
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

const createMessageElement = (text: string): HTMLElement => {
  const el = document.createElement('div')
  el.className = 'chat-line__message'

  const body = document.createElement('span')
  body.className = 'chat-line__message-body'
  body.textContent = text
  el.appendChild(body)

  const usernameEl = document.createElement('span')
  usernameEl.className = 'chat-author__display-name'
  usernameEl.textContent = 'viewer'
  el.appendChild(usernameEl)

  return el
}

const invalidResponse = {
  type: 'translate_response' as const,
  payload: {
    messageId: 'any-id',
    error: { type: 'invalid_response' as const, message: 'Invalid translation for this message' },
  },
}

const successResponse = (translated: string) => ({
  type: 'translate_response' as const,
  payload: { messageId: 'any-id', translatedText: translated },
})

describe('TwitchMessageHandler — issue #129 invalid response retry contract', () => {
  let sendMessageMock: ReturnType<typeof vi.fn>
  let reporter: ReturnType<typeof vi.fn<(stage: import('@/shared/messages').DiagnosticStage, detail?: string) => void>>
  let handler: TwitchMessageHandler

  beforeEach(() => {
    sendMessageMock = vi.fn()
    reporter = vi.fn<(stage: import('@/shared/messages').DiagnosticStage, detail?: string) => void>()
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: sendMessageMock },
    })
    handler = new TwitchMessageHandler(undefined, reporter)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the element unprocessed and silent after the first invalid response', async () => {
    sendMessageMock.mockResolvedValue(invalidResponse)
    const el = createMessageElement('こんにちは')

    await handler.translateAndInject(el, DEFAULT_SETTINGS)

    expect(el.getAttribute('data-tachi-lens-processed')).toBeNull()
    expect(el.querySelector('[data-tachi-lens-translated]')).toBeNull()
    // No terminal error notification was sent (only the translate_request).
    expect(sendMessageMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the element unprocessed after the second invalid response', async () => {
    sendMessageMock.mockResolvedValue(invalidResponse)
    const el = createMessageElement('こんにちは')

    await handler.translateAndInject(el, DEFAULT_SETTINGS)
    await handler.translateAndInject(el, DEFAULT_SETTINGS)

    expect(el.getAttribute('data-tachi-lens-processed')).toBeNull()
    expect(el.querySelector('[data-tachi-lens-translated]')).toBeNull()
    expect(sendMessageMock).toHaveBeenCalledTimes(2)
  })

  it('settles terminally on the third invalid response with exactly one error node and one notification', async () => {
    sendMessageMock.mockResolvedValue(invalidResponse)
    const el = createMessageElement('こんにちは')

    await handler.translateAndInject(el, DEFAULT_SETTINGS)
    await handler.translateAndInject(el, DEFAULT_SETTINGS)
    await handler.translateAndInject(el, DEFAULT_SETTINGS)

    expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
    const errorNodes = el.querySelectorAll('[data-tachi-lens-translated]')
    expect(errorNodes).toHaveLength(1)

    const notifications = sendMessageMock.mock.calls.filter(([message]) =>
      (message as { type: string }).type === 'error_notification',
    )
    expect(notifications).toHaveLength(1)
  })

  it('injects a translation exactly once after an invalid response then a success, and clears retry state', async () => {
    sendMessageMock
      .mockResolvedValueOnce(invalidResponse)
      .mockResolvedValueOnce(successResponse('こんばんは'))
    const el = createMessageElement('こんにちは')

    await handler.translateAndInject(el, DEFAULT_SETTINGS)
    await handler.translateAndInject(el, DEFAULT_SETTINGS)

    expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
    const translated = el.querySelectorAll('[data-tachi-lens-translated]')
    expect(translated).toHaveLength(1)
    expect(translated[0]?.textContent).toBe('こんばんは')

    // Retry state is cleared: a following invalid response restarts the budget.
    sendMessageMock.mockResolvedValueOnce(invalidResponse)
    const el2 = createMessageElement('おはよう')
    await handler.translateAndInject(el2, DEFAULT_SETTINGS)
    expect(el2.getAttribute('data-tachi-lens-processed')).toBeNull()
  })

  it('restarts the retry budget when the DOM element text changes', async () => {
    sendMessageMock.mockResolvedValue(invalidResponse)
    const el = createMessageElement('こんにちは')

    // Two failures against the original text.
    await handler.translateAndInject(el, DEFAULT_SETTINGS)
    await handler.translateAndInject(el, DEFAULT_SETTINGS)

    // Twitch reuses the element for new text (virtual scroll recycle).
    const body = el.querySelector('.chat-line__message-body')!
    body.textContent = 'こんばんは'

    // The budget must restart: this is the first failure for the new text,
    // so the element must NOT settle terminally yet.
    await handler.translateAndInject(el, DEFAULT_SETTINGS)
    expect(el.getAttribute('data-tachi-lens-processed')).toBeNull()
    expect(el.querySelector('[data-tachi-lens-translated]')).toBeNull()
  })

  it('keeps rate-limit behavior unchanged (retryable, no processed flag)', async () => {
    sendMessageMock.mockResolvedValue({
      type: 'translate_response',
      payload: {
        messageId: 'any-id',
        error: { type: 'rate_limited', retryAfterMs: 5_000, message: 'Rate limited' },
      },
    })
    const el = createMessageElement('こんにちは')

    const result = await handler.translateAndInject(el, DEFAULT_SETTINGS)

    expect(el.getAttribute('data-tachi-lens-processed')).toBeNull()
    expect(el.querySelector('[data-tachi-lens-translated]')).toBeNull()
    expect(result.retryAfterMs).toBe(5_000)
  })

  it('keeps explicit terminal errors unchanged (auth marks processed and notifies once)', async () => {
    sendMessageMock.mockResolvedValue({
      type: 'translate_response',
      payload: {
        messageId: 'any-id',
        error: { type: 'auth', status: 401, message: 'Unauthorized' },
      },
    })
    const el = createMessageElement('こんにちは')

    await handler.translateAndInject(el, DEFAULT_SETTINGS)

    expect(el.getAttribute('data-tachi-lens-processed')).toBe('true')
    expect(el.querySelectorAll('[data-tachi-lens-translated]')).toHaveLength(1)
    const notifications = sendMessageMock.mock.calls.filter(([message]) =>
      (message as { type: string }).type === 'error_notification',
    )
    expect(notifications).toHaveLength(1)
  })
})
