import { TwitchMessageHandler, type ContentSettings } from './twitch-handler'
import { CHAT_CONTAINER, CHAT_MESSAGE, ATTR_PROCESSED } from './twitch-selectors'

const handler = new TwitchMessageHandler()

let chatObserver: MutationObserver | null = null

const observeChat = (): void => {
  const container = document.querySelector(CHAT_CONTAINER)

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
            node.matches(CHAT_MESSAGE) &&
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
    if (!document.body.contains(container) || !document.querySelector(CHAT_CONTAINER)) {
      bodyObserver.disconnect()
      observeChat()
    }
  })

  bodyObserver.observe(document.body, { childList: true, subtree: true })

  // Process any existing messages on load
  retryUnprocessed()
}

const getContentSettings = async (): Promise<ContentSettings> => {
  const items = await chrome.storage.local.get('userSettings')
  const settings = items.userSettings as Record<string, unknown> | undefined

  return {
    botNameBlacklist: (settings?.botNameBlacklist as string[]) ?? [],
    minTextLength: (settings?.minTextLength as number) ?? 2,
    displayMode: (settings?.displayMode as ContentSettings['displayMode']) ?? 'below',
    translationEnabled: (settings?.translationEnabled as boolean) ?? true,
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
  const container = document.querySelector(CHAT_CONTAINER)

  if (!container) return

  const messages = container.querySelectorAll<HTMLElement>(
    `${CHAT_MESSAGE}:not([${ATTR_PROCESSED}])`,
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
