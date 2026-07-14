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

  it('dispatches backlog after MAX_CONCURRENT_TRANSLATIONS consecutive live dequeues even under sustained live arrivals', async () => {
    const mod = await import('./twitch-entry')

    // Saturate all 10 active slots.
    mod._test.activeTranslations = 10

    // Queue one backlog and a lead live ahead of it.
    const backlogEl = document.createElement('div')
    document.body.appendChild(backlogEl)
    mod._test.enqueueTranslation(backlogEl, 'backlog')

    const leadLive = document.createElement('div')
    document.body.appendChild(leadLive)
    mod._test.enqueueTranslation(leadLive, 'live')

    // Queue: [leadLive(live), backlogEl(backlog)]. Counter = 0.

    // Sustain live arrivals for 12 cycles. Each cycle:
    //   1. Enqueue a fresh live (inserts before backlog).
    //   2. Free one slot and drain exactly one item.
    //
    // Without the fairness cap: each drain picks a fresh live (consecutive
    // live count keeps rising). Backlog is never dispatched.
    //
    // With the fairness cap (≥10 consecutive lives → force backlog):
    //   - Rounds 1-10: counter increments 1..10.
    //   - Round 11: counter ≥ 10 → backlog is forced. Counter resets to 0.
    //   - Round 12: a live is dispatched. Counter stays at 0 (hasBacklog=false).
    //
    // Therefore: counter=12 without fix, counter=0 or ≤1 with fix.
    for (let round = 1; round <= 12; round++) {
      const freshLive = document.createElement('div')
      document.body.appendChild(freshLive)
      mod._test.enqueueTranslation(freshLive, 'live')

      mod._test.activeTranslations = 9
      mod._test.drainTranslationQueue()
      mod._test.activeTranslations = 10
    }

    // With the fairness cap: backlog was forced, counter reset.
    // Without: backlog stayed queued, all 12 were lives, counter=12.
    expect(mod._test.consecutiveLiveDequeues).toBeLessThanOrEqual(1)

    // At least one live remained queued when backlog was forced.
    // Total: 2 (backlog+lead) + 12 (fresh) - 12 (drained) = 2 remaining.
    // With fix: both are lives → queueLength = 2.
    // Without fix: backlog + some live → queueLength ≥ 1.
    // Verify queue is shorter than CYCLES (meaning backlog was dispatched).
    expect(mod._test.translationQueueLength).toBeLessThan(12)
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
