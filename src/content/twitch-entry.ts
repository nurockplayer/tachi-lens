import { isSettingsUpdateMessage } from '@/shared/messages'
import type { DiagnosticEvent, DiagnosticStage, SettingsUpdatePayload } from '@/shared/messages'
import {
  parseChannelFromPathname,
  TwitchMessageHandler,
  type ContentSettings,
  type RuntimeMessageSender,
} from './twitch-handler'
import { isExtensionContextInvalidatedError, safeRuntimeSendMessage } from './runtime-messaging'
import {
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

let diagnosticCounter = 0
let lastContainerDiagnostic: DiagnosticStage | undefined
let lastTranslationFailureFingerprint: string | undefined
let lastTranslationFailureAt = 0
let stopped = false

const runtimePort = {
  sendMessage: (message: unknown): Promise<unknown> => chrome.runtime.sendMessage(message),
}

const runtimeMessageSender: RuntimeMessageSender = <T>(message: unknown) =>
  safeRuntimeSendMessage<T>(runtimePort, message, stopContentScript)

export const reportDiagnostic = (stage: DiagnosticStage, detail?: string): void => {
  if (stopped) return

  const timestamp = Date.now()

  if (stage === 'translation_failed') {
    const fingerprint = detail ?? ''

    if (
      fingerprint === lastTranslationFailureFingerprint
      && timestamp - lastTranslationFailureAt < 1_000
    ) {
      return
    }

    lastTranslationFailureFingerprint = fingerprint
    lastTranslationFailureAt = timestamp
  }

  const payload: DiagnosticEvent = {
    id: `diagnostic-${timestamp}-${diagnosticCounter++}`,
    stage,
    timestamp,
    ...(detail ? { detail } : {}),
  }

  void runtimeMessageSender<void>({ type: 'diagnostic_event', payload }).catch((error: unknown) => {
    console.error('[tachi-lens] diagnostic runtime message failed', error)
  })
}

let handler = new TwitchMessageHandler(undefined, reportDiagnostic, runtimeMessageSender)
let currentSelectors: PageSelectors = getSelectorsForPage('channel')

let chatObserver: MutationObserver | null = null
let observeRetryTimer: ReturnType<typeof setTimeout> | null = null

// --- SPA navigation via popstate ---
const onLocationChange = (): void => {
  if (stopped) return
  cleanup()
  observeChat()
}

let popstateAttached = false
let originalPushState: History['pushState'] | null = null
let originalReplaceState: History['replaceState'] | null = null
let wrappedPushState: History['pushState'] | null = null
let wrappedReplaceState: History['replaceState'] | null = null

const attachPopstateListener = (): void => {
  if (stopped || popstateAttached) return
  window.addEventListener('popstate', onLocationChange)
  originalPushState = history.pushState
  originalReplaceState = history.replaceState

  wrappedPushState = (...args) => {
    originalPushState!.apply(history, args)
    onLocationChange()
  }
  wrappedReplaceState = (...args) => {
    originalReplaceState!.apply(history, args)
    onLocationChange()
  }
  history.pushState = wrappedPushState
  history.replaceState = wrappedReplaceState
  popstateAttached = true
}

const detachPageListeners = (): void => {
  if (!popstateAttached) return

  window.removeEventListener('popstate', onLocationChange)
  if (originalPushState && history.pushState === wrappedPushState) {
    history.pushState = originalPushState
  }
  if (originalReplaceState && history.replaceState === wrappedReplaceState) {
    history.replaceState = originalReplaceState
  }

  originalPushState = null
  originalReplaceState = null
  wrappedPushState = null
  wrappedReplaceState = null
  popstateAttached = false
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
    targetLanguage: typeof merged.targetLanguage === 'string' ? merged.targetLanguage : undefined,
    filterConfig,
  }

  return cachedSettings!
}

// --- Timer-driven retry for rate-limited messages ---
let retryTimer: ReturnType<typeof setInterval> | null = null

const startRetryTimer = (): void => {
  if (stopped || retryTimer !== null) return
  retryTimer = setInterval(() => {
    if (!stopped) retryUnprocessed()
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
  if (stopped) return
  invalidateSettingsCache()
  const pageType = detectPageType(window.location.href)
  currentSelectors = getSelectorsForPage(pageType)
  handler = new TwitchMessageHandler(currentSelectors, reportDiagnostic, runtimeMessageSender)
}

// --- CS debounce — fixed-window coalescing ---
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const pendingMessages = new Map<string, HTMLElement>()
const queuedElements = new WeakSet<HTMLElement>()
let pendingIdCounter = 0
const DEBOUNCE_MS = 300
const MAX_PENDING = 50

const debugLog = (msg: string, ...args: unknown[]): void => {
  console.debug('[tachi-lens]', msg, ...args)
}

const flushPending = (): void => {
  debounceTimer = null
  if (stopped) {
    pendingMessages.clear()
    return
  }

  const count = pendingMessages.size
  debugLog('flushPending: processing', { count })
  for (const [, el] of pendingMessages) {
    queuedElements.delete(el)
    if (el.isConnected && !handler.isAlreadyProcessed(el)) {
      enqueueTranslation(el)
    }
  }
  pendingMessages.clear()
}

const scheduleProcess = (element: HTMLElement): void => {
  if (stopped) return

  // Use WeakSet to dedupe by element identity, not text content
  if (queuedElements.has(element)) return
  queuedElements.add(element)
  reportDiagnostic('message_detected')
  if (stopped) return

  pendingMessages.set(`msg-${pendingIdCounter++}`, element)

  if (pendingMessages.size >= MAX_PENDING) {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    flushPending()
    return
  }

  if (!debounceTimer) {
    debounceTimer = setTimeout(flushPending, DEBOUNCE_MS)
  }
}

// --- Observation ---
const observeChat = (): void => {
  if (stopped) return

  setupPage()
  if (stopped) return
  debugLog('observeChat: starting, pageType:', detectPageType(window.location.href))

  const container = queryFirst(document, currentSelectors.CHAT_CONTAINER)

  if (!container) {
    if (lastContainerDiagnostic !== 'chat_container_missing') {
      reportDiagnostic('chat_container_missing', '找不到 Twitch 聊天室容器')
      lastContainerDiagnostic = 'chat_container_missing'
    }
    if (stopped) return

    debugLog('observeChat: container not found, retrying in 500ms')
    stopRetryTimer()
    observeRetryTimer = setTimeout(() => {
      observeRetryTimer = null
      observeChat()
    }, 500)
    return
  }

  debugLog('observeChat: container found')
  if (lastContainerDiagnostic !== 'chat_container_ready') {
    reportDiagnostic('chat_container_ready')
    lastContainerDiagnostic = 'chat_container_ready'
  }
  if (stopped) return

  startRetryTimer()

  const config: MutationObserverInit = {
    childList: true,
    subtree: true,
  }

  chatObserver = new MutationObserver((mutations) => {
    if (stopped) return

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            const message = matchesFirst(node, currentSelectors.CHAT_MESSAGE)
              ? node
              : node.closest(currentSelectors.CHAT_MESSAGE) ?? queryFirst(node, currentSelectors.CHAT_MESSAGE)

            if (message instanceof HTMLElement && !handler.isAlreadyProcessed(message)) {
              scheduleProcess(message)
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
const queuedForTranslation = new WeakSet<HTMLElement>()
const translationQueue: HTMLElement[] = []
const MAX_CONCURRENT_TRANSLATIONS = 10
let activeTranslations = 0
let retryNotBefore = 0

const enqueueTranslation = (element: HTMLElement): void => {
  if (stopped || inFlight.has(element) || queuedForTranslation.has(element)) return

  queuedForTranslation.add(element)
  translationQueue.push(element)
  drainTranslationQueue()
}

const drainTranslationQueue = (): void => {
  if (stopped || Date.now() < retryNotBefore) return

  while (activeTranslations < MAX_CONCURRENT_TRANSLATIONS && translationQueue.length > 0) {
    const element = translationQueue.shift()!
    queuedForTranslation.delete(element)

    if (!element.isConnected || handler.isAlreadyProcessed(element)) continue

    activeTranslations++
    void processMessage(element)
      .then((result) => {
        if (result.retryAfterMs !== undefined) {
          retryNotBefore = Math.max(retryNotBefore, Date.now() + result.retryAfterMs)
        }
      })
      .finally(() => {
        activeTranslations--
        drainTranslationQueue()
      })
  }
}

const processMessage = async (element: HTMLElement): Promise<{ retryAfterMs?: number }> => {
  if (stopped) return {}

  if (inFlight.has(element)) {
    debugLog('processMessage: already in flight')
    return {}
  }
  inFlight.add(element)

  try {
    const settings = await getContentSettings()
    if (stopped) return {}

    return await handler.translateAndInject(element, settings)
  } catch {
    if (stopped) return {}

    debugLog('processMessage: error', { text: element.textContent?.slice(0, 50) })
    reportDiagnostic('translation_failed', '無法讀取目前的翻譯設定')
    return {}
  } finally {
    inFlight.delete(element)
  }
}

const retryUnprocessed = (): void => {
  if (stopped || Date.now() < retryNotBefore) return

  drainTranslationQueue()

  const container = queryFirst(document, currentSelectors.CHAT_CONTAINER)
  if (!container) return

  const messages = queryFirstAll(container, currentSelectors.CHAT_MESSAGE)
  let retryCount = 0

  for (const node of messages) {
    if (node instanceof HTMLElement &&
      !handler.isAlreadyProcessed(node)) {
      retryCount++
      enqueueTranslation(node)
    }
  }

  if (retryCount > 0) {
    debugLog('retryUnprocessed: found', { count: retryCount })
  }
}

// --- Cleanup ---
const cleanup = (): void => {
  if (chatObserver) {
    chatObserver.disconnect()
    chatObserver = null
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (observeRetryTimer !== null) {
    clearTimeout(observeRetryTimer)
    observeRetryTimer = null
  }
  stopRetryTimer()
  invalidateSettingsCache()
  pendingMessages.clear()
  translationQueue.length = 0
}

let runtimeMessageListenerAttached = false

const onRuntimeMessage = (message: unknown): void => {
  if (stopped) return
  if (isSettingsUpdateMessage(message)) {
    void handleSettingsUpdate(message.payload)
  }
}

const detachRuntimeMessageListener = (): void => {
  if (!runtimeMessageListenerAttached) return

  try {
    chrome.runtime.onMessage.removeListener(onRuntimeMessage)
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      console.error('[tachi-lens] failed to remove runtime listener', error)
    }
  }
  runtimeMessageListenerAttached = false
}

export const stopContentScript = (): void => {
  if (stopped) return

  stopped = true
  cleanup()
  detachPageListeners()
  detachRuntimeMessageListener()
}

// --- Exports (for testing) ---
export const getSettings = async (channelName?: string): Promise<RemoteContentSettings> => {
  if (stopped) {
    throw new Error('Content script has stopped')
  }

  const runtimeResult = await runtimeMessageSender<{
    type?: string
    payload?: RemoteContentSettings & { error?: unknown }
  }>({
    type: 'get_content_settings',
    payload: { channelName },
  } as const)

  if (runtimeResult.kind === 'context_invalidated') {
    throw new Error('Content script has stopped')
  }

  const response = runtimeResult.value

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
  if (stopped) return
  invalidateSettingsCache()
}

// --- Main ---
const main = (): void => {
  console.info('tachi-lens content script loaded')
  if (stopped) return

  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage)
    runtimeMessageListenerAttached = true
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      stopContentScript()
      return
    }
    throw error
  }

  observeChat()
}

main()
