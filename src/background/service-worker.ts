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
import { isBaseMessage, isDiagnosticEventMessage } from '@/shared/messages'
import type { DiagnosticEvent, SettingsUpdatePayload } from '@/shared/messages'
import { TranslationCache } from './cache'
import { createMessageRouter } from './message-router'
import { RateLimiter } from './rate-limiter'
import { GeminiQuotaStore } from './gemini-quota'
import { QuotaScheduler } from './quota-scheduler'
import { Translator } from './translator'

const ignoreStorageInitializationError = (): void => {}

const initializeTrustedStorageAccess = (): void => {
  void initializeStorageAccess().catch(ignoreStorageInitializationError)
}

initializeTrustedStorageAccess()

const cache = new TranslationCache()
const rateLimiter = new RateLimiter({ maxBackoffMs: 60_000 })
const quotaScheduler = new QuotaScheduler(new GeminiQuotaStore({
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
}))
const translator = new Translator(
  {
    cache,
    rateLimiter,
    getSettings: () => getUserSettings(),
    getApiKey: (providerId: ProviderId) => getApiKeyForServiceWorker(providerId),
    getProvider: (providerId) => getProvider(providerId),
    quotaScheduler,
  },
  { debounceMs: 150, maxBatchSize: 10 },
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
  const safeEvent = sanitizeDiagnosticEvent(event)
  diagnostics = [safeEvent, ...diagnostics.filter((entry) => entry.id !== safeEvent.id)].slice(0, MAX_DIAGNOSTICS)
  persistDiagnostics()

  void chrome.runtime.sendMessage?.({
    type: 'diagnostics_snapshot',
    payload: { events: diagnostics },
  }).catch(() => undefined)
}

const getDiagnostics = async (): Promise<DiagnosticEvent[]> => {
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

  // settings_updated from Popup → broadcast to all content scripts
  if (isBaseMessage(message) && message.type === 'settings_updated') {
    void broadcastUpdate(message.payload as SettingsUpdatePayload)
    return false
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
