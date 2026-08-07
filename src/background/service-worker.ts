import { getProvider } from '@/providers/registry'
import type { ProviderId } from '@/providers/types'
import {
  deleteApiKey,
  getApiKeyForServiceWorker,
  getChannelSettings,
  getMaskedApiKeyForPopup,
  getRuntimeState,
  getUserSettings,
  initializeStorageAccess,
  mergeSettings,
  saveApiKey,
  saveUserSettings,
} from '@/storage/settings'
import { isBaseMessage, isDiagnosticEventMessage, isGetQuotaHealthMessage, isResetQuotaHealthMessage } from '@/shared/messages'
import type { DiagnosticEvent, DiagnosticStage, SettingsUpdatePayload } from '@/shared/messages'
import { TranslationCache } from './cache'
import { createSystemClock } from './clock'
import { createMessageRouter } from './message-router'
import { RateLimiter } from './rate-limiter'
import { createRestartSafeReservationId, GeminiQuotaStore } from './gemini-quota'
import { collectQuotaHealthResults, deriveQuotaHealth } from './quota-health'
import { QuotaScheduler } from './quota-scheduler'
import { Translator } from './translator'

const ignoreStorageInitializationError = (): void => {}

const initializeTrustedStorageAccess = (): void => {
  void initializeStorageAccess().catch(ignoreStorageInitializationError)
}

initializeTrustedStorageAccess()

const cache = new TranslationCache()
const clock = createSystemClock()
const rateLimiter = new RateLimiter({ maxBackoffMs: 60_000, clock })
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
const translator = new Translator(
  {
    cache,
    rateLimiter,
    getSettings: () => getUserSettings(),
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
  getContentSettings: async (channelName) => {
    const global = await getUserSettings()
    const channel = channelName ? await getChannelSettings(channelName) : undefined

    return channel ? mergeSettings(global, channel) : global
  },
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

export {}
