import type { MessageType, TranslationResult } from '@/shared/messages'
import {
  ATTR_PROCESSED,
  ATTR_TRANSLATED,
  CHAT_MESSAGE_BODY,
  CHAT_USERNAME,
  type PageSelectors,
} from './twitch-selectors'

export type DisplayMode = 'below' | 'hover' | 'collapse'

export interface ContentSettings {
  botNameBlacklist: string[]
  minTextLength: number
  displayMode: DisplayMode
  translationEnabled: boolean
}

interface ChromeRuntime {
  sendMessage: (message: unknown) => Promise<unknown>
}

declare const chrome: { runtime: ChromeRuntime }

/**
 * Extract a lowercased Twitch channel name from the given URL pathname.
 * Returns undefined for root ('/') or empty path.
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
    const body = element.querySelector(this.selectors.CHAT_MESSAGE_BODY)
    return body?.textContent?.trim() ?? ''
  }

  getMessageUsername(element: HTMLElement): string {
    const usernameEl = element.querySelector(this.selectors.CHAT_USERNAME)
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

  shouldTranslate(element: HTMLElement, settings: ContentSettings): boolean {
    if (this.isAlreadyProcessed(element)) return false

    const username = this.getMessageUsername(element)

    if (this.isBot(username, settings.botNameBlacklist)) return false

    const text = this.getMessageText(element)

    if (text.length < settings.minTextLength) return false

    return true
  }

  async translateAndInject(
    element: HTMLElement,
    settings: ContentSettings,
  ): Promise<void> {
    if (!this.shouldTranslate(element, settings)) return

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
        // Don't mark as processed — allow retry on next observation
      } else {
        // Non-rate-limit error: mark as processed and show error indicator
        element.setAttribute(ATTR_PROCESSED, 'true')
        this.injectError(element, result.error)
      }
    } catch {
      // Network error or SW unavailable — do nothing
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
      container.style.cssText = 'color: #a0a0a0; font-style: italic; font-size: 0.9em; display: none;'
      element.style.position = 'relative'
      element.appendChild(container)
      // Show translation on hover
      element.addEventListener('mouseenter', () => { container.style.display = 'block' }, { once: true })
    } else if (displayMode === 'collapse') {
      container.style.cssText = 'color: #a0a0a0; font-style: italic; font-size: 0.9em;'
      // Hide original text, show only translation
      const body = element.querySelector(CHAT_MESSAGE_BODY)
      if (body instanceof HTMLElement) {
        body.style.display = 'none'
      }
      element.appendChild(container)
    }
  }

  private injectError(element: HTMLElement, error?: { type: string; message: string }): void {
    const existing = element.querySelector(`[${ATTR_TRANSLATED}]`)
    if (existing) return

    const errorEl = document.createElement('span')
    errorEl.setAttribute(ATTR_TRANSLATED, 'true')
    errorEl.textContent = '⚠️'
    errorEl.title = error?.message ?? '翻譯失敗'
    errorEl.style.cssText = 'margin-left: 0.25rem; cursor: help; font-size: 0.85em; opacity: 0.6;'

    element.appendChild(errorEl)
  }
}
