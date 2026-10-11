import type { DiagnosticStage, ErrorNotification, MessageType, TranslationResult } from '@/shared/messages'
import { isSlashMe, isLinksOnly, isNumbersOnly, type FilterConfig } from './message-filter'
import { shouldSkipMessage, type ChineseVariantMode } from '@/shared/language-detection'
import {
  safeRuntimeSendMessage,
  type RuntimeMessageResult,
  type RuntimeMessagePort,
} from './runtime-messaging'
import {
  ATTR_ORIGINAL_HASH,
  ATTR_PROCESSED,
  ATTR_TRANSLATED,
  CHAT_MESSAGE_BODY,
  CHAT_USERNAME,
  matchesFirst,
  queryFirst,
  type PageSelectors,
} from './twitch-selectors'

export type DisplayMode = 'below' | 'hover' | 'collapse'

export interface ContentSettings {
  botNameBlacklist: string[]
  minTextLength: number
  displayMode: DisplayMode
  translationEnabled: boolean
  targetLanguage?: string
  chineseVariantMode: ChineseVariantMode
  filterConfig: FilterConfig
}

export type DiagnosticReporter = (stage: DiagnosticStage, detail?: string) => void

export type RuntimeMessageSender = <T>(message: unknown) => Promise<RuntimeMessageResult<T>>

export interface TranslationAttemptResult {
  retryAfterMs?: number
  messageRetryAfterMs?: number
  translationDisabled?: boolean
}

declare const chrome: { runtime: RuntimeMessagePort }

const defaultRuntimeMessageSender: RuntimeMessageSender = <T>(message: unknown) =>
  safeRuntimeSendMessage<T>(chrome.runtime, message, () => undefined)

const textHash = (s: string): string => {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i)
    hash |= 0
  }
  return hash.toString(36)
}

const debugLog = (msg: string, ...args: unknown[]): void => {
  console.debug('[tachi-lens]', msg, ...args)
}

const MAX_TRANSLATION_ATTEMPTS = 3
const BASE_MESSAGE_RETRY_MS = 5_000
const MAX_MESSAGE_RETRY_MS = 30_000
type FailureIdentity = {
  body: Element | null
  identityAttribute?: typeof CHAT_MESSAGE_ID_ATTRIBUTES[number]
  identityValue: string | null
}
type MessageFailure = FailureIdentity & {
  text: string
  attempts: number
  nextRetryAt: number
  terminal: boolean
  errorType: string
}
const messageFailures = new WeakMap<HTMLElement, {
  text: string
  attempts: number
  nextRetryAt: number
  terminal: boolean
  errorType: string
  body: Element | null
  identityAttribute?: typeof CHAT_MESSAGE_ID_ATTRIBUTES[number]
  identityValue: string | null
}>()

// Broader selector to find the message text area in any known Twitch variant
const CHAT_MESSAGE_TEXT_AREA =
  '[data-a-target="chat-line-message-body"], [class*="chat-line__message-body"], [data-a-target="chat-message-text"]'
const CHAT_MESSAGE_ID_ATTRIBUTES = ['data-message-id', 'data-message-key', 'data-id', 'id'] as const

/**
 * Extract a lowercased Twitch channel name from the given URL pathname.
 */
export const parseChannelFromPathname = (pathname: string): string | undefined => {
  const popoutMatch = pathname.match(/^\/popout\/([^/]+)(?:\/chat)?(?:\/|$)/i)
  if (popoutMatch?.[1]) return popoutMatch[1].toLowerCase()

  const match = pathname.match(/^\/([^/]+)/)
  return match?.[1]?.toLowerCase()
}

export class TwitchMessageHandler {
  private counter = 0
  private selectors: PageSelectors

  constructor(
    selectors?: PageSelectors,
    private readonly diagnosticReporter?: DiagnosticReporter,
    private readonly runtimeMessageSender: RuntimeMessageSender = defaultRuntimeMessageSender,
    private readonly onManualRetry?: (element: HTMLElement) => void,
  ) {
    this.selectors = selectors ?? {
      CHAT_MESSAGE_BODY,
      CHAT_USERNAME,
      CHAT_CONTAINER: '',
      CHAT_MESSAGE: '',
    }
  }

  getChannelName(pathname?: string): string | undefined {
    return parseChannelFromPathname(pathname ?? window.location.pathname)
  }

  getMessageId(_element: HTMLElement): string {
    this.counter++
    return `msg-${Date.now()}-${this.counter}`
  }

  getMessageText(element: HTMLElement): string {
    const body = queryFirst(element, this.selectors.CHAT_MESSAGE_BODY) ??
      element.querySelector(CHAT_MESSAGE_TEXT_AREA)
    return body?.textContent?.trim() ?? ''
  }

  getMessageUsername(element: HTMLElement): string {
    const usernameEl = queryFirst(element, this.selectors.CHAT_USERNAME) ??
      element.querySelector('.chat-author__display-name, [data-a-target="chat-message-username"]')
    return usernameEl?.textContent?.trim() ?? ''
  }

  isBot(username: string, blacklist: string[]): boolean {
    if (blacklist.length === 0) return false
    const normalized = username.toLowerCase()
    return blacklist.some((entry) => entry.toLowerCase() === normalized)
  }

  /**
   * Check if element was already processed. If the element's text hash
   * differs from the stored hash, the node was recycled by Twitch's
   * virtual scroll — treat as not yet processed.
   */
  isAlreadyProcessed(element: HTMLElement): boolean {
    const failure = this.currentFailure(element)
    if (failure?.terminal) return true
    if (element.getAttribute(ATTR_PROCESSED) !== 'true') return false
    const storedHash = element.getAttribute(ATTR_ORIGINAL_HASH)
    if (!storedHash) return true
    const currentHash = textHash(this.getMessageText(element))
    return currentHash === storedHash
  }

  hasUsername(element: HTMLElement): boolean {
    return queryFirst(element, this.selectors.CHAT_USERNAME) !== null
  }

  shouldTranslate(element: HTMLElement, settings: ContentSettings): boolean {
    if (this.isAlreadyProcessed(element)) {
      debugLog('shouldTranslate: already processed')
      return false
    }

    const fc = settings.filterConfig
    const username = this.getMessageUsername(element)
    const text = this.getMessageText(element)

    if (this.isBot(username, settings.botNameBlacklist)) {
      debugLog('shouldTranslate: bot skip')
      return false
    }
    if (text.length < settings.minTextLength) {
      debugLog('shouldTranslate: too short')
      return false
    }
    // High-confidence target-language skip (#55, #183). When the target
    // language is Chinese and the message is confidently already in the target
    // language, or the target family is ja/ko/en and the message is confidently
    // already in that language, skip it before any translate_request reaches
    // the Service Worker. The shared detector only skips on high confidence;
    // mixed-language, uncertain, or non-target messages fall through to the
    // normal flow.
    if (settings.targetLanguage && shouldSkipMessage(text, settings.targetLanguage, settings.chineseVariantMode)) {
      debugLog('shouldTranslate: target-language skip')
      return false
    }
    // Text-based filters (no DOM access needed)
    if (fc.skipSlashMe && isSlashMe(text)) {
      debugLog('shouldTranslate: slashMe skip')
      return false
    }
    if (fc.skipLinksOnly && isLinksOnly(text)) {
      debugLog('shouldTranslate: linksOnly skip')
      return false
    }
    if (fc.skipNumbersOnly && isNumbersOnly(text)) {
      debugLog('shouldTranslate: numbersOnly skip')
      return false
    }

    // DOM structure-based filters
    if (fc.skipSystemMessages && !this.hasUsername(element)) {
      debugLog('shouldTranslate: systemMessage skip (no username)')
      return false
    }

    // Emote-only: check if message body contains emote images without visible text
    if (fc.skipEmotesOnly) {
      const bodyElement = queryFirst(element, this.selectors.CHAT_MESSAGE_BODY) ??
        element.querySelector(CHAT_MESSAGE_TEXT_AREA)
      if (bodyElement) {
        const bodyEmotes = bodyElement.querySelectorAll('img[class*="emote"]')
        if (bodyEmotes.length > 0) {
          const hasVisibleText = Boolean(bodyElement.textContent?.trim())
          if (!hasVisibleText) {
            debugLog('shouldTranslate: emoteOnly skip')
            return false
          }
        }
      }
    }

    // Cheermote: contains cheer/bit elements
    if (fc.skipCheermotes) {
      const hasCheermote = element.querySelector('[class*="cheer"], [class*="bits"]')
      if (hasCheermote) {
        debugLog('shouldTranslate: cheermote skip')
        return false
      }
    }

    // Whisper: has whisper-specific class or structure
    if (fc.skipWhispers) {
      const isWhisper = this.selectors.CHAT_WHISPER
        ? matchesFirst(element, this.selectors.CHAT_WHISPER)
        : false
      if (isWhisper) {
        debugLog('shouldTranslate: whisper skip')
        return false
      }
    }

    // Reply: Twitch renders a reply action icon inside every normal message,
    // so only reply state on the message root itself is meaningful here.
    if (fc.skipReplies) {
      const isReply = element.matches('[data-a-target*="reply"], [class*="reply"]')
      if (isReply) {
        debugLog('shouldTranslate: reply skip')
        return false
      }
    }
    return true
  }

  private setProcessed(element: HTMLElement, text: string): void {
    element.setAttribute(ATTR_PROCESSED, 'true')
    element.setAttribute(ATTR_ORIGINAL_HASH, textHash(text))
  }

  private captureFailureIdentity(element: HTMLElement): FailureIdentity {
    const identityAttribute = CHAT_MESSAGE_ID_ATTRIBUTES.find((name) => element.hasAttribute(name))
    return {
      body: queryFirst(element, this.selectors.CHAT_MESSAGE_BODY) ?? element.querySelector(CHAT_MESSAGE_TEXT_AREA),
      ...(identityAttribute === undefined ? {} : { identityAttribute }),
      identityValue: identityAttribute === undefined ? null : element.getAttribute(identityAttribute),
    }
  }

  private failureMatches(element: HTMLElement, failure: MessageFailure): boolean {
    const current = this.captureFailureIdentity(element)
    return failure.text === this.getMessageText(element) && failure.body === current.body &&
      failure.identityAttribute === current.identityAttribute && failure.identityValue === current.identityValue
  }

  private currentFailure(element: HTMLElement): MessageFailure | undefined {
    const failure = messageFailures.get(element)
    if (!failure) return undefined
    if (this.failureMatches(element, failure)) return failure
    messageFailures.delete(element)
    element.querySelectorAll('[data-tachi-lens-error="true"]').forEach((node) => node.remove())
    return undefined
  }

  async translateAndInject(
    element: HTMLElement,
    settings: ContentSettings,
    priority: 'live' | 'backlog' = 'live',
    isCurrent: () => boolean = () => true,
  ): Promise<TranslationAttemptResult> {
    const text = this.getMessageText(element)
    const originalBody = queryFirst(element, this.selectors.CHAT_MESSAGE_BODY) ??
      element.querySelector(CHAT_MESSAGE_TEXT_AREA)
    const identityAttribute = CHAT_MESSAGE_ID_ATTRIBUTES.find((name) => element.hasAttribute(name))
    const originalIdentity = identityAttribute === undefined ? undefined : element.getAttribute(identityAttribute)
    const isSameAttempt = (): boolean => {
      const currentBody = queryFirst(element, this.selectors.CHAT_MESSAGE_BODY) ??
        element.querySelector(CHAT_MESSAGE_TEXT_AREA)
      const currentIdentityAttribute = CHAT_MESSAGE_ID_ATTRIBUTES.find((name) => element.hasAttribute(name))
      return this.getMessageText(element) === text && currentBody === originalBody &&
        currentIdentityAttribute === identityAttribute &&
        (identityAttribute === undefined || element.getAttribute(identityAttribute) === originalIdentity)
    }
    if (!text) {
      const bodyElement = queryFirst(element, this.selectors.CHAT_MESSAGE_BODY) ??
        element.querySelector(CHAT_MESSAGE_TEXT_AREA)
      const hasEmote = bodyElement?.querySelector('img[class*="emote"]') !== null

      if (bodyElement && hasEmote) {
        this.diagnosticReporter?.('message_skipped', '訊息僅包含表情符號')
        this.setProcessed(element, text)
        return {}
      }

      this.diagnosticReporter?.('message_not_ready')
      return {}
    }

    if (!this.shouldTranslate(element, settings)) {
      this.diagnosticReporter?.('message_skipped', '訊息不符合目前的翻譯規則')
      this.setProcessed(element, text)
      return {}
    }

    if (!settings.translationEnabled) {
      this.diagnosticReporter?.('message_skipped', '翻譯功能已關閉')
      this.setProcessed(element, text)
      return {}
    }

    const messageId = this.getMessageId(element)

    try {
      this.diagnosticReporter?.('translation_requested')
      const runtimeResult = await this.runtimeMessageSender<{ type: string; payload: TranslationResult }>({
        type: 'translate_request' as MessageType,
        payload: { messageId, text, priority },
      })

      if (runtimeResult.kind === 'context_invalidated') {
        return {}
      }

      const response = runtimeResult.value
      if (!isCurrent() || !isSameAttempt()) return {}

      if (response?.type !== 'translate_response' || !response.payload ||
        response.payload.messageId !== messageId) {
        debugLog('translateAndInject: missing or mismatched response, leaving retryable', { messageId })
        this.diagnosticReporter?.('translation_failed')
        return this.recordRetryableFailure(element, text, 'invalid_response')
      }

      const result = response.payload

      // The Service Worker returns an empty TranslationResult when persisted
      // chat translation is disabled between settings hydration and dispatch.
      // Treat that response as a silent cancellation, never as a provider
      // error, so the content script cannot inject a visible fallback.
      if (result.translatedText === undefined && result.error === undefined) {
        this.diagnosticReporter?.('message_skipped', '翻譯功能已關閉')
        return { translationDisabled: true }
      }

      // Only a non-empty, non-whitespace translatedText is a usable success.
      // A whitespace-only or empty string is not injected and follows the
      // bounded invalid-response retry path instead (#129).
      const hasUsableResult =
        typeof result.translatedText === 'string' && result.translatedText.trim().length > 0
      const isInvalidTranslation =
        result.error?.type === 'invalid_response' ||
        (typeof result.translatedText === 'string' && !hasUsableResult)

      if (hasUsableResult && typeof result.translatedText === 'string') {
        messageFailures.delete(element)
        this.diagnosticReporter?.('translation_received')
        if (this.injectTranslation(element, result.translatedText, settings.displayMode)) {
          this.setProcessed(element, text)
          this.diagnosticReporter?.('translation_injected')
        } else {
          this.diagnosticReporter?.('translation_failed')
        }
      } else if (result.error?.type === 'rate_limited') {
        debugLog('translateAndInject: rate limited, leaving retryable', { messageId })
        this.diagnosticReporter?.('translation_failed')
        return this.recordRetryableFailure(element, text, 'rate_limited', result.error.retryAfterMs)
      } else if (isInvalidTranslation) {
        debugLog('translateAndInject: invalid response, tracking retries', { messageId })
        this.diagnosticReporter?.('translation_failed')
        return this.recordRetryableFailure(element, text, 'invalid_response')
      } else {
        debugLog('translateAndInject: error', { messageId, errorType: result.error?.type })
        this.diagnosticReporter?.('translation_failed')
        const errorType = result.error?.type ?? 'unknown'
        if (errorType === 'network' || errorType === 'timeout') {
          return this.recordRetryableFailure(element, text, errorType)
        }
        this.recordTerminalFailure(element, text, errorType)
        this.injectError(element, errorType, text)
      }
    } catch {
      if (!isCurrent() || !isSameAttempt()) return {}
      debugLog('translateAndInject: runtime messaging failed, leaving retryable')
      this.diagnosticReporter?.('translation_failed')
      return this.recordRetryableFailure(element, text, 'network')
    }

    return {}
  }

  canAutoRetry(element: HTMLElement, now = Date.now()): boolean {
    const failure = this.currentFailure(element)
    if (!failure) return true
    return !failure.terminal && now >= failure.nextRetryAt
  }

  isRetryCandidate(element: HTMLElement): boolean {
    const failure = this.currentFailure(element)
    return failure !== undefined && !failure.terminal
  }

  retryFailedMessage(element: HTMLElement): boolean {
    const failure = this.currentFailure(element)
    if (!failure || !failure.terminal) return false
    messageFailures.delete(element)
    element.querySelectorAll('[data-tachi-lens-error="true"]').forEach((node) => node.remove())
    element.removeAttribute(ATTR_PROCESSED)
    element.removeAttribute(ATTR_ORIGINAL_HASH)
    return true
  }

  private recordRetryableFailure(
    element: HTMLElement,
    text: string,
    errorType: string,
    providerCooldownMs?: number,
  ): TranslationAttemptResult {
    const identity = this.captureFailureIdentity(element)
    const previous = this.currentFailure(element)
    const attempts = previous?.text === text ? previous.attempts + 1 : 1
    const exhausted = attempts >= MAX_TRANSLATION_ATTEMPTS
    const baseDelay = Math.min(MAX_MESSAGE_RETRY_MS, BASE_MESSAGE_RETRY_MS * 2 ** (attempts - 1))
    const messageRetryAfterMs = Math.round(baseDelay * (0.8 + Math.random() * 0.4))
    const delay = Math.max(messageRetryAfterMs, providerCooldownMs ?? 0)
    messageFailures.set(element, {
      text,
      attempts,
      nextRetryAt: Date.now() + delay,
      terminal: exhausted,
      errorType,
      ...identity,
    })

    if (exhausted) {
      this.injectError(element, errorType, text)
      return providerCooldownMs === undefined ? {} : { retryAfterMs: providerCooldownMs }
    }
    return {
      ...(providerCooldownMs === undefined ? {} : { retryAfterMs: providerCooldownMs }),
      messageRetryAfterMs: delay,
    }
  }

  private recordTerminalFailure(element: HTMLElement, text: string, errorType: string): void {
    messageFailures.set(element, {
      text,
      attempts: MAX_TRANSLATION_ATTEMPTS,
      nextRetryAt: Number.POSITIVE_INFINITY,
      terminal: true,
      errorType,
      ...this.captureFailureIdentity(element),
    })
  }

  private injectTranslation(element: HTMLElement, translatedText: string, displayMode: DisplayMode): boolean {
    const existing = element.querySelector(`[${ATTR_TRANSLATED}]`)
    if (existing) return false

    const container = document.createElement('div')
    container.setAttribute(ATTR_TRANSLATED, 'true')
    container.textContent = translatedText

    if (displayMode === 'below') {
      container.style.cssText = 'color: #a0a0a0; font-style: italic; font-size: 0.9em;'
      element.appendChild(container)
    } else if (displayMode === 'hover') {
      container.style.cssText =
        'position: absolute; bottom: 100%; left: 0; background: rgba(15,15,15,0.95); color: #e0e0e0; padding: 4px 8px; border-radius: 4px; font-size: 0.85em; white-space: nowrap; pointer-events: none; z-index: 9999; display: none;'
      element.style.position = 'relative'
      element.appendChild(container)
      element.addEventListener('mouseenter', () => { container.style.display = 'block' })
      element.addEventListener('mouseleave', () => { container.style.display = 'none' })
    } else if (displayMode === 'collapse') {
      container.style.cssText = 'color: #a0a0a0; font-style: italic; font-size: 0.9em; cursor: pointer;'
      const body = queryFirst(element, this.selectors.CHAT_MESSAGE_BODY)
      if (body instanceof HTMLElement) {
        body.dataset.tachiLensOriginalDisplay = body.style.display || ''
        body.style.display = 'none'
      }
      container.addEventListener('click', () => {
        if (body instanceof HTMLElement) {
          if (body.style.display === 'none') {
            body.style.display = body.dataset.tachiLensOriginalDisplay || ''
          } else {
            body.style.display = 'none'
          }
        }
      })
      element.appendChild(container)
    }
    return true
  }

  private getErrorIcon(type?: string): string {
    switch (type) {
      case 'auth': return '🔑'
      case 'rate_limited': return '⏳'
      case 'timeout': return '⏰'
      case 'network': return '🌐'
      case 'unsupported_model': return '⚙️'
      default: return '⚠️'
    }
  }

  private getErrorColor(type?: string): string {
    switch (type) {
      case 'auth': return '#e74c3c'
      case 'rate_limited': return '#f39c12'
      case 'timeout': return '#e67e22'
      case 'network': return '#9b59b6'
      case 'unsupported_model': return '#3498db'
      default: return '#95a5a6'
    }
  }

  private injectError(element: HTMLElement, errorType = 'unknown', text = this.getMessageText(element)): void {
    const existing = element.querySelector(`[${ATTR_TRANSLATED}]`)
    if (existing) return

    const errorIcon = this.getErrorIcon(errorType)
    const errorColor = this.getErrorColor(errorType)

    const errorEl = document.createElement('button')
    errorEl.setAttribute(ATTR_TRANSLATED, 'true')
    errorEl.setAttribute('data-tachi-lens-error', 'true')
    errorEl.type = 'button'
    errorEl.textContent = errorIcon
    const reason = this.getFailureReason(errorType)
    const identity = this.captureFailureIdentity(element)
    errorEl.title = `${reason} Click to retry translation.`
    errorEl.setAttribute('aria-label', `${reason} Retry translation`)
    errorEl.style.cssText = `margin-left: 0.25rem; cursor: pointer; font-size: 0.85em; opacity: 0.8; color: ${errorColor}; background: transparent; border: 0; padding: 0;`
    errorEl.addEventListener('click', () => {
      const current = this.captureFailureIdentity(element)
      if (this.getMessageText(element) === text && current.body === identity.body &&
        current.identityAttribute === identity.identityAttribute && current.identityValue === identity.identityValue) {
        this.onManualRetry?.(element)
      }
    })

    element.appendChild(errorEl)
    this.sendErrorNotification({ type: errorType, message: reason })
  }

  private getFailureReason(errorType: string): string {
    switch (errorType) {
      case 'auth': return 'Check the provider API key or credentials.'
      case 'bad_request':
      case 'unsupported_model': return 'Check the selected provider and model.'
      case 'quota_exceeded': return 'The provider quota is unavailable.'
      case 'rate_limited': return 'The provider is rate limited; wait before retrying.'
      case 'timeout': return 'The translation request timed out.'
      case 'network': return 'The translation service could not be reached.'
      case 'invalid_response': return 'The provider returned no usable translation.'
      default: return 'The translation request failed.'
    }
  }

  private sendErrorNotification(error?: { type: string; message: string }): void {
    const notification: ErrorNotification = {
      id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: error?.type ?? 'unknown',
      message: error?.message ?? 'Unknown error',
      timestamp: Date.now(),
    }

    void this.runtimeMessageSender<void>({
      type: 'error_notification',
      payload: notification,
    } as const).catch((runtimeError: unknown) => {
      console.error('[tachi-lens] error notification runtime message failed', runtimeError)
    })
  }
}
