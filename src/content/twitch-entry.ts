import {
  isSettingsUpdateMessage,
  isSpeechCaptionClearedMessage,
  isSpeechCaptionMessage,
  isSpeechSettingsUpdateMessage,
  isSpeechStateMessage,
} from '@/shared/messages'
import type { DiagnosticEvent, DiagnosticStage, SettingsUpdatePayload, SpeechStatePayload } from '@/shared/messages'
import type { ChineseVariantMode } from '@/shared/language-detection'
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
import { SubtitleOverlay } from './subtitle-overlay'

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
    ...(stage !== 'translation_failed' && detail ? { detail } : {}),
  }

  void runtimeMessageSender<void>({ type: 'diagnostic_event', payload }).catch((error: unknown) => {
    console.error('[tachi-lens] diagnostic runtime message failed', error)
  })
}

/**
 * Counter-style stages emitted for queue/dedup backpressure. One call per
 * drop/removal; the event carries only the stage — never chat text, usernames,
 * channel names, provider bodies, or translation output. The Service Worker
 * aggregates these into a single bounded counter event, so per-drop traffic is
 * never persisted individually nor broadcast to the Popup (#60).
 */
export const reportDiagnosticCount = (stage: DiagnosticStage): void => {
  if (stopped) return

  const timestamp = Date.now()
  const payload: DiagnosticEvent = {
    id: `diagnostic-${timestamp}-${diagnosticCounter++}`,
    stage,
    timestamp,
  }

  void runtimeMessageSender<void>({ type: 'diagnostic_event', payload }).catch((error: unknown) => {
    console.error('[tachi-lens] diagnostic runtime message failed', error)
  })
}

let handler = new TwitchMessageHandler(undefined, reportDiagnostic, runtimeMessageSender)
let currentSelectors: PageSelectors = getSelectorsForPage('channel')

let chatObserver: MutationObserver | null = null
let observeRetryTimer: ReturnType<typeof setTimeout> | null = null

// --- v0.3 speech subtitle overlay (Spec §6/§10) -----------------------------
//
// The overlay is a shadow-root host appended to document.body; it never
// mutates Twitch nodes. `speech_state`/`speech_caption`/`speech_caption_cleared`
// are SW → CS broadcasts handled here; `speech_control {action:'toggle'}` is
// sent CS → SW on the overlay's collapse-handle/user action.
let subtitleOverlay: SubtitleOverlay | null = null
// Last partial speech config broadcast. Retained so an overlay created after a
// speech_settings_updated (e.g. a fresh SPA nav) still honors the user's
// captionMaxLines/captionOpacity instead of falling back to defaults.
let pendingSpeechConfig: { captionMaxLines?: number; captionOpacity?: number } | null = null

const ensureSubtitleOverlay = (): SubtitleOverlay => {
  if (subtitleOverlay === null) {
    subtitleOverlay = new SubtitleOverlay({
      onToggle: () => {
        void safeRuntimeSendMessage<void>(runtimePort, {
          type: 'speech_control',
          payload: { action: 'toggle' },
        }, stopContentScript).catch((error: unknown) => {
          console.error('[tachi-lens] speech_control runtime message failed', error)
        })
      },
    })
    if (pendingSpeechConfig !== null) {
      subtitleOverlay.setSpeechConfig(pendingSpeechConfig)
    }
  }
  return subtitleOverlay
}

const handleSpeechState = (payload: SpeechStatePayload): void => {
  if (!isSpeechStateMessage({ type: 'speech_state', payload })) return
  if (payload.state === 'idle') {
    subtitleOverlay?.destroy()
    return
  }
  ensureSubtitleOverlay().setState(payload)
}

const handleSpeechCaption = (payload: { id: string; text: string; interim: boolean; lang?: string }): void => {
  if (!isSpeechCaptionMessage({ type: 'speech_caption', payload })) return
  ensureSubtitleOverlay().setCaption(payload)
}

const handleSpeechCaptionCleared = (payload: { reason: 'idle' | 'silence' | 'disabled' }): void => {
  if (!isSpeechCaptionClearedMessage({ type: 'speech_caption_cleared', payload })) return
  subtitleOverlay?.clearCaptions(payload.reason)
}

const handleSpeechSettingsUpdate = (payload: { captionMaxLines?: number; captionOpacity?: number }): void => {
  if (!isSpeechSettingsUpdateMessage({ type: 'speech_settings_updated', payload })) return
  pendingSpeechConfig = {
    ...(pendingSpeechConfig ?? {}),
    ...(payload.captionMaxLines === undefined ? {} : { captionMaxLines: payload.captionMaxLines }),
    ...(payload.captionOpacity === undefined ? {} : { captionOpacity: payload.captionOpacity }),
  }
  subtitleOverlay?.setSpeechConfig(payload)
}

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
    chineseVariantMode: isChineseVariantMode(merged.chineseVariantMode) ? merged.chineseVariantMode : 'skip_all_chinese',
    filterConfig,
  }

  return cachedSettings!
}

const isChineseVariantMode = (value: unknown): value is ChineseVariantMode =>
  value === 'skip_all_chinese' || value === 'translate_other_script'

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
let queuedElements = new WeakSet<HTMLElement>()
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
      enqueueTranslation(el, 'live')
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
              const messages: Element[] = []
              if (matchesFirst(node, currentSelectors.CHAT_MESSAGE)) {
                messages.push(node)
              } else {
                let ancestor = node.parentElement
                while (ancestor && ancestor !== container) {
                  if (matchesFirst(ancestor, currentSelectors.CHAT_MESSAGE)) {
                    messages.push(ancestor)
                    break
                  }
                  ancestor = ancestor.parentElement
                }

                if (messages.length === 0) {
                  messages.push(...queryFirstAll(node, currentSelectors.CHAT_MESSAGE))
                }
              }

              for (const message of messages) {
                if (message instanceof HTMLElement && !handler.isAlreadyProcessed(message)) {
                  scheduleProcess(message)
                }
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
type TranslationPriority = 'live' | 'backlog'
interface QueuedTranslation {
  element: HTMLElement
  priority: TranslationPriority
}

const translationQueue: QueuedTranslation[] = []
const MAX_CONCURRENT_TRANSLATIONS = 10
const MAX_CONSECUTIVE_LIVE = 3
/**
 * Upper bound on pending translation work queued in the Content Script.
 *
 * Enforced on every enqueue. When capacity is exceeded, obsolete entries
 * (elements no longer connected, or already processed) are removed first;
 * if still over capacity, the oldest remaining entry is dropped so newer,
 * still-relevant messages win. The value comfortably holds one full debounce
 * flush (MAX_PENDING = 50) plus headroom while draining is paused by a
 * provider cooldown, so normal bursts are not trimmed.
 */
const MAX_QUEUED_TRANSLATIONS = 60
let activeTranslations = 0
let retryNotBefore = 0
let consecutiveLiveDequeues = 0
// _test hook: record dispatched items. Set before drainTranslationQueue.
let _dispatchRecorder: ((element: HTMLElement, priority: TranslationPriority) => void) | undefined

const isObsolete = (entry: QueuedTranslation): boolean =>
  !entry.element.isConnected || handler.isAlreadyProcessed(entry.element)

/**
 * Enforce MAX_QUEUED_TRANSLATIONS after an enqueue (the only insertion point).
 *
 * Runs even while draining is paused by a provider cooldown, so pending work
 * cannot grow without bound. Obsolete entries (disconnected or already
 * processed) are removed first; if still over capacity, the oldest remaining
 * entry is dropped so newer, still-relevant work is not starved by stale
 * queued messages. Every dropped entry releases its WeakSet bookkeeping and
 * never creates a Promise, timer, retry marker, or in-flight slot.
 */
const trimTranslationQueue = (): void => {
  const firstObsolete = translationQueue.findIndex(isObsolete)
  if (firstObsolete >= 0) {
    for (let index = translationQueue.length - 1; index >= 0; index--) {
      if (isObsolete(translationQueue[index]!)) {
        queuedForTranslation.delete(translationQueue[index]!.element)
        translationQueue.splice(index, 1)
        reportDiagnosticCount('queue_obsolete_drop')
      }
    }
  }

  while (translationQueue.length > MAX_QUEUED_TRANSLATIONS) {
    const dropped = translationQueue.shift()!
    queuedForTranslation.delete(dropped.element)
    reportDiagnosticCount('queue_overflow_drop')
  }
}

const enqueueTranslation = (
  element: HTMLElement,
  priority: TranslationPriority = 'live',
): void => {
  if (stopped || inFlight.has(element) || queuedForTranslation.has(element)) return

  queuedForTranslation.add(element)
  const queued = { element, priority }
  const firstBacklogIndex = priority === 'live'
    ? translationQueue.findIndex((entry) => entry.priority === 'backlog')
    : -1
  if (firstBacklogIndex >= 0) translationQueue.splice(firstBacklogIndex, 0, queued)
  else translationQueue.push(queued)
  trimTranslationQueue()
  drainTranslationQueue()
}

const drainTranslationQueue = (): void => {
  if (stopped || Date.now() < retryNotBefore) return

  while (activeTranslations < MAX_CONCURRENT_TRANSLATIONS && translationQueue.length > 0) {
    const hasBacklog = translationQueue.some((entry) => entry.priority === 'backlog')

    let element: HTMLElement
    let priority: TranslationPriority

    // After MAX_CONSECUTIVE_LIVE consecutive live dequeues while
    // backlog is queued, force-dispatch the earliest backlog.
    if (consecutiveLiveDequeues >= MAX_CONSECUTIVE_LIVE && hasBacklog) {
      const index = translationQueue.findIndex((entry) => entry.priority === 'backlog')
      const spliced = translationQueue.splice(index, 1)[0]!
      element = spliced.element
      priority = spliced.priority
    } else {
      const spliced = translationQueue.shift()!
      element = spliced.element
      priority = spliced.priority
    }

    queuedForTranslation.delete(element)

    if (!element.isConnected || handler.isAlreadyProcessed(element)) {
      reportDiagnosticCount('queue_obsolete_drop')
      continue
    }

    _dispatchRecorder?.(element, priority)
    activeTranslations++
    if (hasBacklog && priority === 'live') consecutiveLiveDequeues++
    else consecutiveLiveDequeues = 0
    void processMessage(element, priority)
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

const processMessage = async (
  element: HTMLElement,
  priority: TranslationPriority = 'live',
): Promise<{ retryAfterMs?: number }> => {
  if (stopped) return {}

  if (inFlight.has(element)) {
    debugLog('processMessage: already in flight')
    return {}
  }
  inFlight.add(element)

  try {
    const settings = await getContentSettings()
    if (stopped) return {}

    return await handler.translateAndInject(element, settings, priority)
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
      !handler.isAlreadyProcessed(node) &&
      !queuedElements.has(node)) {
      retryCount++
      enqueueTranslation(node, 'backlog')
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
  queuedElements = new WeakSet()
  translationQueue.length = 0
  // Speech overlay: destroy the host (never leaves a stale overlay on the page).
  subtitleOverlay?.destroy()
  subtitleOverlay = null
  pendingSpeechConfig = null
}

let runtimeMessageListenerAttached = false

const onRuntimeMessage = (message: unknown): void => {
  if (stopped) return
  if (isSpeechStateMessage(message)) {
    handleSpeechState(message.payload)
    return
  }
  if (isSpeechCaptionMessage(message)) {
    handleSpeechCaption(message.payload)
    return
  }
  if (isSpeechCaptionClearedMessage(message)) {
    handleSpeechCaptionCleared(message.payload)
    return
  }
  if (isSpeechSettingsUpdateMessage(message)) {
    handleSpeechSettingsUpdate(message.payload)
    return
  }
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
export const _test = {
  enqueueTranslation,
  drainTranslationQueue,
  get translationQueueLength(): number { return translationQueue.length },
  get translationQueueSnapshot(): Array<{ text: string; isConnected: boolean }> {
    return translationQueue.map((entry) => ({
      text: entry.element.textContent ?? '',
      isConnected: entry.element.isConnected,
    }))
  },
  get consecutiveLiveDequeues(): number { return consecutiveLiveDequeues },
  set consecutiveLiveDequeues(value: number) { consecutiveLiveDequeues = value },
  get activeTranslations(): number { return activeTranslations },
  set activeTranslations(value: number) { activeTranslations = value },
  get MAX_CONCURRENT(): number { return MAX_CONCURRENT_TRANSLATIONS },
  get MAX_QUEUED(): number { return MAX_QUEUED_TRANSLATIONS },
  get resolvedContentSettings(): ContentSettings | null { return cachedSettings },
  set onDispatch(fn: ((el: HTMLElement, priority: TranslationPriority) => void) | undefined) { _dispatchRecorder = fn },
}
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
