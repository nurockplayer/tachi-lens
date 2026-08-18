import { getProvider } from '@/providers/registry'
import type { ProviderId } from '@/providers/types'
import {
  deleteApiKey,
  getApiKeyForServiceWorker,
  getChannelSettings,
  getMaskedApiKeyForPopup,
  getRuntimeState,
  getSpeechApiKeyForServiceWorker,
  getUserSettings,
  initializeStorageAccess,
  mergeSettings,
  saveApiKey,
  saveUserSettings,
} from '@/storage/settings'
import {
  isBaseMessage,
  isDiagnosticEventMessage,
  isGetQuotaHealthMessage,
  isResetQuotaHealthMessage,
  isSpeechControlMessage,
  isSpeechSettingsUpdateMessage,
} from '@/shared/messages'
import type {
  DiagnosticEvent,
  DiagnosticStage,
  SettingsUpdatePayload,
} from '@/shared/messages'
import { getSpeechProvider } from '@/providers/speech-registry'
import type { SpeechErrorReason } from '@/shared/speech-state'
import { TranslationCache } from './cache'
import { createSystemClock } from './clock'
import { createMessageRouter } from './message-router'
import { RateLimiter } from './rate-limiter'
import { createRestartSafeReservationId, GeminiQuotaStore } from './gemini-quota'
import { collectQuotaHealthResults, deriveQuotaHealth } from './quota-health'
import { QuotaScheduler } from './quota-scheduler'
import { SpeechCapture, createSpeechCaptureChrome } from './speech-capture'
import { SpeechBudget, createSpeechBudgetChromeStorage } from './speech-budget'
import { SpeechPipeline } from './speech-pipeline'
import { Translator } from './translator'
import { TranslationCacheDb } from './translation-cache-db'

const ignoreStorageInitializationError = (): void => {}

const initializeTrustedStorageAccess = (): void => {
  void initializeStorageAccess().catch(ignoreStorageInitializationError)
}

initializeTrustedStorageAccess()

const cache = new TranslationCache()
const clock = createSystemClock()
const rateLimiter = new RateLimiter({ maxBackoffMs: 60_000, clock })
// Persistent (L2) IndexedDB cache. Opened lazily on first L1-miss lookup and
// never hydrated at startup; every open/read/write failure falls back to the
// existing L1/provider path inside the Translator.
const persistentCache = new TranslationCacheDb(undefined, clock)
const geminiQuotaStore = new GeminiQuotaStore({
  getSession: async () => {
    const items = await chrome.storage.session.get('geminiQuotaSession')
    return (items.geminiQuotaSession as Record<string, unknown> | undefined) ?? {}
  },
  setSession: async (value) => chrome.storage.session.set({ geminiQuotaSession: value }),
  getLocal: async () => {
    const items = await chrome.storage.local.get('geminiQuotaUsage')
    return (items.geminiQuotaUsage as Record<string, unknown> | undefined) ?? {}
  },
  setLocal: async (value) => chrome.storage.local.set({ geminiQuotaUsage: value }),
}, clock, createRestartSafeReservationId)
const quotaScheduler = new QuotaScheduler(geminiQuotaStore, { clock })

const getEffectiveContentSettings = async (channelName?: string) => {
  const global = await getUserSettings()
  const channel = channelName ? await getChannelSettings(channelName) : undefined

  return channel ? mergeSettings(global, channel) : global
}

const translator = new Translator(
  {
    cache,
    persistentCache,
    rateLimiter,
    getSettings: () => getUserSettings(),
    getTranslationEnabled: async (channelName) =>
      (await getEffectiveContentSettings(channelName)).translationEnabled,
    getApiKey: (providerId: ProviderId) => getApiKeyForServiceWorker(providerId),
    getProvider: (providerId) => getProvider(providerId),
    quotaScheduler,
    // Batch dedup and in-flight coalescing report privacy-safe counter stages
    // into the same bounded diagnostic pipeline used by content-script drops.
    // The callback runs only during flushes (after module init), so referencing
    // `recordDiagnostic` here is safe.
    reportDiagnosticCount: (stage) => {
      recordDiagnostic({ id: `counter-${Date.now()}-${stage}`, stage, timestamp: Date.now() })
    },
  },
  { batchWindowMs: 300, maxBatchSize: 10 },
)

const router = createMessageRouter({
  translator,
  getApiKey: (providerId: ProviderId) => getApiKeyForServiceWorker(providerId),
  getProvider: (providerId) => getProvider(providerId),
  getRuntimeState: () => getRuntimeState(),
  getContentSettings: getEffectiveContentSettings,
  saveApiKey: (providerId, apiKey) => saveApiKey(providerId, apiKey),
  deleteApiKey: (providerId) => deleteApiKey(providerId),
  getMaskedApiKeyForPopup: (providerId) => getMaskedApiKeyForPopup(providerId),
})

const DIAGNOSTIC_STORAGE_KEY = 'translationDiagnostics'
const MAX_DIAGNOSTICS = 20

/**
 * Counter-style stages are aggregated in the Service Worker into bounded
 * counter events instead of being forwarded per message. Each counter event
 * carries only a positive aggregate `count` — never chat text, usernames,
 * channel names, provider bodies, or translation output.
 */
const DIAGNOSTIC_COUNTER_STAGES: readonly DiagnosticStage[] = [
  'batch_dedup_removed',
  'in_flight_coalesced',
  'queue_overflow_drop',
  'queue_obsolete_drop',
  'l2_cache_hit',
  // Speech pipeline counters (Spec §6): aggregate counts only — never
  // transcript text, raw audio, channel names, provider bodies, or keys.
  'speech_started',
  'speech_stopped',
  'speech_caption_emitted',
  'speech_chunk_sent',
  'speech_error',
]

const isCounterStage = (stage: DiagnosticStage): boolean => DIAGNOSTIC_COUNTER_STAGES.includes(stage)

// Accumulated, unbroadcast counter deltas. Because every counter stage reports
// at least once (an empty report flushes and resets), the tally can never grow
// without bound while it is paused.
const pendingDiagnosticCounts = new Map<DiagnosticStage, number>()

let diagnostics: DiagnosticEvent[] = []

const sanitizeDiagnosticEvent = (event: DiagnosticEvent): DiagnosticEvent => {
  if (event.stage !== 'translation_failed') return event

  const { detail: _detail, ...safeEvent } = event
  return safeEvent
}

const persistDiagnostics = (): void => {
  const sessionStorage = chrome.storage?.session
  if (sessionStorage) {
    void sessionStorage.set({ [DIAGNOSTIC_STORAGE_KEY]: diagnostics }).catch(() => undefined)
  }
}

const recordDiagnostic = (event: DiagnosticEvent): void => {
  // Counter-style stages accumulate in the Service Worker and are reported as
  // a single bounded aggregate event. This keeps high-frequency dedup / queue
  // drop traffic out of storage and off the Popup's runtime message stream.
  if (isCounterStage(event.stage)) {
    const delta = typeof event.count === 'number' && event.count > 0 ? event.count : 1
    pendingDiagnosticCounts.set(event.stage, (pendingDiagnosticCounts.get(event.stage) ?? 0) + delta)
    return
  }

  const safeEvent = sanitizeDiagnosticEvent(event)
  diagnostics = [safeEvent, ...diagnostics.filter((entry) => entry.id !== safeEvent.id)].slice(0, MAX_DIAGNOSTICS)
  persistDiagnostics()

  void chrome.runtime.sendMessage?.({
    type: 'diagnostics_snapshot',
    payload: { events: diagnostics },
  }).catch(() => undefined)
}

const flushPendingDiagnosticCounts = (): void => {
  if (pendingDiagnosticCounts.size === 0) return

  const snapshot = [...pendingDiagnosticCounts]
  pendingDiagnosticCounts.clear()
  const events: DiagnosticEvent[] = snapshot.map(([stage, count]) => ({
    id: `counter-${Date.now()}-${stage}`,
    stage,
    timestamp: Date.now(),
    count,
  }))
  diagnostics = [...events, ...diagnostics].slice(0, MAX_DIAGNOSTICS)
  persistDiagnostics()

  void chrome.runtime.sendMessage?.({
    type: 'diagnostics_snapshot',
    payload: { events },
  }).catch(() => undefined)
}

const getDiagnostics = async (): Promise<DiagnosticEvent[]> => {
  flushPendingDiagnosticCounts()

  if (diagnostics.length > 0) return diagnostics

  const sessionStorage = chrome.storage?.session
  if (!sessionStorage) return diagnostics

  const stored = await sessionStorage.get(DIAGNOSTIC_STORAGE_KEY)
  const events = stored[DIAGNOSTIC_STORAGE_KEY]
  diagnostics = Array.isArray(events) ? events as DiagnosticEvent[] : []
  return diagnostics
}

const handleMessage = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): boolean => {
  if (isDiagnosticEventMessage(message)) {
    recordDiagnostic(message.payload)
    return false
  }

  if (isBaseMessage(message) && message.type === 'get_diagnostics') {
    void getDiagnostics().then((events) =>
      sendResponse({ type: 'diagnostics_snapshot', payload: { events } }),
    )
    return true
  }

  if (isGetQuotaHealthMessage(message)) {
    const requestedKey = message.payload?.quotaKey
    void geminiQuotaStore.getDiagnosticState().then((diagnostic) => {
      const allResults = collectQuotaHealthResults(diagnostic)
      const requested = typeof requestedKey === 'string' && requestedKey.trim()
        ? requestedKey.trim()
        : undefined
      const results = requested
        ? allResults.some((entry) => entry.quotaKey === requested)
          ? allResults.filter((entry) => entry.quotaKey === requested)
          : [deriveQuotaHealth({
              quotaKey: requested,
              // A requested key with no exact bucket inherits the ambiguous
              // legacy baseline when one exists, mirroring how getBucket() clones
              // legacyBaseline into a fresh bucket on first use.
              bucket: diagnostic.legacyBaseline ?? undefined,
              snapshot: diagnostic.snapshot,
              wallNow: diagnostic.wallNow,
              highWaterMark: diagnostic.highWaterMark,
              monotonicNow: diagnostic.monotonicNow,
            })]
        : allResults
      sendResponse({ type: 'quota_health_result', payload: results })
    }).catch(() =>
      sendResponse({ type: 'quota_health_result', payload: [] }),
    )
    return true
  }

  // settings_updated from Popup → broadcast to all content scripts
  if (isBaseMessage(message) && message.type === 'settings_updated') {
    void broadcastUpdate(message.payload as SettingsUpdatePayload)
    return false
  }

  // speech_settings_updated from Popup → apply to the active pipeline and
  // broadcast the presentation settings to every content-script overlay.
  if (isSpeechSettingsUpdateMessage(message)) {
    speechPipeline.updateSpeechSettings(message.payload)
    void broadcastToContentScripts({
      type: 'speech_settings_updated',
      payload: message.payload,
    })
    return false
  }

  // speech_control from Popup/content → drive the speech pipeline (Spec §6/§7).
  // Capture lifecycle is owned by the SW; the pipeline handles start/stop and
  // broadcasts speech_state/caption through the SW.
  if (isSpeechControlMessage(message)) {
    handleSpeechControl(message.payload)
    return false
  }

  // Explicit, confirmed repair action scoped to Gemini quota accounting state.
  if (isResetQuotaHealthMessage(message)) {
    const quotaKey = message.payload?.quotaKey
    void geminiQuotaStore.resetQuotaAccounting(quotaKey).then((resetKeys) => {
      sendResponse({ type: 'quota_health_reset_result', payload: { ok: true, resetKeys } })
    }).catch((error) => {
      sendResponse({
        type: 'quota_health_reset_result',
        payload: {
          ok: false,
          resetKeys: [],
          error: error instanceof Error ? error.message : 'Quota repair failed',
        },
      })
    })
    return true
  }

  return router.handleMessage(message, sender, sendResponse)
}

chrome.runtime.onMessage.addListener(handleMessage)

const broadcastUpdate = async (payload: SettingsUpdatePayload): Promise<void> => {
  const tabs = await chrome.tabs.query({})

  const results = await Promise.allSettled(
    tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
      .map((tab) =>
        chrome.tabs.sendMessage(tab.id, {
          type: 'settings_updated',
          payload,
        } as const),
      ),
  )

  for (const r of results) {
    if (r.status === 'rejected') {
      console.debug('broadcastUpdate: tab not available', r.reason)
    }
  }
}

const DISPLAY_MODE_CYCLE: Array<'below' | 'hover' | 'collapse'> = ['below', 'hover', 'collapse']

const handleCommand = async (command: string): Promise<void> => {
  const settings = await getUserSettings()

  switch (command) {
    case 'toggle-translation': {
      const nextEnabled = !settings.translationEnabled

      await saveUserSettings({ translationEnabled: nextEnabled })
      await broadcastUpdate({ translationEnabled: nextEnabled })
      break
    }

    case 'toggle-display-mode': {
      const currentIndex = DISPLAY_MODE_CYCLE.indexOf(settings.displayMode)
      const nextMode = DISPLAY_MODE_CYCLE[(currentIndex + 1) % DISPLAY_MODE_CYCLE.length]

      await saveUserSettings({ displayMode: nextMode })
      await broadcastUpdate({ displayMode: nextMode })
      break
    }
  }
}

chrome.commands.onCommand.addListener(handleCommand)

chrome.runtime.onInstalled.addListener(() => {
  initializeTrustedStorageAccess()
  console.info('tachi-lens installed')
})

// Speech capture primitive (v0.3, Spec §7/§9). The pipeline (#160) calls
// speechCapture.start()/stop() and subscribes to onChunk/onError/onDisconnect;
// the offscreen/tabCapture internals are deliberately hidden behind the
// SpeechSource shape.
export const speechCapture = new SpeechCapture(createSpeechCaptureChrome())

// --- v0.3 speech pipeline / SW orchestration --------------------------------
//
// The SW owns capture lifecycle, provider calls, budget accounting, error
// sanitization, and state broadcast (Spec §3). All broadcasts reuse the
// `chrome.tabs.sendMessage` pattern established by `broadcastUpdate`; every
// payload is sanitized at this boundary (fixed i18n errorKey only — never raw
// provider messages, keys, audio, or transcript, Spec §6).

const speechRateLimiter = new RateLimiter({ maxBackoffMs: 60_000, clock })
const speechBudget = new SpeechBudget({
  storage: createSpeechBudgetChromeStorage(),
  now: () => clock.wallNow(),
})
const speechPipeline = new SpeechPipeline({
  source: speechCapture,
  getProvider: (providerId) => getSpeechProvider(providerId),
  getApiKey: (providerId) => getSpeechApiKeyForServiceWorker(providerId),
  getSettings: () => getUserSettings(),
  budget: speechBudget,
  rateLimiter: speechRateLimiter,
  onState: (payload) => {
    // speech_state is broadcast to every extension context — the content
    // overlay AND the Popup's live-status readout (#162). chrome.runtime
    // .sendMessage reaches both the content scripts' runtime.onMessage and the
    // open popup in one call, so the popup receives capturing/paused/error
    // without any new message contract.
    void chrome.runtime.sendMessage({ type: 'speech_state', payload }).catch(() => undefined)
  },
  onCaption: (caption) => {
    broadcastToContentScripts({ type: 'speech_caption', payload: caption })
  },
  onCaptionCleared: (cleared) => {
    broadcastToContentScripts({ type: 'speech_caption_cleared', payload: cleared })
  },
  onFatalError: (reason) => {
    // Capture is terminal for this session; stop the source and end the budget
    // session so a re-enable starts a fresh session counter.
    void speechCapture.stop()
    void speechBudget.markSessionInactive()
    void speechBudget.flush()
    // Auth/capture/budget errors are recorded as privacy-safe counters.
    void handleSpeechFatalError(reason)
  },
  reportDiagnosticCount: (stage) => {
    recordDiagnostic({ id: `speech-counter-${Date.now()}-${stage}`, stage, timestamp: Date.now() })
  },
})

const broadcastToContentScripts = async <T extends { type: string; payload: unknown }>(
  message: T,
): Promise<void> => {
  const tabs = await chrome.tabs.query({})
  const results = await Promise.allSettled(
    tabs
      .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined)
      .map((tab) => chrome.tabs.sendMessage(tab.id, message)),
  )
  for (const r of results) {
    if (r.status === 'rejected') {
      console.debug('broadcastToContentScripts: tab not available', r.reason)
    }
  }
}

const handleSpeechFatalError = (reason: SpeechErrorReason): void => {
  console.debug('speech pipeline fatal error', reason)
}

// Restore reconnectable paused state after MV3 worker wake (Spec §7). A fresh
// worker starts at idle; the session counter stays active in storage.session,
// so the overlay reports "paused" until the user re-enables.
void speechBudget.readActiveSessionId().then((activeSessionId) => {
  if (activeSessionId) {
    speechPipeline.restorePaused()
  }
}).catch(() => undefined)

const handleSpeechControl = (payload: { action: 'start' | 'stop' | 'toggle'; channelName?: string }): void => {
  switch (payload.action) {
    case 'start':
      void speechPipeline.start()
      break
    case 'stop':
      void speechPipeline.stop()
      break
    case 'toggle': {
      // isCapturing() is true only while the stream is live. A rate-limit pause
      // is a live session (toggle = stop); a suspension pause has no live stream
      // (toggle = resume), matching Spec §7 "the user re-enables to resume".
      if (speechPipeline.isCapturing()) {
        void speechPipeline.stop()
      } else {
        void speechPipeline.start()
      }
      break
    }
  }
}

export {} // keep ES module marker (named exports above already mark it)
