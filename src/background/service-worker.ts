// Service Worker entry point
// Routes messages from Content Script and Popup, manages translation queue, cache, and API calls.

import { initializeStorageAccess } from '@/storage/settings'

const ignoreStorageInitializationError = (): void => {
  // Avoid logging storage payloads or API-key-adjacent state during startup.
}

const initializeTrustedStorageAccess = (): void => {
  void initializeStorageAccess().catch(ignoreStorageInitializationError)
}

initializeTrustedStorageAccess()

const handleMessage = (
  _message: unknown,
  _sender: chrome.runtime.MessageSender,
  _sendResponse: (response: unknown) => void,
): boolean => {
  // Message routing will be implemented in #3
  return false
}

chrome.runtime.onMessage.addListener(handleMessage)

// Keep service worker alive during startup
chrome.runtime.onInstalled.addListener(() => {
  initializeTrustedStorageAccess()
  console.info('tachi-lens installed')
})

export {}
