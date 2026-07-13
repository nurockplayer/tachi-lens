// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appendMessage = (container: Element, text: string): void => {
  const message = document.createElement('div')
  message.className = 'chat-line__message'
  message.innerHTML = [
    '<span class="chat-author__display-name">viewer</span>',
    `<span data-a-target="chat-line-message-body">${text}</span>`,
  ].join('')
  container.appendChild(message)
}

describe('content script translation queue', () => {
  const sendMessage = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    document.body.innerHTML =
      '<div data-test-selector="chat-scrollable-area__message-container"></div>'
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('does not start more than ten translation requests before earlier requests settle', async () => {
    const translationResolvers: Array<(value: unknown) => void> = []
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: true, minTextLength: 1 },
        })
      }
      if (message.type === 'translate_request') {
        return new Promise((resolve) => translationResolvers.push(resolve))
      }
      return Promise.resolve(undefined)
    })

    await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    for (let index = 0; index < 11; index++) {
      appendMessage(container, `message ${index}`)
    }

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)

    expect(sendMessage.mock.calls.filter(([message]) =>
      (message as { type: string }).type === 'translate_request',
    )).toHaveLength(10)

    for (const resolve of translationResolvers) {
      resolve({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '翻譯結果' },
      })
    }
  })

  it('does not retry during a provider-supplied rate-limit cooldown', async () => {
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: true, minTextLength: 1 },
        })
      }
      if (message.type === 'translate_request') {
        return Promise.resolve({
          type: 'translate_response',
          payload: {
            messageId: 'any-id',
            error: { type: 'rate_limited', retryAfterMs: 30_000, message: 'Rate limited' },
          },
        })
      }
      return Promise.resolve(undefined)
    })

    await import('./twitch-entry')
    appendMessage(
      document.querySelector('[data-test-selector="chat-scrollable-area__message-container"]')!,
      'a message that is rate limited',
    )

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)

    const translationsAfterLimit = sendMessage.mock.calls.filter(([message]) =>
      (message as { type: string }).type === 'translate_request',
    ).length
    await vi.advanceTimersByTimeAsync(25_000)

    expect(sendMessage.mock.calls.filter(([message]) =>
      (message as { type: string }).type === 'translate_request',
    )).toHaveLength(translationsAfterLimit)
  })

  it('resumes queued messages after the rate-limit cooldown expires', async () => {
    const translationResolvers: Array<(value: unknown) => void> = []
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: true, minTextLength: 1 },
        })
      }
      if (message.type === 'translate_request') {
        return new Promise((resolve) => translationResolvers.push(resolve))
      }
      return Promise.resolve(undefined)
    })

    await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    for (let index = 0; index < 11; index++) {
      appendMessage(container, `message ${index}`)
    }

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)
    for (const resolve of translationResolvers) {
      resolve({
        type: 'translate_response',
        payload: {
          messageId: 'any-id',
          error: { type: 'rate_limited', retryAfterMs: 30_000, message: 'Rate limited' },
        },
      })
    }
    await Promise.resolve()
    await Promise.resolve()

    // The retry interval is aligned to content-script startup, so the first
    // tick after a 30-second cooldown occurs at 35 seconds in this setup.
    await vi.advanceTimersByTimeAsync(35_000)

    expect(sendMessage.mock.calls.filter(([message]) =>
      (message as { type: string }).type === 'translate_request',
    )).toHaveLength(20)
  })

})
