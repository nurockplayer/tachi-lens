import type { MessageType, TranslationResult } from '@/shared/messages'
import { CHAT_MESSAGE_BODY, CHAT_USERNAME, ATTR_PROCESSED, ATTR_TRANSLATED } from './twitch-selectors'

export interface MessageFilter {
  botNameBlacklist: string[]
  minTextLength: number
}

interface ChromeRuntime {
  sendMessage: (message: unknown) => Promise<unknown>
}

declare const chrome: { runtime: ChromeRuntime }

export class TwitchMessageHandler {
  private counter = 0

  getMessageId(_element: HTMLElement): string {
    this.counter++
    return `msg-${Date.now()}-${this.counter}`
  }

  getMessageText(element: HTMLElement): string {
    const body = element.querySelector(CHAT_MESSAGE_BODY)
    return body?.textContent?.trim() ?? ''
  }

  getMessageUsername(element: HTMLElement): string {
    const usernameEl = element.querySelector(CHAT_USERNAME)
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

  shouldTranslate(element: HTMLElement, filter: MessageFilter): boolean {
    if (this.isAlreadyProcessed(element)) return false

    const username = this.getMessageUsername(element)

    if (this.isBot(username, filter.botNameBlacklist)) return false

    const text = this.getMessageText(element)

    if (text.length < filter.minTextLength) return false

    return true
  }

  async translateAndInject(
    element: HTMLElement,
    filter: MessageFilter,
  ): Promise<void> {
    if (!this.shouldTranslate(element, filter)) return

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
        this.injectTranslation(element, result.translatedText)
        element.setAttribute(ATTR_PROCESSED, 'true')
      } else if (result.error?.type === 'rate_limited') {
        // Don't mark as processed — allow retry on next observation
      } else {
        // Non-rate-limit error: mark as processed to avoid retry
        element.setAttribute(ATTR_PROCESSED, 'true')
      }
    } catch {
      // Network error or SW unavailable — do nothing
    }
  }

  private injectTranslation(element: HTMLElement, translatedText: string): void {
    const existing = element.querySelector(`[${ATTR_TRANSLATED}]`)

    if (existing) return

    const container = document.createElement('div')
    container.setAttribute(ATTR_TRANSLATED, 'true')
    container.textContent = translatedText
    container.style.cssText = 'color: #a0a0a0; font-style: italic; font-size: 0.9em;'

    element.appendChild(container)
  }
}
