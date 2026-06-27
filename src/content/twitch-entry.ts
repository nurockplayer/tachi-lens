import { getChannelSettings, getUserSettings, mergeSettings } from '@/storage/settings'
import { isSettingsUpdateMessage } from '@/shared/messages'
import type { SettingsUpdatePayload } from '@/shared/messages'
import { parseChannelFromPathname, TwitchMessageHandler, type ContentSettings } from './twitch-handler'
import {
  ATTR_PROCESSED,
  detectPageType,
  getSelectorsForPage,
  type PageSelectors,
} from './twitch-selectors'

let handler = new TwitchMessageHandler()
let currentSelectors: PageSelectors = getSelectorsForPage('channel')

let chatObserver: MutationObserver | null = null
let bodyObserver: MutationObserver | null = null

// --- SPA navigation via popstate ---
const onLocationChange = (): void => {
  cleanup()
  observeChat()
}

let popstateAttached = false

const attachPopstateListener = (): void => {
  if (popstateAttached) return
  window.addEventListener('popstate', onLocationChange)
  // Monkey-patch pushState/replaceState to detect SPA navigation
  const origPushState = history.pushState.bind(history)
  const origReplaceState = history.replaceState.bind(history)

  history.pushState = (...args) => {
    origPushState(...args)
    onLocationChange()
  }
  history.replaceState = (...args) => {
    origReplaceState(...args)
    onLocationChange()
  }
  popstateAttached = true
}

// --- Settings cache ---
let cachedSettings: ContentSettings | null = null

const invalidateSettingsCache = (): void => {
  cachedSettings = null
}

const getContentSettings = async (forceRefresh = false): Promise<ContentSettings> => {
  if (cachedSettings && !forceRefresh) return cachedSettings

  const global = await getUserSettings()
  const channelName = parseChannelFromPathname(window.location.pathname)

  let merged: typeof global

  if (channelName) {
    const channel = await getChannelSettings(channelName)
    merged = channel ? mergeSettings(global, channel) : global
  } else {
    merged = global
  }

  cachedSettings = {
    botNameBlacklist: merged.botNameBlacklist,
    minTextLength: merged.minTextLength,
    displayMode: merged.displayMode,
    translationEnabled: merged.translationEnabled,
  }

  return cachedSettings!
}

// --- Timer-driven retry for rate-limited / errored messages ---
let retryTimer: ReturnType<typeof setInterval> | null = null

const startRetryTimer = (): void => {
  if (retryTimer) return

  retryTimer = setInterval(() => {
    void retryUnprocessed()
  }, 5_000)
}

const stopRetryTimer = (): void => {
  if (retryTimer !== null) {
    clearInterval(retryTimer)
    retryTimer = null
  }
}

// --- Page setup ---

const setupPage = (): void => {
  invalidateSettingsCache()
  const pageType = detectPageType(window.location.href)
  currentSelectors = getSelectorsForPage(pageType)
  handler = new TwitchMessageHandler(currentSelectors)
}

// --- Observation ---

const observeChat = (): void => {
  setupPage()

  const container = document.querySelector(currentSelectors.CHAT_CONTAINER)

  if (!container) {
    setTimeout(observeChat, 500)
    return
  }

  if (chatObserver) {
    chatObserver.disconnect()
    chatObserver = null
  }

  startRetryTimer()

  const config: MutationObserverInit = {
    childList: true,
    subtree: true,
  }

  chatObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (
            node instanceof HTMLElement &&
            node.matches(currentSelectors.CHAT_MESSAGE) &&
            !node.hasAttribute(ATTR_PROCESSED)
          ) {
            void processMessage(node)
          }
        }
      }
    }
  })

  chatObserver.observe(container, config)

  // SPA navigation detection via history API
  attachPopstateListener()

  // Process any existing messages on load
  void retryUnprocessed()
}

// --- Processing ---

const inFlight = new WeakSet<HTMLElement>()

const processMessage = async (element: HTMLElement): Promise<void> => {
  if (inFlight.has(element)) return

  inFlight.add(element)

  try {
    const settings = await getContentSettings()
    await handler.translateAndInject(element, settings)
  } catch {
    // Mark as processed to prevent infinite retry on persistent DOM errors
    element.setAttribute(ATTR_PROCESSED, 'true')
  } finally {
    inFlight.delete(element)
  }
}

const retryUnprocessed = (): void => {
  const container = document.querySelector(currentSelectors.CHAT_CONTAINER)

  if (!container) return

  const messages = container.querySelectorAll<HTMLElement>(
    `${currentSelectors.CHAT_MESSAGE}:not([${ATTR_PROCESSED}])`,
  )

  for (const msg of messages) {
    void processMessage(msg)
  }
}

// --- Cleanup ---

const cleanup = (): void => {
  if (chatObserver) {
    chatObserver.disconnect()
    chatObserver = null
  }
  stopRetryTimer()
  invalidateSettingsCache()
}

// --- Exports (for testing) ---

export const getSettings = async (): Promise<Record<string, unknown>> => {
  const items = await chrome.storage.local.get('userSettings')

  return (items.userSettings as Record<string, unknown>) ?? {}
}

export const handleSettingsUpdate = async (payload: SettingsUpdatePayload): Promise<void> => {
  invalidateSettingsCache()
}

// --- Main ---

const main = (): void => {
  console.info('tachi-lens content script loaded')
  observeChat()

  chrome.runtime.onMessage.addListener((message) => {
    if (isSettingsUpdateMessage(message)) {
      void handleSettingsUpdate(message.payload)
    }
  })
}

main()
