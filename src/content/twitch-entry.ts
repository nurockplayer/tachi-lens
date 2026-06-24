import { getChannelSettings, getUserSettings, mergeSettings } from '@/storage/settings'
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

const setupPage = (): void => {
  const pageType = detectPageType(window.location.href)
  currentSelectors = getSelectorsForPage(pageType)
  handler = new TwitchMessageHandler(currentSelectors)
}

const observeChat = (): void => {
  setupPage()

  const container = document.querySelector(currentSelectors.CHAT_CONTAINER)

  if (!container) {
    setTimeout(observeChat, 500)
    return
  }

  // Disconnect previous observer when container is replaced (SPA navigation)
  if (chatObserver) {
    chatObserver.disconnect()
    chatObserver = null
  }

  const config: MutationObserverInit = {
    childList: true,
    subtree: true,
  }

  chatObserver = new MutationObserver((mutations) => {
    let hasNewMessages = false

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (
            node instanceof HTMLElement &&
            node.matches(currentSelectors.CHAT_MESSAGE) &&
            !node.hasAttribute(ATTR_PROCESSED)
          ) {
            hasNewMessages = true
            void processMessage(node)
          }
        }
      }
    }

    // Re-process existing elements that may have been skipped due to rate limiting
    if (!hasNewMessages) {
      retryUnprocessed()
    }
  })

  chatObserver.observe(container, config)

  // Watch for container replacement (Twitch SPA navigation)
  const bodyObserver = new MutationObserver(() => {
    if (!document.body.contains(container) || !document.querySelector(currentSelectors.CHAT_CONTAINER)) {
      bodyObserver.disconnect()
      observeChat()
    }
  })

  bodyObserver.observe(document.body, { childList: true, subtree: true })

  // Process any existing messages on load
  retryUnprocessed()
}

const getContentSettings = async (): Promise<ContentSettings> => {
  const global = await getUserSettings()
  const channelName = parseChannelFromPathname(window.location.pathname)

  if (!channelName) {
    return {
      botNameBlacklist: global.botNameBlacklist,
      minTextLength: global.minTextLength,
      displayMode: global.displayMode,
      translationEnabled: global.translationEnabled,
    }
  }

  const channel = await getChannelSettings(channelName)
  const merged = channel ? mergeSettings(global, channel) : global

  return {
    botNameBlacklist: merged.botNameBlacklist,
    minTextLength: merged.minTextLength,
    displayMode: merged.displayMode,
    translationEnabled: merged.translationEnabled,
  }
}

const inFlight = new WeakSet<HTMLElement>()

const processMessage = async (element: HTMLElement): Promise<void> => {
  if (inFlight.has(element)) return

  inFlight.add(element)

  try {
    const settings = await getContentSettings()
    await handler.translateAndInject(element, settings)
  } catch {
    // Silently ignore — element can be retried on next mutation
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

const main = (): void => {
  console.info('tachi-lens content script loaded')
  observeChat()
}

main()
