// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('content script message hydration', () => {
  const sendMessage = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    document.body.innerHTML =
      '<div data-test-selector="chat-scrollable-area__message-container"></div>'

    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { targetLanguage: 'zh-TW', translationEnabled: true },
        })
      }

      if (message.type === 'translate_request') {
        return Promise.resolve({
          type: 'translate_response',
          payload: { messageId: 'any-id', translatedText: '翻譯結果' },
        })
      }

      return Promise.resolve(undefined)
    })

    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('translates a remote message after its text is rendered after the message shell', async () => {
    await import('./twitch-entry')

    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    const message = document.createElement('div')
    message.className = 'chat-line__message'
    const username = document.createElement('span')
    username.className = 'chat-author__display-name'
    username.textContent = 'other-viewer'
    message.appendChild(username)
    container.appendChild(message)

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)

    expect(message.getAttribute('data-tachi-lens-processed')).toBeNull()

    const body = document.createElement('span')
    body.className = 'chat-line__message-body'
    body.textContent = 'これは他の視聴者のメッセージです'
    message.appendChild(body)

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'translate_request',
      payload: expect.objectContaining({ text: 'これは他の視聴者のメッセージです' }),
    }))
    expect(message.querySelector('[data-tachi-lens-translated]')?.textContent).toBe('翻譯結果')
  })
})
