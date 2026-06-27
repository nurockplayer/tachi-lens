// Twitch DOM selector contract
// All selectors used to find Twitch chat messages are defined here.
// When Twitch changes their DOM, only this file needs updating.

export const CHAT_CONTAINER = '[data-test-selector="chat-scrollable-area__message-container"]'
export const CHAT_MESSAGE = '.chat-line__message'
export const CHAT_MESSAGE_BODY = '.chat-line__message-body'
export const CHAT_USERNAME = '.chat-author__display-name'

// Chat message attributes
export const ATTR_PROCESSED = 'data-tachi-lens-processed'
export const ATTR_TRANSLATED = 'data-tachi-lens-translated'

// Page types supported by the content script
export type PageType = 'channel' | 'popout' | 'vod' | 'clip' | 'unknown'

/** Selectors for a specific Twitch page type. */
export interface PageSelectors {
  CHAT_CONTAINER: string
  CHAT_MESSAGE: string
  CHAT_MESSAGE_BODY: string
  CHAT_USERNAME: string
}

const CHANNEL_SELECTORS: PageSelectors = {
  CHAT_CONTAINER,
  CHAT_MESSAGE,
  CHAT_MESSAGE_BODY,
  CHAT_USERNAME,
}

const POPOUT_SELECTORS: PageSelectors = {
  CHAT_CONTAINER: '.chat-scrollable-area__message-container',
  CHAT_MESSAGE,
  CHAT_MESSAGE_BODY,
  CHAT_USERNAME,
}

const SELECTOR_MAP: Record<PageType, PageSelectors> = {
  channel: CHANNEL_SELECTORS,
  popout: POPOUT_SELECTORS,
  vod: CHANNEL_SELECTORS,
  clip: CHANNEL_SELECTORS,
  unknown: CHANNEL_SELECTORS,
}

/** Detect which type of Twitch page the URL corresponds to. */
export const detectPageType = (url: string): PageType => {
  try {
    const { hostname, pathname } = new URL(url)

    // Only handle twitch.tv domains (including clips.twitch.tv)
    if (!hostname.endsWith('.twitch.tv') && hostname !== 'twitch.tv') {
      return 'unknown'
    }

    // clips have their own subdomain
    if (hostname === 'clips.twitch.tv') return 'clip'

    if (pathname.startsWith('/popout/')) return 'popout'
    if (pathname.startsWith('/videos/')) return 'vod'
    if (pathname.startsWith('/directory/')) return 'channel'
    if (pathname.startsWith('/clip/')) return 'clip'

    // Single segment pathname is a channel page
    const segments = pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (segments.length === 0 || segments.length === 1) return 'channel'

    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Get the appropriate selectors for the given page type. */
export const getSelectorsForPage = (pageType: PageType): PageSelectors =>
  SELECTOR_MAP[pageType]
