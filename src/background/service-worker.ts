// Service Worker entry point
// Routes messages from Content Script and Popup, manages translation queue, cache, and API calls.

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
  console.info('tachi-lens installed')
})

export {}
