import { isSettingsUpdateMessage } from '@/shared/messages'
import type { SettingsUpdatePayload } from '@/shared/messages'
import { parseChannelFromPathname, TwitchMessageHandler, type ContentSettings } from './twitch-handler'
import {
  ATTR_PROCESSED,
  detectPageType,
  getSelectorsForPage,
  matchesFirst,
  queryFirst,
  queryFirstAll,
  type PageSelectors,
} from './twitch-selectors'
import { DEFAULT_FILTER_CONFIG, FILTER_CONFIG_KEYS } from './message-filter'

type RemoteContentSettings = Partial<Omit<ContentSettings, 'filterConfig'>> & {
  filterConfig?: Partial<ContentSettings['filterConfig']>
} & Partial<Record<(typeof FILTER_CONFIG_KEYS)[number], boolean>>

let handler = new TwitchMessageHandler()
let currentSelectors: PageSelectors = getSelectorsForPage('channel')

let chatObserver: MutationObserver | null = null
let observeRetryTimer: ReturnType<typeof setTimeout> | null = null

// --- SPA navigation via popstate ---
const onLocationChange = (): void => {
  cleanup()
  observeChat()
}

let popstateAttached = false

const attachPopstateListener = (): void => {
  if (popstateAttached) return
  window.addEventListener('popstate', onLocationChange)
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

  const channelName = parseChannelFromPathname(window.location.pathname)
  const merged = await getSettings(channelName)

  // Build filter config from settings (with defaults for any missing keys)
  const filterConfig = { ...DEFAULT_FILTER_CONFIG, ...merged.filterConfig }
  for (const key of FILTER_CONFIG_KEYS) {
    const val = merged[key]
    if (typeof val === 'boolean') {
      filterConfig[key] = val
    }
  }

  cachedSettings = {
    botNameBlacklist: Array.isArray(merged.botNameBlacklist) ? merged.botNameBlacklist : [],
    minTextLength: typeof merged.minTextLength === 'number' ? merged.minTextLength : 2,
    displayMode: isDisplayMode(merged.displayMode) ? merged.displayMode : 'below',
    translationEnabled: typeof merged.translationEnabled === 'boolean' ? merged.translationEnabled : true,
    filterConfig,
  }

  return cachedSettings!
}

// --- Timer-driven retry for rate-limited messages ---
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

// --- CS debounce — fixed-window coalescing ---
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const pendingMessages = new Map<string, HTMLElement>()
const DEBOUNCE_MS = 300
const MAX_PENDING = 50

const flushPending = (): void => {
  debounceTimer = null
  for (const [, el] of pendingMessages) {
    if (el.isConnected && !el.hasAttribute(ATTR_PROCESSED)) {
      void processMessage(el)
    }
  }
  pendingMessages.clear()
}

const scheduleProcess = (element: HTMLElement): void => {
  // Use a stable key per element to dedupe rapid mutations on the same node
  const key = element.getAttribute('data-test-selector') ?? element.textContent ?? ''
  pendingMessages.set(key, element)

  if (pendingMessages.size >= MAX_PENDING) {
    if (debounceTimer) clearTimeout(debounceTimer)
    flushPending()
    return
  }

  if (!debounceTimer) {
    debounceTimer = setTimeout(flushPending, DEBOUNCE_MS)
  }
}

// --- Observation ---
const observeChat = (): void => {
  setupPage()

  const container = queryFirst(document, currentSelectors.CHAT_CONTAINER)

  if (!container) {
    stopRetryTimer()
    observeRetryTimer = setTimeout(observeChat, 500)
    return
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
          if (node instanceof HTMLElement) {
            if (matchesFirst(node, currentSelectors.CHAT_MESSAGE) && !node.hasAttribute(ATTR_PROCESSED)) {
              scheduleProcess(node)
              continue
            }
            const inner = node.querySelector(currentSelectors.CHAT_MESSAGE)
            if (inner instanceof HTMLElement && !inner.hasAttribute(ATTR_PROCESSED)) {
              scheduleProcess(inner)
            }
          }
        }
      }
    }
  })

  chatObserver.observe(container, config)
  attachPopstateListener()
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
    // Runtime/settings failures are transient; leave the message retryable.
  } finally {
    inFlight.delete(element)
  }
}

const retryUnprocessed = (): void => {
  const container = queryFirst(document, currentSelectors.CHAT_CONTAINER)
  if (!container) return

  const messages = queryFirstAll(container, currentSelectors.CHAT_MESSAGE)

  for (const node of messages) {
    if (node instanceof HTMLElement && !node.hasAttribute(ATTR_PROCESSED)) {
      void processMessage(node)
    }
  }
}

// --- Cleanup ---
const cleanup = (): void => {
  if (chatObserver) {
    chatObserver.disconnect()
    chatObserver = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (observeRetryTimer) {
    clearTimeout(observeRetryTimer)
    observeRetryTimer = null
  }
  stopRetryTimer()
  invalidateSettingsCache()
  pendingMessages.clear()
}

// --- Exports (for testing) ---
export const getSettings = async (channelName?: string): Promise<RemoteContentSettings> => {
  const response = (await chrome.runtime.sendMessage({
    type: 'get_content_settings',
    payload: { channelName },
  } as const)) as { type?: string; payload?: RemoteContentSettings & { error?: unknown } } | undefined

  if (response?.type !== 'content_settings' || !response.payload || typeof response.payload !== 'object') {
    throw new Error('Content settings response missing payload')
  }

  if (typeof response.payload.error === 'string') {
    throw new Error(response.payload.error)
  }

  return response.payload
}

const isDisplayMode = (value: unknown): value is ContentSettings['displayMode'] =>
  value === 'below' || value === 'hover' || value === 'collapse'

export const handleSettingsUpdate = async (_payload: SettingsUpdatePayload): Promise<void> => {
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
