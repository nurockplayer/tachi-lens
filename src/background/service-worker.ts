import { getProvider } from '@/providers/registry'
import type { ProviderId } from '@/providers/types'
import { getApiKeyForServiceWorker, getRuntimeState, getUserSettings, initializeStorageAccess } from '@/storage/settings'
import { TranslationCache } from './cache'
import { createMessageRouter } from './message-router'
import { Translator } from './translator'

const ignoreStorageInitializationError = (): void => {}

const initializeTrustedStorageAccess = (): void => {
  void initializeStorageAccess().catch(ignoreStorageInitializationError)
}

initializeTrustedStorageAccess()

const cache = new TranslationCache()
const translator = new Translator(
  {
    cache,
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
): boolean => router.handleMessage(message, sender, sendResponse)

chrome.runtime.onMessage.addListener(handleMessage)

chrome.runtime.onInstalled.addListener(() => {
  initializeTrustedStorageAccess()
  console.info('tachi-lens installed')
})

export {}
