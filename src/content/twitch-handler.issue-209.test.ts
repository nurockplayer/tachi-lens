// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TwitchMessageHandler, type ContentSettings, type RuntimeMessageSender } from './twitch-handler'

const SETTINGS: ContentSettings = {
  botNameBlacklist: [],
  minTextLength: 1,
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

const createMessage = (text: string): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'chat-line__message'
  const body = document.createElement('span')
  body.className = 'chat-line__message-body'
  body.textContent = text
  row.appendChild(body)
  const username = document.createElement('span')
  username.className = 'chat-author__display-name'
  username.textContent = 'viewer'
  row.appendChild(username)
  return row
}

describe('TwitchMessageHandler — issue #209 failure recovery', () => {
  afterEach(() => vi.restoreAllMocks())

  beforeEach(() => {
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() } })
  })

  it('keeps a missing response payload retryable instead of marking the row processed', async () => {
    const sender = vi.fn(async () => ({ kind: 'ok' as const, value: { type: 'translate_response' } }))
    const handler = new TwitchMessageHandler(undefined, undefined, sender as unknown as RuntimeMessageSender)
    const row = createMessage('こんにちは')

    const result = await handler.translateAndInject(row, SETTINGS)

    expect(result.messageRetryAfterMs).toBeGreaterThan(0)
    expect(row.getAttribute('data-tachi-lens-processed')).toBeNull()
    expect(row.querySelector('[data-tachi-lens-translated]')).toBeNull()
  })

  it('does not inject a translation correlated to a different request id', async () => {
    const sender = vi.fn(async () => ({
      kind: 'ok' as const,
      value: {
        type: 'translate_response',
        payload: { messageId: 'unrelated-request', translatedText: 'こんばんは' },
      },
    }))
    const handler = new TwitchMessageHandler(undefined, undefined, sender as unknown as RuntimeMessageSender)
    const row = createMessage('こんにちは')

    const result = await handler.translateAndInject(row, SETTINGS)

    expect(result.messageRetryAfterMs).toBeGreaterThan(0)
    expect(row.getAttribute('data-tachi-lens-processed')).toBeNull()
    expect(row.querySelector('[data-tachi-lens-translated]')).toBeNull()
  })

  it('settles after three transient failures with one safe manual retry control', async () => {
    const onManualRetry = vi.fn()
    const sender = vi.fn(async (message: { type: string; payload: { messageId: string } }) => ({
      kind: 'ok' as const,
      value: message.type === 'translate_request'
        ? {
            type: 'translate_response',
            payload: {
              messageId: message.payload.messageId,
              error: { type: 'timeout', message: 'private provider response must not render' },
            },
          }
        : undefined,
    }))
    const handler = new TwitchMessageHandler(
      undefined,
      undefined,
      sender as unknown as RuntimeMessageSender,
      onManualRetry,
    )
    const row = createMessage('お元気ですか')

    await handler.translateAndInject(row, SETTINGS)
    await handler.translateAndInject(row, SETTINGS)
    await handler.translateAndInject(row, SETTINGS)

    const failure = row.querySelector<HTMLButtonElement>('[data-tachi-lens-error="true"]')
    expect(failure).not.toBeNull()
    expect(failure?.getAttribute('aria-label')).toContain('timed out')
    expect(failure?.getAttribute('aria-label')).not.toContain('private provider response')
    expect(row.getAttribute('data-tachi-lens-processed')).toBeNull()
    expect(row.querySelectorAll('[data-tachi-lens-error="true"]')).toHaveLength(1)

    failure?.click()
    expect(onManualRetry).toHaveBeenCalledWith(row)
  })

  it('does not carry an exhausted retry or stale retry click into a same-text recycled row', async () => {
    const onManualRetry = vi.fn()
    const sender = vi.fn(async (message: { type: string; payload: { messageId: string } }) => ({
      kind: 'ok' as const,
      value: message.type === 'translate_request'
        ? {
            type: 'translate_response',
            payload: { messageId: message.payload.messageId, error: { type: 'timeout' } },
          }
        : undefined,
    }))
    const handler = new TwitchMessageHandler(undefined, undefined, sender as unknown as RuntimeMessageSender, onManualRetry)
    const row = createMessage('same text')
    row.setAttribute('data-message-id', 'old-id')

    await handler.translateAndInject(row, SETTINGS)
    await handler.translateAndInject(row, SETTINGS)
    await handler.translateAndInject(row, SETTINGS)
    const staleButton = row.querySelector<HTMLButtonElement>('[data-tachi-lens-error="true"]')
    expect(handler.isAlreadyProcessed(row)).toBe(true)

    row.setAttribute('data-message-id', 'new-id')
    expect(handler.canAutoRetry(row)).toBe(true)
    expect(handler.isRetryCandidate(row)).toBe(false)
    staleButton?.click()
    expect(onManualRetry).not.toHaveBeenCalled()
    expect(row.querySelector('[data-tachi-lens-error="true"]')).toBeNull()
  })

  it('replaces a stale translation when the same row receives a new successful message', async () => {
    const sender = vi.fn(async (message: { type: string; payload: { messageId: string; text: string } }) => ({
      kind: 'ok' as const,
      value: message.type === 'translate_request'
        ? {
            type: 'translate_response',
            payload: { messageId: message.payload.messageId, translatedText: `translated:${message.payload.text}` },
          }
        : undefined,
    }))
    const handler = new TwitchMessageHandler(undefined, undefined, sender as unknown as RuntimeMessageSender)
    const row = createMessage('row A')
    const body = row.querySelector('.chat-line__message-body') as HTMLElement

    await handler.translateAndInject(row, SETTINGS)
    const firstHash = row.getAttribute('data-tachi-lens-original-hash')
    expect(row.querySelector('[data-tachi-lens-translated]')?.textContent).toBe('translated:row A')

    body.textContent = 'row B'
    await handler.translateAndInject(row, SETTINGS)

    const translationNodes = row.querySelectorAll('[data-tachi-lens-translated]:not([data-tachi-lens-error])')
    expect(translationNodes).toHaveLength(1)
    expect(translationNodes[0]?.textContent).toBe('translated:row B')
    expect(row.getAttribute('data-tachi-lens-processed')).toBe('true')
    expect(row.getAttribute('data-tachi-lens-original-hash')).not.toBe(firstHash)
  })

  it('restores a collapsed original body before replacing stale translation output', async () => {
    const sender = vi.fn(async (message: { type: string; payload: { messageId: string; text: string } }) => ({
      kind: 'ok' as const,
      value: message.type === 'translate_request'
        ? {
            type: 'translate_response',
            payload: { messageId: message.payload.messageId, translatedText: `translated:${message.payload.text}` },
          }
        : undefined,
    }))
    const handler = new TwitchMessageHandler(undefined, undefined, sender as unknown as RuntimeMessageSender)
    const row = createMessage('row A')
    const body = row.querySelector('.chat-line__message-body') as HTMLElement
    body.style.display = 'inline-block'

    await handler.translateAndInject(row, { ...SETTINGS, displayMode: 'collapse' })
    expect(body.style.display).toBe('none')
    body.textContent = 'row B'

    await handler.translateAndInject(row, SETTINGS)

    expect(body.style.display).toBe('inline-block')
    expect(body.dataset.tachiLensOriginalDisplay).toBeUndefined()
    expect(row.querySelector('[data-tachi-lens-translated]')?.textContent).toBe('translated:row B')
  })

  it('removes stale successful output so exhausted failures can expose one retry button', async () => {
    const onManualRetry = vi.fn()
    let currentText = ''
    const sender = vi.fn(async (message: { type: string; payload: { messageId: string; text: string } }) => {
      if (message.type === 'error_notification') return { kind: 'ok' as const, value: undefined }
      if (message.type === 'translate_request') {
        currentText = message.payload.text
        return {
          kind: 'ok' as const,
          value: message.payload.text === 'row A'
            ? {
                type: 'translate_response',
                payload: { messageId: message.payload.messageId, translatedText: 'translated:row A' },
              }
            : {
                type: 'translate_response',
                payload: { messageId: message.payload.messageId, error: { type: 'timeout' } },
              },
        }
      }
      return { kind: 'ok' as const, value: undefined }
    })
    const handler = new TwitchMessageHandler(
      undefined,
      undefined,
      sender as unknown as RuntimeMessageSender,
      onManualRetry,
    )
    const row = createMessage('row A')
    const body = row.querySelector('.chat-line__message-body')!
    await handler.translateAndInject(row, SETTINGS)
    body.textContent = 'row B'

    await handler.translateAndInject(row, SETTINGS)
    await handler.translateAndInject(row, SETTINGS)
    await handler.translateAndInject(row, SETTINGS)

    expect(currentText).toBe('row B')
    expect(row.querySelectorAll('[data-tachi-lens-error="true"]')).toHaveLength(1)
    expect(row.querySelectorAll('[data-tachi-lens-translated]:not([data-tachi-lens-error])')).toHaveLength(0)
    expect(row.getAttribute('data-tachi-lens-processed')).toBeNull()
    expect(row.getAttribute('data-tachi-lens-original-hash')).toBeNull()
    row.querySelector<HTMLButtonElement>('[data-tachi-lens-error="true"]')?.click()
    expect(onManualRetry).toHaveBeenCalledWith(row)
  })
})
