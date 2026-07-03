import type { ErrorNotification, MessageType, TranslationResult } from '@/shared/messages'
import { isSlashMe, isLinksOnly, isNumbersOnly, type FilterConfig } from './message-filter'
import {
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
  filterConfig: FilterConfig
}

interface ChromeRuntime {
  sendMessage: (message: unknown) => Promise<unknown>
}

declare const chrome: { runtime: ChromeRuntime }

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

  constructor(selectors?: PageSelectors) {
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
    const body = queryFirst(element, this.selectors.CHAT_MESSAGE_BODY)
    return body?.textContent?.trim() ?? ''
  }

  getMessageUsername(element: HTMLElement): string {
    const usernameEl = queryFirst(element, this.selectors.CHAT_USERNAME)
    return usernameEl?.textContent?.trim() ?? ''
  }

  isBot(username: string, blacklist: string[]): boolean {
    if (blacklist.length === 0) return false
    const normalized = username.toLowerCase()
    return blacklist.some((entry) => entry.toLowerCase() === normalized)
  }

  isAlreadyProcessed(element: HTMLElement): boolean {
    return element.getAttribute(ATTR_PROCESSED) === 'true'
  }

  hasUsername(element: HTMLElement): boolean {
    return queryFirst(element, this.selectors.CHAT_USERNAME) !== null
  }

  shouldTranslate(element: HTMLElement, settings: ContentSettings): boolean {
    if (this.isAlreadyProcessed(element)) return false

    const fc = settings.filterConfig
    const username = this.getMessageUsername(element)
    const text = this.getMessageText(element)

    if (this.isBot(username, settings.botNameBlacklist)) return false
    if (text.length < settings.minTextLength) return false

    // Text-based filters (no DOM access needed)
    if (fc.skipSlashMe && isSlashMe(text)) return false
    if (fc.skipLinksOnly && isLinksOnly(text)) return false
    if (fc.skipNumbersOnly && isNumbersOnly(text)) return false

    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    // DOM structure-based filters
    if (fc.skipSystemMessages && !this.hasUsername(element)) return false

    // Emote-only: if at least one emote element exists and text is emote-only
    if (fc.skipEmotesOnly) {
      const hasEmoteImage = element.querySelector('img[class*="emote"], img[alt][src*="cdn"]')
      const hasOnlyNormalText = hasEmoteImage !== null && !/[^\p{L}\s]/u.test(text)
      if (hasOnlyNormalText && text.trim().split(/\s+/).length <= 4) return false
    }

    // Cheermote: contains cheer/bit elements
    if (fc.skipCheermotes) {
      const hasCheermote = element.querySelector('[class*="cheer"], [class*="bits"]')
      if (hasCheermote) return false
    }

    // Whisper: has whisper-specific class or structure
    if (fc.skipWhispers) {
      const isWhisper = this.selectors.CHAT_WHISPER
        ? matchesFirst(element, this.selectors.CHAT_WHISPER)
        : false
      if (isWhisper) return false
    }

    // Reply: has reply parent
    if (fc.skipReplies) {
      const isReply = element.querySelector('[data-a-target*="reply"], [class*="reply"]')
      if (isReply) return false
    }
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */

    return true
  }

  async translateAndInject(
    element: HTMLElement,
    settings: ContentSettings,
  ): Promise<void> {
    if (!this.shouldTranslate(element, settings)) {
      // Deterministic skip — mark processed to avoid infinite retry
      element.setAttribute(ATTR_PROCESSED, 'true')
      return
    }

    if (!settings.translationEnabled) return

    const text = this.getMessageText(element)
    const messageId = this.getMessageId(element)

    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'translate_request' as MessageType,
        payload: { messageId, text },
      })) as { type: string; payload: TranslationResult } | undefined

      if (!response?.payload) {
        element.setAttribute(ATTR_PROCESSED, 'true')
        return
      }

      const result = response.payload

      if (result.translatedText) {
        this.injectTranslation(element, result.translatedText, settings.displayMode)
        element.setAttribute(ATTR_PROCESSED, 'true')
      } else if (result.error?.type === 'rate_limited') {
      } else {
        element.setAttribute(ATTR_PROCESSED, 'true')
        this.injectError(element, result.error)
      }
    } catch {
      element.setAttribute(ATTR_PROCESSED, 'true')
    }
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
      // Floating tooltip
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

    try {
      void chrome.runtime.sendMessage({
        type: 'error_notification',
        payload: notification,
      } as const)
    } catch {
      // SW may not be available
    }
  }
}
