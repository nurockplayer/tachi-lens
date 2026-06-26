// @vitest-environment jsdom
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

/** Reset document.body and create container + messages matching channel page structure. */
function mountChannelChat(count = 3): void {
  document.body.innerHTML = ''
  const container = document.createElement('div')
  container.setAttribute('data-test-selector', 'chat-scrollable-area__message-container')
  for (let i = 0; i < count; i++) {
    const msg = document.createElement('div')
    msg.className = 'chat-line__message'
    const body = document.createElement('span')
    body.className = 'chat-line__message-body'
    body.textContent = `Message ${i}`
    msg.appendChild(body)
    const meta = document.createElement('span')
    meta.className = 'chat-line__message--meta'
    const username = document.createElement('span')
    username.className = 'chat-author__display-name'
    username.textContent = `user${i}`
    meta.appendChild(username)
    msg.appendChild(meta)
    container.appendChild(msg)
  }
  document.body.appendChild(container)
}

function mountPopoutChat(count = 3): void {
  document.body.innerHTML = ''
  const container = document.createElement('div')
  container.className = 'chat-scrollable-area__message-container'
  for (let i = 0; i < count; i++) {
    const msg = document.createElement('div')
    msg.className = 'chat-line__message'
    const body = document.createElement('span')
    body.className = 'chat-line__message-body'
    body.textContent = `Popout msg ${i}`
    msg.appendChild(body)
    const username = document.createElement('span')
    username.className = 'chat-author__display-name'
    username.textContent = `popuser${i}`
    msg.appendChild(username)
    container.appendChild(msg)
  }
  document.body.appendChild(container)
}

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
  it('recognizes www subdomain as channel', () => {
    expect(detectPageType('https://www.twitch.tv/forsen')).toBe('channel')
  })
  it('recognizes twitch.tv without subdomain as channel', () => {
    expect(detectPageType('https://twitch.tv/forsen')).toBe('channel')
  })
  it('returns unknown for invalid URL', () => {
    expect(detectPageType('not-a-url')).toBe('unknown')
  })
})

describe('getSelectorsForPage', () => {
  it('returns channel selectors for channel page', () => {
    const s = getSelectorsForPage('channel')
    expect(s.CHAT_CONTAINER).toBe(CHAT_CONTAINER)
    expect(s.CHAT_MESSAGE).toBe(CHAT_MESSAGE)
    expect(s.CHAT_MESSAGE_BODY).toBe(CHAT_MESSAGE_BODY)
    expect(s.CHAT_USERNAME).toBe(CHAT_USERNAME)
  })
  it('returns popout-specific selectors for popout page', () => {
    const s = getSelectorsForPage('popout')
    expect(s.CHAT_CONTAINER).toBe('.chat-scrollable-area__message-container')
    expect(s.CHAT_MESSAGE).toBe(CHAT_MESSAGE)
    expect(s.CHAT_MESSAGE_BODY).toBe(CHAT_MESSAGE_BODY)
    expect(s.CHAT_USERNAME).toBe(CHAT_USERNAME)
  })
  it('returns channel selectors for VOD page (same DOM structure)', () => {
    const s = getSelectorsForPage('vod')
    expect(s.CHAT_CONTAINER).toBe(CHAT_CONTAINER)
  })
  it('returns channel selectors as fallback for unknown page type', () => {
    const s = getSelectorsForPage('unknown')
    expect(s.CHAT_CONTAINER).toBe(CHAT_CONTAINER)
  })
  it('returns valid PageType for all page types', () => {
    const types: PageType[] = ['channel', 'popout', 'vod', 'unknown']
    for (const t of types) {
      const s = getSelectorsForPage(t)
      expect(s.CHAT_CONTAINER).toBeTypeOf('string')
      expect(s.CHAT_MESSAGE).toBeTypeOf('string')
      expect(s.CHAT_MESSAGE_BODY).toBeTypeOf('string')
      expect(s.CHAT_USERNAME).toBeTypeOf('string')
    }
  })
})

describe('Channel selectors (integration)', () => {
  it('finds the chat container by data-test-selector', () => {
    mountChannelChat()
    expect(document.querySelector(CHAT_CONTAINER)).not.toBeNull()
  })
  it('finds all chat-line messages', () => {
    mountChannelChat()
    expect(document.querySelectorAll(CHAT_MESSAGE).length).toBe(3)
  })
  it('finds message body inside a message', () => {
    mountChannelChat()
    const body = document.querySelector(`${CHAT_MESSAGE} ${CHAT_MESSAGE_BODY}`)
    expect(body?.textContent).toBe('Message 0')
  })
  it('finds username inside a message', () => {
    mountChannelChat()
    const username = document.querySelector(`${CHAT_MESSAGE} ${CHAT_USERNAME}`)
    expect(username?.textContent).toBe('user0')
  })
})

describe('Popout selectors (integration)', () => {
  it('finds the chat container by class name', () => {
    mountPopoutChat()
    expect(document.querySelector('.chat-scrollable-area__message-container')).not.toBeNull()
  })
  it('finds all chat-line messages', () => {
    mountPopoutChat()
    expect(document.querySelectorAll(CHAT_MESSAGE).length).toBe(3)
  })
  it('finds message body', () => {
    mountPopoutChat()
    const body = document.querySelector(`${CHAT_MESSAGE} ${CHAT_MESSAGE_BODY}`)
    expect(body?.textContent).toBe('Popout msg 0')
  })
  it('finds username', () => {
    mountPopoutChat()
    const username = document.querySelector(`${CHAT_MESSAGE} ${CHAT_USERNAME}`)
    expect(username?.textContent).toBe('popuser0')
  })
})

describe('VOD selectors (integration)', () => {
  it('uses the same container selector as channel page', () => {
    expect(getSelectorsForPage('vod').CHAT_CONTAINER).toBe(getSelectorsForPage('channel').CHAT_CONTAINER)
  })
  it('finds messages inside a channel-style DOM', () => {
    mountChannelChat()
    expect(document.querySelectorAll(CHAT_MESSAGE).length).toBe(3)
  })
})
