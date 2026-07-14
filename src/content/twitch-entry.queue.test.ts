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

  it('starts newly arrived live work before queued backlog when capacity frees', async () => {
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

    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    for (let index = 0; index < 11; index++) {
      appendMessage(container, `backlog ${index}`)
    }

    await import('./twitch-entry')
    await vi.advanceTimersByTimeAsync(0)

    const translationCalls = () => sendMessage.mock.calls.filter(([message]) =>
      (message as { type: string }).type === 'translate_request',
    )
    expect(translationCalls()).toHaveLength(10)

    appendMessage(container, 'new live message')
    await vi.advanceTimersByTimeAsync(300)

    translationResolvers[0]!({
      type: 'translate_response',
      payload: { messageId: 'any-id', translatedText: '翻譯結果' },
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(translationCalls()).toHaveLength(11)
    expect(translationCalls()[10]![0]).toMatchObject({
      payload: { text: 'new live message', priority: 'live' },
    })

    for (const resolve of translationResolvers.slice(1)) {
      resolve({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '翻譯結果' },
      })
    }
  })

  it('dispatches backlog within at most 3 consecutive live dequeues under sustained live arrivals', async () => {
    const mod = await import('./twitch-entry')

    // Resolve sendMessage so processMessage completes and .finally() cascades.
    sendMessage.mockImplementation((msg: unknown) => {
      const m = msg as { type: string }
      if (m.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: true, minTextLength: 1 },
        })
      }
      if (m.type === 'translate_request') {
        return Promise.resolve({
          type: 'translate_response',
          payload: { messageId: 'any-id', translatedText: '-' },
        })
      }
      return Promise.resolve(undefined)
    })
    await vi.advanceTimersByTimeAsync(0)

    // Record dispatched item texts via hook.
    const textOrder: string[] = []
    mod._test.onDispatch = (el) => { textOrder.push(el.textContent ?? '') }

    // Pre-fill 10 lives ahead of the backlog by saturating all slots.
    mod._test.activeTranslations = 10
    for (let i = 0; i < 10; i++) {
      const el = document.createElement('div')
      el.textContent = `prefill-${i}`
      document.body.appendChild(el)
      mod._test.enqueueTranslation(el, 'live')
    }

    // Now queue the backlog — it sits behind the 10 prefills.
    const backlogEl = document.createElement('div')
    backlogEl.textContent = 'backlog-target'
    document.body.appendChild(backlogEl)
    mod._test.enqueueTranslation(backlogEl, 'backlog')

    // Queue: [prefill-0..prefill-9, backlog-target]
    textOrder.length = 0

    // Sustain fresh-live arrivals plus one slot release per cycle.
    // With bound=3, backlog is forced after 3 consecutive live dequeues.
    for (let r = 1; r <= 12; r++) {
      const el = document.createElement('div')
      el.textContent = `live-${r}`
      document.body.appendChild(el)
      mod._test.enqueueTranslation(el, 'live')

      mod._test.activeTranslations = 9
      mod._test.drainTranslationQueue()
      await vi.advanceTimersByTimeAsync(0)
      mod._test.activeTranslations = 10
    }

    // Fairness forces backlog after 3 consecutive lives (prefill-0..prefill-2).
    expect(textOrder[0]).toBe('prefill-0')
    expect(textOrder[1]).toBe('prefill-1')
    expect(textOrder[2]).toBe('prefill-2')
    expect(textOrder[3]).toBe('backlog-target')

    // Remaining prefills (3-9) dispatch after backlog since no backlog remains.
    expect(textOrder[4]).toBe('prefill-3')
    expect(textOrder[5]).toBe('prefill-4')
    expect(textOrder[6]).toBe('prefill-5')
    expect(textOrder[7]).toBe('prefill-6')
    expect(textOrder[8]).toBe('prefill-7')
    expect(textOrder[9]).toBe('prefill-8')
    expect(textOrder[10]).toBe('prefill-9')
    expect(textOrder[11]).toBe('live-1')

    // backlog dispatched exactly once.
    expect(textOrder.filter((t) => t === 'backlog-target')).toHaveLength(1)
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
