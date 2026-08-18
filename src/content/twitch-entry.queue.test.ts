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
  let runtimeMessageListener: ((message: unknown) => void) | undefined
  let effectiveTranslationEnabled = true

  const translationRequests = (): unknown[][] => sendMessage.mock.calls.filter(([message]) =>
    (message as { type: string }).type === 'translate_request',
  )

  const updateTranslationEnabled = async (enabled: boolean): Promise<void> => {
    if (!runtimeMessageListener) {
      throw new Error('Expected the content runtime message listener to be attached')
    }
    effectiveTranslationEnabled = enabled
    runtimeMessageListener({
      type: 'settings_updated',
      payload: { translationEnabled: enabled },
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    runtimeMessageListener = undefined
    effectiveTranslationEnabled = true
    document.body.innerHTML =
      '<div data-test-selector="chat-scrollable-area__message-container"></div>'
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
  })

  it('stops debounce work and newly detected messages immediately when disabled', async () => {
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: effectiveTranslationEnabled, minTextLength: 1 },
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

    await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    appendMessage(container, 'pending before disable')
    await Promise.resolve()

    expect(translationRequests()).toHaveLength(0)
    await updateTranslationEnabled(false)
    await vi.advanceTimersByTimeAsync(300)

    appendMessage(container, 'detected while disabled')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)

    expect(translationRequests()).toHaveLength(0)
  })

  it('uses the receiving tab channel setting instead of a broadcast toggle payload', async () => {
    sendMessage.mockImplementation((message: { type: string; payload?: { text?: string } }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          // This tab has a channel override that remains enabled even when
          // another tab broadcasts a global-looking disabled payload.
          payload: { translationEnabled: true, minTextLength: 1 },
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

    await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    // Deliberately do not mutate the effective mock setting: the broadcast
    // payload is not authoritative for this receiving tab.
    runtimeMessageListener?.({
      type: 'settings_updated',
      payload: { translationEnabled: false },
    })
    await Promise.resolve()

    appendMessage(container, 'channel override remains enabled')
    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()

    expect(translationRequests()).toHaveLength(1)
  })

  it('discards queued but undispatched work when disabled', async () => {
    const translationResolvers: Array<(value: unknown) => void> = []
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: effectiveTranslationEnabled, minTextLength: 1 },
        })
      }
      if (message.type === 'translate_request') {
        return new Promise((resolve) => translationResolvers.push(resolve))
      }
      return Promise.resolve(undefined)
    })

    const mod = await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    for (let index = 0; index < 11; index++) {
      appendMessage(container, `queued message ${index}`)
    }

    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)
    expect(translationRequests()).toHaveLength(10)
    expect(mod._test.translationQueueLength).toBe(1)

    await updateTranslationEnabled(false)
    expect(mod._test.translationQueueLength).toBe(0)

    for (const resolve of translationResolvers) {
      resolve({
        type: 'translate_response',
        payload: { messageId: 'any-id', translatedText: '翻譯結果' },
      })
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(translationRequests()).toHaveLength(10)
  })

  it('ignores a provider response that resolves after disable', async () => {
    let resolveTranslation: ((value: unknown) => void) | undefined
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: effectiveTranslationEnabled, minTextLength: 1 },
        })
      }
      if (message.type === 'translate_request') {
        return new Promise((resolve) => { resolveTranslation = resolve })
      }
      return Promise.resolve(undefined)
    })

    await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    appendMessage(container, 'late response message')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)
    expect(translationRequests()).toHaveLength(1)

    await updateTranslationEnabled(false)
    resolveTranslation?.({
      type: 'translate_response',
      payload: { messageId: 'any-id', translatedText: 'late translation' },
    })
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()

    expect(container.querySelector('[data-tachi-lens-translated]')).toBeNull()
  })

  it('pauses retry and backlog processing while disabled', async () => {
    sendMessage.mockImplementation((message: { type: string }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: effectiveTranslationEnabled, minTextLength: 1 },
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

    const mod = await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    appendMessage(container, 'retryable message')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()
    await Promise.resolve()
    expect(translationRequests()).toHaveLength(1)

    mod._test.activeTranslations = mod._test.MAX_CONCURRENT
    const backlog = document.createElement('div')
    backlog.textContent = 'backlog before disable'
    container.appendChild(backlog)
    mod._test.enqueueTranslation(backlog, 'backlog')
    expect(mod._test.translationQueueLength).toBe(1)

    await updateTranslationEnabled(false)
    expect(mod._test.translationQueueLength).toBe(0)

    mod._test.activeTranslations = 0
    await vi.advanceTimersByTimeAsync(35_000)

    expect(translationRequests()).toHaveLength(1)
    expect(mod._test.translationQueueLength).toBe(0)
  })

  it('resumes translation for newly eligible messages after re-enable', async () => {
    sendMessage.mockImplementation((message: { type: string; payload?: { text?: string } }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: effectiveTranslationEnabled, minTextLength: 1 },
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

    await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    await updateTranslationEnabled(false)
    appendMessage(container, 'ignored while disabled')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)
    expect(translationRequests()).toHaveLength(0)

    await updateTranslationEnabled(true)
    appendMessage(container, 'translated after re-enable')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()

    expect(translationRequests()).toHaveLength(1)
    expect(translationRequests()[0]![0]).toMatchObject({
      payload: { text: 'translated after re-enable' },
    })
  })

  it('retries a failed settings refresh so re-enable is not stranded', async () => {
    let failNextSettingsRead = false
    sendMessage.mockImplementation((message: { type: string; payload?: { text?: string } }) => {
      if (message.type === 'get_content_settings') {
        if (failNextSettingsRead) {
          failNextSettingsRead = false
          return Promise.reject(new Error('temporary settings read failure'))
        }
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: effectiveTranslationEnabled, minTextLength: 1 },
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

    await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!

    await updateTranslationEnabled(false)
    effectiveTranslationEnabled = true
    failNextSettingsRead = true
    runtimeMessageListener!({
      type: 'settings_updated',
      payload: { translationEnabled: true },
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)

    appendMessage(container, 'still disabled during failed refresh')
    await vi.advanceTimersByTimeAsync(300)
    expect(translationRequests()).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(999)
    expect(translationRequests()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)

    appendMessage(container, 'translated after refresh retry')
    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()

    expect(translationRequests()).toHaveLength(1)
    expect(translationRequests()[0]![0]).toMatchObject({
      payload: { text: 'translated after refresh retry' },
    })
  })

  it('refreshes settings while disabled when the re-enable broadcast is missed', async () => {
    sendMessage.mockImplementation((message: { type: string; payload?: { text?: string } }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: effectiveTranslationEnabled, minTextLength: 1 },
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

    await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!

    await updateTranslationEnabled(false)
    effectiveTranslationEnabled = true
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.resolve()

    appendMessage(container, 'translated after missed broadcast')
    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()

    expect(translationRequests()).toHaveLength(1)
    expect(translationRequests()[0]![0]).toMatchObject({
      payload: { text: 'translated after missed broadcast' },
    })
  })

  it('updates empty disabled markers before allowing recycled text', async () => {
    sendMessage.mockImplementation((message: { type: string; payload?: { text?: string } }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: effectiveTranslationEnabled, minTextLength: 1 },
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

    const mod = await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    await updateTranslationEnabled(false)

    const recycledMessage = document.createElement('div')
    recycledMessage.className = 'chat-line__message'
    recycledMessage.innerHTML = [
      '<span class="chat-author__display-name">viewer</span>',
      '<span data-a-target="chat-line-message-body"></span>',
    ].join('')
    container.appendChild(recycledMessage)
    await Promise.resolve()

    await updateTranslationEnabled(true)
    const body = recycledMessage.querySelector('[data-a-target="chat-line-message-body"]')!
    body.textContent = 'hydrated while disabled'
    // Exercise the marker transition before MutationObserver can observe the
    // text node change; this text is still from the disabled era.
    mod._test.enqueueTranslation(recycledMessage, 'live')
    body.textContent = 'new recycled message'
    mod._test.enqueueTranslation(recycledMessage, 'live')
    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()

    expect(translationRequests()).toHaveLength(1)
    expect(translationRequests()[0]![0]).toMatchObject({
      payload: { text: 'new recycled message' },
    })
  })

  it('allows a same-text node after its DOM identity changes', async () => {
    sendMessage.mockImplementation((message: { type: string; payload?: { text?: string } }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: effectiveTranslationEnabled, minTextLength: 1 },
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

    const mod = await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    await updateTranslationEnabled(false)
    appendMessage(container, 'repeat')
    await Promise.resolve()

    await updateTranslationEnabled(true)
    const message = container.querySelector('.chat-line__message') as HTMLElement
    // Keep both the username and body text identical; only the DOM identity
    // changes, as it does when Twitch recycles a virtual-scroll node.
    message.setAttribute('data-message-id', 'new-message')
    mod._test.enqueueTranslation(message, 'live')
    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()

    expect(translationRequests()).toHaveLength(1)
    expect(translationRequests()[0]![0]).toMatchObject({
      payload: { text: 'repeat' },
    })
  })

  it('does not resurrect disabled-era messages after re-enable', async () => {
    sendMessage.mockImplementation((message: { type: string; payload?: { text?: string } }) => {
      if (message.type === 'get_content_settings') {
        return Promise.resolve({
          type: 'content_settings',
          payload: { translationEnabled: effectiveTranslationEnabled, minTextLength: 1 },
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

    await import('./twitch-entry')
    const container = document.querySelector(
      '[data-test-selector="chat-scrollable-area__message-container"]',
    )!
    appendMessage(container, 'pending before disable')
    await Promise.resolve()
    await updateTranslationEnabled(false)

    appendMessage(container, 'arrived while disabled')
    await Promise.resolve()
    await updateTranslationEnabled(true)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(translationRequests()).toHaveLength(0)

    appendMessage(container, 'new after re-enable')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()

    expect(translationRequests()).toHaveLength(1)
    expect(translationRequests()[0]![0]).toMatchObject({
      payload: { text: 'new after re-enable' },
    })
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

  describe('queue capacity and overflow bound', () => {
    it('never exceeds the named queue bound under burst input', async () => {
      const mod = await import('./twitch-entry')
      sendMessage.mockReset()

      // Saturate all concurrency slots so drainTranslationQueue does not dequeue.
      mod._test.activeTranslations = mod._test.MAX_CONCURRENT

      const total = mod._test.MAX_QUEUED + 20
      for (let index = 0; index < total; index++) {
        const element = document.createElement('div')
        element.textContent = `burst-${index}`
        document.body.appendChild(element)
        mod._test.enqueueTranslation(element, 'live')
      }

      expect(mod._test.translationQueueLength).toBe(mod._test.MAX_QUEUED)

      // Overflow drops the oldest pending work first; the newest work survives.
      const snapshot = mod._test.translationQueueSnapshot
      expect(snapshot).toHaveLength(mod._test.MAX_QUEUED)
      expect(snapshot[0]!.text).toBe(`burst-${total - mod._test.MAX_QUEUED}`)
      expect(snapshot[snapshot.length - 1]!.text).toBe(`burst-${total - 1}`)

      // Dropped work never reached dispatch (no translate_request was sent).
      expect(sendMessage.mock.calls.filter(([message]) =>
        (message as { type: string }).type === 'translate_request',
      )).toHaveLength(0)
    })

    it('removes obsolete entries before dropping the oldest pending work on overflow', async () => {
      const mod = await import('./twitch-entry')
      sendMessage.mockReset()
      mod._test.activeTranslations = mod._test.MAX_CONCURRENT

      // Fill to capacity with connected elements.
      for (let index = 0; index < mod._test.MAX_QUEUED; index++) {
        const element = document.createElement('div')
        element.textContent = `fill-${index}`
        document.body.appendChild(element)
        mod._test.enqueueTranslation(element, 'live')
      }
      expect(mod._test.translationQueueLength).toBe(mod._test.MAX_QUEUED)

      // A disconnected element is obsolete: it is removed before any oldest drop.
      const disconnected = document.createElement('div')
      disconnected.textContent = 'disconnected'
      mod._test.enqueueTranslation(disconnected, 'live')

      const newest = document.createElement('div')
      newest.textContent = 'newest'
      document.body.appendChild(newest)
      mod._test.enqueueTranslation(newest, 'live')

      expect(mod._test.translationQueueLength).toBe(mod._test.MAX_QUEUED)

      const snapshot = mod._test.translationQueueSnapshot
      // Obsolete entry removed first...
      expect(snapshot.some((entry) => entry.text === 'disconnected')).toBe(false)
      // ...then the oldest connected entry (fill-0) was dropped; newest kept.
      expect(snapshot).toHaveLength(mod._test.MAX_QUEUED)
      expect(snapshot[0]!.text).toBe('fill-1')
      expect(snapshot[snapshot.length - 1]!.text).toBe('newest')
    })

    it('skips disconnected elements immediately before translation dispatch', async () => {
      const mod = await import('./twitch-entry')
      sendMessage.mockReset()

      // Keep the work queued by saturating the slots, then disconnect it.
      mod._test.activeTranslations = mod._test.MAX_CONCURRENT
      const element = document.createElement('div')
      element.textContent = 'will-disconnect'
      document.body.appendChild(element)
      mod._test.enqueueTranslation(element, 'live')
      expect(mod._test.translationQueueLength).toBe(1)

      element.remove()

      // Free a slot and drain: the disconnected element is skipped, no request sent.
      mod._test.activeTranslations = mod._test.MAX_CONCURRENT - 1
      mod._test.drainTranslationQueue()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      expect(sendMessage.mock.calls.filter(([message]) =>
        (message as { type: string }).type === 'translate_request',
      )).toHaveLength(0)
      expect(mod._test.translationQueueLength).toBe(0)
    })

    it('keeps the queue bounded while draining is paused by a provider cooldown', async () => {
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

      const mod = await import('./twitch-entry')
      const container = document.querySelector(
        '[data-test-selector="chat-scrollable-area__message-container"]',
      )!

      // First message triggers the provider cooldown (retryNotBefore is set).
      appendMessage(container, 'first')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(300)
      await Promise.resolve()
      await Promise.resolve()

      expect(sendMessage.mock.calls.filter(([message]) =>
        (message as { type: string }).type === 'translate_request',
      )).toHaveLength(1)

      // Burst arrives while draining is paused: the queue must stay bounded and
      // must not trigger a retry storm (only the initial request was dispatched).
      const total = mod._test.MAX_QUEUED + 15
      for (let index = 0; index < total; index++) {
        const element = document.createElement('div')
        element.textContent = `cooldown-${index}`
        document.body.appendChild(element)
        mod._test.enqueueTranslation(element, 'live')
      }

      expect(mod._test.translationQueueLength).toBe(mod._test.MAX_QUEUED)
      expect(sendMessage.mock.calls.filter(([message]) =>
        (message as { type: string }).type === 'translate_request',
      )).toHaveLength(1)
    })

    it('releases bookkeeping for dropped work and leaves no queue entry behind', async () => {
      const mod = await import('./twitch-entry')
      sendMessage.mockReset()
      mod._test.activeTranslations = mod._test.MAX_CONCURRENT

      const elements: HTMLElement[] = []
      for (let index = 0; index < mod._test.MAX_QUEUED; index++) {
        const element = document.createElement('div')
        element.textContent = `cleanup-${index}`
        document.body.appendChild(element)
        elements.push(element)
        mod._test.enqueueTranslation(element, 'live')
      }

      // Overflow drops the oldest entry (cleanup-0).
      const newest = document.createElement('div')
      newest.textContent = 'after-overflow'
      document.body.appendChild(newest)
      mod._test.enqueueTranslation(newest, 'live')

      const snapshot = mod._test.translationQueueSnapshot
      expect(snapshot.some((entry) => entry.text === 'cleanup-0')).toBe(false)
      expect(snapshot.some((entry) => entry.text === 'after-overflow')).toBe(true)

      // The dropped element is not stuck in the queuedForTranslation WeakSet:
      // re-enqueueing it succeeds, proving the bookkeeping was released.
      mod._test.enqueueTranslation(elements[0]!, 'live')
      expect(mod._test.translationQueueSnapshot.some((entry) => entry.text === 'cleanup-0')).toBe(true)

      // No dropped work was dispatched and no translate_request leaked.
      expect(sendMessage.mock.calls.filter(([message]) =>
        (message as { type: string }).type === 'translate_request',
      )).toHaveLength(0)
    })
  })

  describe('privacy-safe drop diagnostics (#60)', () => {
    const diagnosticCount = (stage: string): number =>
      sendMessage.mock.calls.filter(([message]) =>
        (message as { type?: string; payload?: { stage?: string } }).type === 'diagnostic_event'
          && (message as { payload?: { stage?: string } }).payload?.stage === stage,
      ).length

    it('emits a counter event for every queue-overflow drop, never message content', async () => {
      const mod = await import('./twitch-entry')
      sendMessage.mockReset()
      mod._test.activeTranslations = mod._test.MAX_CONCURRENT

      const total = mod._test.MAX_QUEUED + 5
      for (let index = 0; index < total; index++) {
        const element = document.createElement('div')
        element.textContent = `overflow-${index}`
        document.body.appendChild(element)
        mod._test.enqueueTranslation(element, 'live')
      }

      // 5 entries past MAX_QUEUED were dropped as overflow.
      expect(diagnosticCount('queue_overflow_drop')).toBe(5)
      // The events are privacy-safe: no chat text, username, channel, or
      // provider body is attached.
      for (const call of sendMessage.mock.calls) {
        const message = call[0] as { type?: string; payload?: Record<string, unknown> }
        if (message.type !== 'diagnostic_event') continue
        expect(message.payload?.detail).toBeUndefined()
      }
      expect(JSON.stringify(sendMessage.mock.calls)).not.toContain('overflow-')
    })

    it('emits a counter event for obsolete work removed before overflow', async () => {
      const mod = await import('./twitch-entry')
      sendMessage.mockReset()
      mod._test.activeTranslations = mod._test.MAX_CONCURRENT

      // Fill to capacity with connected elements.
      for (let index = 0; index < mod._test.MAX_QUEUED; index++) {
        const element = document.createElement('div')
        element.textContent = `fill-${index}`
        document.body.appendChild(element)
        mod._test.enqueueTranslation(element, 'live')
      }

      // A disconnected element is obsolete: it is removed before any overflow.
      const disconnected = document.createElement('div')
      disconnected.textContent = 'obsolete-work'
      mod._test.enqueueTranslation(disconnected, 'live')

      const newest = document.createElement('div')
      newest.textContent = 'newest'
      document.body.appendChild(newest)
      mod._test.enqueueTranslation(newest, 'live')

      expect(diagnosticCount('queue_obsolete_drop')).toBe(1)
      expect(diagnosticCount('queue_overflow_drop')).toBe(1)
      expect(JSON.stringify(sendMessage.mock.calls)).not.toContain('obsolete-work')
    })

    it('emits a counter event when a disconnected element is skipped at dispatch', async () => {
      const mod = await import('./twitch-entry')
      sendMessage.mockReset()

      mod._test.activeTranslations = mod._test.MAX_CONCURRENT
      const element = document.createElement('div')
      element.textContent = 'will-disconnect'
      document.body.appendChild(element)
      mod._test.enqueueTranslation(element, 'live')
      expect(mod._test.translationQueueLength).toBe(1)

      element.remove()

      mod._test.activeTranslations = mod._test.MAX_CONCURRENT - 1
      mod._test.drainTranslationQueue()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      expect(diagnosticCount('queue_obsolete_drop')).toBe(1)
      // No translate_request was sent for the skipped work.
      expect(sendMessage.mock.calls.filter(([message]) =>
        (message as { type: string }).type === 'translate_request',
      )).toHaveLength(0)
    })
  })
})
