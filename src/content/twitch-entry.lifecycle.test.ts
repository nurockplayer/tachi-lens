// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('content script invalidation lifecycle', () => {
  const sendMessage = vi.fn()
  const addListener = vi.fn()
  const removeListener = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    document.body.innerHTML =
      '<div data-test-selector="chat-scrollable-area__message-container"></div>'

    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'get_content_settings') {
        throw new Error('Extension context invalidated.')
      }
      return Promise.resolve(undefined)
    })

    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: { addListener, removeListener },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('stops observer work and sends no more runtime messages after invalidation', async () => {
    await import('./twitch-entry')

    const message = document.createElement('div')
    message.className = 'chat-line__message'
    message.innerHTML = [
      '<span class="chat-author__display-name">viewer</span>',
      '<span data-a-target="chat-line-message-body">new message</span>',
    ].join('')
    document.querySelector('[data-test-selector="chat-scrollable-area__message-container"]')!
      .appendChild(message)

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()

    const sendsAfterInvalidation = sendMessage.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)

    expect(sendMessage).toHaveBeenCalledTimes(sendsAfterInvalidation)
    expect(removeListener).toHaveBeenCalledWith(expect.any(Function))
  })

  it('allows terminal cleanup to be called repeatedly', async () => {
    const { stopContentScript } = await import('./twitch-entry')

    expect(() => {
      stopContentScript()
      stopContentScript()
    }).not.toThrow()

    const sendsAfterStop = sendMessage.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sendMessage).toHaveBeenCalledTimes(sendsAfterStop)
  })
})
