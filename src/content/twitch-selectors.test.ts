// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CHAT_CONTAINER,
  CHAT_MESSAGE,
  CHAT_MESSAGE_BODY,
  CHAT_USERNAME,
  detectPageType,
  getSelectorsForPage,
  type PageType,
} from './twitch-selectors'

describe('detectPageType', () => {
  it('detects channel page from standard twitch URL', () => {
    expect(detectPageType('https://www.twitch.tv/somechannel')).toBe('channel')
  })

  it('detects channel page from URL with trailing slash', () => {
    expect(detectPageType('https://www.twitch.tv/somechannel/')).toBe('channel')
  })

  it('detects popout chat page', () => {
    expect(detectPageType('https://www.twitch.tv/popout/somechannel/chat')).toBe('popout')
  })

  it('detects VOD page', () => {
    expect(detectPageType('https://www.twitch.tv/videos/123456789')).toBe('vod')
  })

  it('returns unknown for non-Twitch URLs', () => {
    expect(detectPageType('https://example.com')).toBe('unknown')
  })

  it('returns channel for twitch directory page', () => {
    expect(detectPageType('https://www.twitch.tv/directory/game/valorant')).toBe('channel')
  })

  it('returns channel for twitch homepage', () => {
    expect(detectPageType('https://www.twitch.tv')).toBe('channel')
  })
})

describe('getSelectorsForPage', () => {
  it('returns channel selectors for channel page', () => {
    const selectors = getSelectorsForPage('channel')
    expect(selectors.CHAT_CONTAINER).toBe(CHAT_CONTAINER)
    expect(selectors.CHAT_MESSAGE).toBe(CHAT_MESSAGE)
    expect(selectors.CHAT_MESSAGE_BODY).toBe(CHAT_MESSAGE_BODY)
    expect(selectors.CHAT_USERNAME).toBe(CHAT_USERNAME)
  })

  it('returns popout-specific selectors for popout page', () => {
    const selectors = getSelectorsForPage('popout')
    // Popout uses different container selector
    expect(selectors.CHAT_CONTAINER).toBe('.chat-scrollable-area__message-container')
    // Message and user selectors should be the same
    expect(selectors.CHAT_MESSAGE).toBe(CHAT_MESSAGE)
    expect(selectors.CHAT_MESSAGE_BODY).toBe(CHAT_MESSAGE_BODY)
    expect(selectors.CHAT_USERNAME).toBe(CHAT_USERNAME)
  })

  it('returns channel selectors for VOD page (same DOM structure)', () => {
    const selectors = getSelectorsForPage('vod')
    expect(selectors.CHAT_CONTAINER).toBe(CHAT_CONTAINER)
    expect(selectors.CHAT_MESSAGE).toBe(CHAT_MESSAGE)
    expect(selectors.CHAT_MESSAGE_BODY).toBe(CHAT_MESSAGE_BODY)
    expect(selectors.CHAT_USERNAME).toBe(CHAT_USERNAME)
  })

  it('returns channel selectors as fallback for unknown page type', () => {
    const selectors = getSelectorsForPage('unknown')
    expect(selectors.CHAT_CONTAINER).toBe(CHAT_CONTAINER)
    expect(selectors.CHAT_MESSAGE).toBe(CHAT_MESSAGE)
  })

  it('returns valid PageType for all page types', () => {
    const pageTypes: PageType[] = ['channel', 'popout', 'vod', 'unknown']
    for (const pageType of pageTypes) {
      const selectors = getSelectorsForPage(pageType)
      expect(selectors.CHAT_CONTAINER).toBeTypeOf('string')
      expect(selectors.CHAT_MESSAGE).toBeTypeOf('string')
      expect(selectors.CHAT_MESSAGE_BODY).toBeTypeOf('string')
      expect(selectors.CHAT_USERNAME).toBeTypeOf('string')
    }
  })
})
