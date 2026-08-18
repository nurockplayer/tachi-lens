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

describe('content script SPA navigation', () => {
  const sendMessage = vi.fn()
  let runtimeMessageListener: ((message: unknown) => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/disabled-channel')
    document.body.innerHTML =
      '<div data-test-selector="chat-scrollable-area__message-container"></div>'
    runtimeMessageListener = undefined

    sendMessage.mockImplementation((message: {
      type: string
      payload?: { channelName?: string; text?: string }
    }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: {
            translationEnabled: message.payload?.channelName !== 'disabled-channel',
            minTextLength: 1,
          },
        })
      }
      if (message.type === 'translate_request') {
        return Promise.resolve({
          type: 'translate_response',
          payload: { messageId: 'any-id', translatedText: `translated:${message.payload?.text}` },
        })
      }
      return Promise.resolve(undefined)
    })

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: vi.fn((listener: (message: unknown) => void) => {
            runtimeMessageListener = listener
          }),
          removeListener: vi.fn(),
        },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.innerHTML = ''
    window.history.replaceState({}, '', '/')
  })

  it('rehydrates the effective chat gate after pushState navigation', async () => {
    const { stopContentScript } = await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!

    runtimeMessageListener?.({
      type: 'settings_updated',
      payload: { translationEnabled: false },
    })
    await Promise.resolve()

    appendMessage(container, 'ignored on disabled channel')
    await vi.advanceTimersByTimeAsync(300)
    expect(sendMessage.mock.calls.filter(([message]) =>
      (message as { type?: string }).type === 'translate_request',
    )).toHaveLength(0)

    sendMessage.mockClear()
    window.history.pushState({}, '', '/enabled-channel')
    appendMessage(container, 'translated after SPA navigation')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()

    expect(sendMessage.mock.calls.some(([message]) =>
      (message as { type?: string; payload?: { text?: string } }).type === 'translate_request'
      && (message as { payload?: { text?: string } }).payload?.text === 'translated after SPA navigation',
    )).toBe(true)
    expect(window.location.pathname).toBe('/enabled-channel')

    stopContentScript()
  })
})
