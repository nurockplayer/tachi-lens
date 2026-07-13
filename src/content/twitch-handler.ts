import type { DiagnosticStage, ErrorNotification, MessageType, TranslationResult } from '@/shared/messages'
import { isLikelyTraditionalChinese, isTraditionalChineseTarget } from './language-detection'
import { isSlashMe, isLinksOnly, isNumbersOnly, type FilterConfig } from './message-filter'
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
  filterConfig: FilterConfig
}

export type DiagnosticReporter = (stage: DiagnosticStage, detail?: string) => void

export type RuntimeMessageSender = <T>(message: unknown) => Promise<RuntimeMessageResult<T>>

export interface TranslationAttemptResult {
  retryAfterMs?: number
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

// Broader selector to find the message text area in any known Twitch variant
const CHAT_MESSAGE_TEXT_AREA =
  '[data-a-target="chat-line-message-body"], [class*="chat-line__message-body"], [data-a-target="chat-message-text"]'

/**
 * Extract a lowercased Twitch channel name from the given URL pathname.
 */
export const parseChannelFromPathname = (pathname: string): string | undefined => {
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
      debugLog('shouldTranslate: bot skip', { username })
      return false
    }
    if (text.length < settings.minTextLength) {
      debugLog('shouldTranslate: too short', { text, len: text.length, min: settings.minTextLength })
      return false
    }
    if (isTraditionalChineseTarget(settings.targetLanguage) && isLikelyTraditionalChinese(text)) {
      debugLog('shouldTranslate: already Traditional Chinese')
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

    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
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
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */

    return true
  }

  private setProcessed(element: HTMLElement, text: string): void {
    element.setAttribute(ATTR_PROCESSED, 'true')
    element.setAttribute(ATTR_ORIGINAL_HASH, textHash(text))
  }

  async translateAndInject(
    element: HTMLElement,
    settings: ContentSettings,
  ): Promise<TranslationAttemptResult> {
    const text = this.getMessageText(element)
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
        payload: { messageId, text },
      })

      if (runtimeResult.kind === 'context_invalidated') {
        return {}
      }

      const response = runtimeResult.value

      if (!response?.payload) {
        debugLog('translateAndInject: no response payload, marking processed', { messageId })
        this.diagnosticReporter?.('translation_failed', 'Service Worker 沒有回傳翻譯結果')
        this.setProcessed(element, text)
        return {}
      }

      const result = response.payload

      if (result.translatedText) {
        this.diagnosticReporter?.('translation_received')
        this.injectTranslation(element, result.translatedText, settings.displayMode)
        this.setProcessed(element, text)
        this.diagnosticReporter?.('translation_injected')
      } else if (result.error?.type === 'rate_limited') {
        debugLog('translateAndInject: rate limited, leaving retryable', { messageId })
        const retrySeconds = Math.max(0, result.error.retryAfterMs) / 1_000
        const errorMessage = result.error.message.trim().slice(0, 500) || '翻譯服務暫時受到速率限制'
        this.diagnosticReporter?.(
          'translation_failed',
          `${errorMessage}（${retrySeconds} 秒後重試）`,
        )
        return { retryAfterMs: result.error.retryAfterMs }
      } else {
        debugLog('translateAndInject: error', { messageId, error: result.error })
        this.diagnosticReporter?.('translation_failed', result.error?.message ?? '翻譯服務回傳未知錯誤')
        this.setProcessed(element, text)
        this.injectError(element, result.error)
      }
    } catch {
      debugLog('translateAndInject: runtime messaging failed, leaving retryable')
      this.diagnosticReporter?.('translation_failed', '無法連線至 Service Worker')
    }

    return {}
  }

  private injectTranslation(element: HTMLElement, translatedText: string, displayMode: DisplayMode): void {
    const existing = element.querySelector(`[${ATTR_TRANSLATED}]`)
    if (existing) return

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

  private injectError(element: HTMLElement, error?: { type: string; message: string }): void {
    const existing = element.querySelector(`[${ATTR_TRANSLATED}]`)
    if (existing) return

    const errorIcon = this.getErrorIcon(error?.type)
    const errorColor = this.getErrorColor(error?.type)

    const errorEl = document.createElement('span')
    errorEl.setAttribute(ATTR_TRANSLATED, 'true')
    errorEl.textContent = errorIcon
    errorEl.title = error?.message ?? '翻譯失敗'
    errorEl.style.cssText = `margin-left: 0.25rem; cursor: help; font-size: 0.85em; opacity: 0.6; color: ${errorColor};`

    element.appendChild(errorEl)
    this.sendErrorNotification(error)
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
