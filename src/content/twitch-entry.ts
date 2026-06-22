// Content Script entry point — Twitch DOM observer and translation UI injection
// Observes Twitch chat messages, filters, batches, and sends to Service Worker for translation.

import './twitch-selectors'

const main = (): void => {
  console.info('tachi-lens content script loaded')
  // MutationObserver and injection logic will be implemented in #2
}

main()
