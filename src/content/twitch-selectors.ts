// Twitch DOM selector contract
// All selectors used to find Twitch chat messages are defined here.
// When Twitch changes their DOM, only this file needs updating.

export const CHAT_CONTAINER = '[data-test-selector="chat-scrollable-area__message-container"]'
export const CHAT_MESSAGE = '.chat-line__message'
export const CHAT_MESSAGE_BODY = '.chat-line__message-body'
export const CHAT_USERNAME = '.chat-author__display-name'

// Chat message attributes
export const ATTR_PROCESSED = 'data-tachi-lens-processed'
export const ATTR_TRANSLATED = 'data-tachi-lens-translated'
