// Twitch DOM selector contract
// All selectors used to find Twitch chat messages are defined here.
// When Twitch changes their DOM, only this file needs updating.

export const CHAT_CONTAINER = '[data-test-selector="chat-scrollable-area__message-container"]'
export const CHAT_MESSAGE = '.chat-line__message'
export const CHAT_MESSAGE_BODY = '[data-a-target="chat-line-message-body"]'
export const CHAT_USERNAME = '.chat-author__display-name'
export const CHAT_WHISPER = '[data-test-selector="whisper-message"]'

// Fallback selectors for each primary selector
export const FALLBACKS: Record<string, string[]> = {
  [CHAT_CONTAINER]: [
    CHAT_CONTAINER,
    '.chat-scrollable-area__message-container',
    '[role="log"]',
  ],
  [CHAT_MESSAGE]: [
    CHAT_MESSAGE,
    '[data-test-selector="chat-message"]',
  ],
  [CHAT_MESSAGE_BODY]: [
    CHAT_MESSAGE_BODY,
    '.chat-line__message-body',
    '[data-a-target="chat-message-text"]',
    '.text-fragment',
  ],
  [CHAT_USERNAME]: [
    CHAT_USERNAME,
    '[data-a-target="chat-message-username"]',
    '.chat-line__username',
  ],
}

// Chat message attributes
export const ATTR_PROCESSED = 'data-tachi-lens-processed'
export const ATTR_TRANSLATED = 'data-tachi-lens-translated'
export const ATTR_ORIGINAL_HASH = 'data-tachi-lens-original-hash'

export type PageType = 'channel' | 'popout' | 'vod' | 'clip' | 'unknown'

export interface PageSelectors {
  CHAT_CONTAINER: string
  CHAT_MESSAGE: string
  CHAT_MESSAGE_BODY: string
  CHAT_USERNAME: string
  CHAT_WHISPER?: string
}

const CHANNEL_SELECTORS: PageSelectors = {
  CHAT_CONTAINER,
  CHAT_MESSAGE,
  CHAT_MESSAGE_BODY,
  CHAT_USERNAME,
  CHAT_WHISPER,
}

const POPOUT_SELECTORS: PageSelectors = {
  CHAT_CONTAINER: '.chat-scrollable-area__message-container',
  CHAT_MESSAGE,
  CHAT_MESSAGE_BODY,
  CHAT_USERNAME,
  CHAT_WHISPER,
}

const SELECTOR_MAP: Record<PageType, PageSelectors> = {
  channel: CHANNEL_SELECTORS,
  popout: POPOUT_SELECTORS,
  vod: CHANNEL_SELECTORS,
  clip: CHANNEL_SELECTORS,
  unknown: CHANNEL_SELECTORS,
}

export const detectPageType = (url: string): PageType => {
  try {
    const { hostname, pathname } = new URL(url)
    if (!hostname.endsWith('.twitch.tv') && hostname !== 'twitch.tv') return 'unknown'
    if (hostname === 'clips.twitch.tv') return 'clip'
    if (pathname.startsWith('/popout/')) return 'popout'
    if (pathname.startsWith('/videos/')) return 'vod'
    if (pathname.startsWith('/directory/')) return 'channel'
    if (pathname.startsWith('/clip/')) return 'clip'
    const segments = pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (segments.length === 0 || segments.length === 1) return 'channel'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export const getSelectorsForPage = (pageType: PageType): PageSelectors =>
  SELECTOR_MAP[pageType]

/**
 * Try a selector with fallbacks.
 * Returns the first matching element or null.
 */
export const queryFirst = (scope: ParentNode, primary: string): Element | null => {
  const fallbacks = FALLBACKS[primary]
  if (!fallbacks) return scope.querySelector(primary)

  for (const sel of fallbacks) {
    const el = scope.querySelector(sel)
    if (el) return el
  }
  return null
}

/**
 * Query every selector fallback and return unique matches in selector priority order.
 */
export const queryFirstAll = (scope: ParentNode, primary: string): Element[] => {
  const fallbacks = FALLBACKS[primary]
  if (!fallbacks) return Array.from(scope.querySelectorAll(primary))

  const seen = new Set<Element>()
  const results: Element[] = []
  for (const sel of fallbacks) {
    for (const node of scope.querySelectorAll(sel)) {
      if (seen.has(node)) continue
      seen.add(node)
      results.push(node)
    }
  }
  return results
}

/**
 * Test whether an element matches a primary selector or any of its fallbacks.
 * Falls back to element.matches(primary) when primary has no fallback entry.
 */
export const matchesFirst = (element: Element, primary: string): boolean => {
  const fallbacks = FALLBACKS[primary]
  if (!fallbacks) return element.matches(primary)
  return fallbacks.some((sel) => element.matches(sel))
}
