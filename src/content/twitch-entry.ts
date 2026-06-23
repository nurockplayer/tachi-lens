import { TwitchMessageHandler, type MessageFilter } from './twitch-handler'
import { CHAT_CONTAINER, CHAT_MESSAGE, ATTR_PROCESSED } from './twitch-selectors'

const handler = new TwitchMessageHandler()

const observeChat = (): void => {
  const container = document.querySelector(CHAT_CONTAINER)

  if (!container) {
    setTimeout(observeChat, 500)
    return
  }

  const config: MutationObserverInit = {
    childList: true,
    subtree: true,
  }

  const observer = new MutationObserver((mutations) => {
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

  observer.observe(container, config)

  // Process any existing messages on load
  retryUnprocessed()
}

const getFilter = async (): Promise<MessageFilter> => {
  const items = await chrome.storage.local.get('userSettings')
  const settings = items.userSettings as Record<string, unknown> | undefined

  return {
    botNameBlacklist: (settings?.botNameBlacklist as string[]) ?? [],
    minTextLength: (settings?.minTextLength as number) ?? 2,
  }
}

const processedInFlight = new Set<string>()

const processMessage = async (element: HTMLElement): Promise<void> => {
  const key = `el-${Math.random()}`

  if (processedInFlight.has(key)) return

  processedInFlight.add(key)

  try {
    const filter = await getFilter()
    await handler.translateAndInject(element, filter)
  } finally {
    processedInFlight.delete(key)
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
