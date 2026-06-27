import { getProvider } from '@/providers/registry'
import type { ProviderId } from '@/providers/types'
import { getApiKeyForServiceWorker, getRuntimeState, getUserSettings, initializeStorageAccess, saveUserSettings } from '@/storage/settings'
import { isBaseMessage } from '@/shared/messages'
import type { SettingsUpdatePayload } from '@/shared/messages'
import { TranslationCache } from './cache'
import { createMessageRouter } from './message-router'
import { RateLimiter } from './rate-limiter'
import { Translator } from './translator'

const ignoreStorageInitializationError = (): void => {}

const initializeTrustedStorageAccess = (): void => {
  void initializeStorageAccess().catch(ignoreStorageInitializationError)
}

initializeTrustedStorageAccess()

const cache = new TranslationCache()
const rateLimiter = new RateLimiter({ maxBackoffMs: 60_000 })
const translator = new Translator(
  {
    cache,
    rateLimiter,
    getSettings: () => getUserSettings(),
    getApiKey: (providerId: ProviderId) => getApiKeyForServiceWorker(providerId),
    getProvider: (providerId) => getProvider(providerId),
  },
  { debounceMs: 150, maxBatchSize: 10 },
)

const router = createMessageRouter({
  translator,
  getApiKey: (providerId: ProviderId) => getApiKeyForServiceWorker(providerId),
  getProvider: (providerId) => getProvider(providerId),
  getRuntimeState: () => getRuntimeState(),
})

const handleMessage = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): boolean => {
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
