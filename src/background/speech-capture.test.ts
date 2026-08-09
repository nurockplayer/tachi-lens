// Unit tests for the Service Worker SpeechCapture primitive (Spec §7/§9).
// Uses a FAKE chrome API — no real tabCapture / offscreen / Port (Spec §11).
// Follows src/background/service-worker.test.ts mock patterns.

import { describe, expect, it, vi } from 'vitest'
import { SpeechCapture, isTwitchUrl } from './speech-capture'
import type { SpeechCaptureChrome, SpeechCapturePort } from './speech-capture'
import type { AudioChunk } from '@/providers/speech-types'
import type { OffscreenToSwPortMessage } from '@/offscreen/protocol'

interface FakeEvent<T extends (...args: never[]) => void> {
  listeners: T[]
  addListener(cb: T): void
  removeListener(cb: T): void
  fire(...args: Parameters<T>): void
}

const createFakeEvent = <T extends (...args: never[]) => void>(): FakeEvent<T> => {
  const listeners: T[] = []
  return {
    listeners,
    addListener: (cb) => { listeners.push(cb) },
    removeListener: (cb) => {
      const i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    },
    fire: (...args: Parameters<T>) => {
      for (const cb of [...listeners]) cb(...args)
    },
  }
}

interface FakeChrome {
  tabs: {
    query: ReturnType<typeof vi.fn>
    onUpdated: FakeEvent<(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void>
    onRemoved: FakeEvent<(tabId: number) => void>
  }
  tabCapture: { getMediaStreamId: ReturnType<typeof vi.fn> }
  offscreen: {
    createDocument: ReturnType<typeof vi.fn>
    closeDocument: ReturnType<typeof vi.fn>
  }
  runtime: {
    onConnect: FakeEvent<(port: unknown) => void>
    getContexts: ReturnType<typeof vi.fn>
    getURL: ReturnType<typeof vi.fn>
    sendMessage: ReturnType<typeof vi.fn>
  }
  action: {
    setBadgeText: ReturnType<typeof vi.fn>
    setBadgeBackgroundColor: ReturnType<typeof vi.fn>
  }
  capturedCreateDocumentOptions: Array<{
    url: string
    reasons: string[]
    justification: string
  }>
}

const createFakeChrome = (overrides: Partial<FakeChrome> = {}): FakeChrome => {
  const fake: FakeChrome = {
    tabs: {
      query: vi.fn(async () => []),
      onUpdated: createFakeEvent<(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void>(),
      onRemoved: createFakeEvent<(tabId: number) => void>(),
    },
    tabCapture: { getMediaStreamId: vi.fn(async () => 'stream-abc') },
    offscreen: {
      createDocument: vi.fn(async () => undefined),
      closeDocument: vi.fn(async () => undefined),
    },
    runtime: {
      onConnect: createFakeEvent<(port: unknown) => void>(),
      getContexts: vi.fn(async () => []),
      getURL: vi.fn((path: string) => `chrome-extension://extid/${path}`),
      sendMessage: vi.fn(async () => undefined),
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    capturedCreateDocumentOptions: [],
    ...overrides,
  }
  // capture the createDocument options for assertion
  fake.offscreen.createDocument.mockImplementation(async (options) => {
    fake.capturedCreateDocumentOptions.push(options)
  })
  return fake
}

interface FakePort {
  port: SpeechCapturePort
  sent: OffscreenToSwPortMessage[]
  disconnect: ReturnType<typeof vi.fn>
  messageHandlers: Array<(message: unknown, port: unknown) => void>
  disconnectHandlers: Array<() => void>
}

const createFakePort = (name = 'speech-capture'): FakePort => {
  const sent: OffscreenToSwPortMessage[] = []
  const messageHandlers: Array<(message: unknown, port: unknown) => void> = []
  const disconnectHandlers: Array<() => void> = []
  const disconnect = vi.fn()
  const port: SpeechCapturePort = {
    name,
    postMessage: (message) => sent.push(message),
    disconnect,
    onMessage: {
      addListener: (cb) => messageHandlers.push(cb),
      removeListener: (cb) => {
        const i = messageHandlers.indexOf(cb)
        if (i >= 0) messageHandlers.splice(i, 1)
      },
    },
    onDisconnect: {
      addListener: (cb) => disconnectHandlers.push(cb),
      removeListener: (cb) => {
        const i = disconnectHandlers.indexOf(cb)
        if (i >= 0) disconnectHandlers.splice(i, 1)
      },
    },
  }
  return { port, sent, disconnect, messageHandlers, disconnectHandlers }
}

/** Drive the SW's start() with an active Twitch tab; returns the fake chrome. */
const setupStarted = async (options: { chrome?: FakeChrome; tab?: { id: number; url: string } } = {}): Promise<{
  capture: SpeechCapture
  chrome: FakeChrome
  port: FakePort
}> => {
  const tab = options.tab ?? { id: 7, url: 'https://www.twitch.tv/somechannel' }
  const chrome = options.chrome ?? createFakeChrome()
  if (chrome.tabs.query.mock.calls.length === 0) {
    chrome.tabs.query.mockResolvedValue([tab])
  }
  const port = createFakePort()
  const capture = new SpeechCapture(chrome as unknown as SpeechCaptureChrome)
  await capture.start()

  // Deliver the offscreen Port to the SW via onConnect.
  chrome.runtime.onConnect.fire(port.port)

  return { capture, chrome, port }
}

const CHUNK: AudioChunk = {
  chunkId: 'c1',
  data: new ArrayBuffer(2),
  mimeType: 'audio/pcm;rate=16000',
  startMs: 0,
  endMs: 300,
  isFinal: false,
}

describe('SpeechCapture', () => {
  describe('isTwitchUrl', () => {
    it('matches twitch.tv and subdomains', () => {
      expect(isTwitchUrl('https://twitch.tv')).toBe(true)
      expect(isTwitchUrl('https://www.twitch.tv/somechannel')).toBe(true)
      expect(isTwitchUrl('https://clips.twitch.tv/abc')).toBe(true)
    })

    it('rejects non-Twitch URLs and garbage', () => {
      expect(isTwitchUrl('https://example.com')).toBe(false)
      expect(isTwitchUrl(undefined)).toBe(false)
      expect(isTwitchUrl('not-a-url')).toBe(false)
      expect(isTwitchUrl('https://evil-twitch.tv')).toBe(false)
    })
  })

  describe('create-on-demand', () => {
    it('creates the offscreen document (USER_MEDIA) when none exists', async () => {
      const chrome = createFakeChrome()
      chrome.runtime.getContexts.mockResolvedValue([])
      await setupStarted({ chrome })

      expect(chrome.runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
      expect(chrome.offscreen.createDocument).toHaveBeenCalledWith({
        url: 'chrome-extension://extid/src/offscreen/index.html',
        reasons: ['USER_MEDIA'],
        justification: expect.stringContaining('capture twitch audio'),
      })
    })

    it('reuses an existing offscreen document instead of creating a second one', async () => {
      const chrome = createFakeChrome()
      chrome.runtime.getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }])
      await setupStarted({ chrome })

      expect(chrome.offscreen.createDocument).not.toHaveBeenCalled()
    })

    it('resolves the active Twitch tab and requests its stream id', async () => {
      const chrome = createFakeChrome()
      chrome.tabs.query.mockResolvedValue([
        { id: 1, url: 'https://example.com' },
        { id: 7, url: 'https://www.twitch.tv/somechannel' },
      ])
      await setupStarted({ chrome })

      expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true })
      expect(chrome.tabCapture.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 7 })
    })

    it('emits no_twitch_tab when no Twitch tab is active', async () => {
      const chrome = createFakeChrome()
      chrome.tabs.query.mockResolvedValue([{ id: 3, url: 'https://example.com' }])
      const errors: string[] = []
      const capture = new SpeechCapture(chrome as unknown as SpeechCaptureChrome)
      capture.onError((e) => errors.push(e.reason))
      await capture.start()
      expect(errors).toEqual(['no_twitch_tab'])
      expect(chrome.offscreen.createDocument).not.toHaveBeenCalled()
    })

    it('sets the REC badge on start and clears it on stop', async () => {
      const { capture, chrome } = await setupStarted()
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'REC' })
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#e53935' })

      await capture.stop()
      expect(chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' })
    })

    it('closes the offscreen document it created when start_capture delivery fails', async () => {
      const chrome = createFakeChrome()
      chrome.tabs.query.mockResolvedValue([{ id: 7, url: 'https://www.twitch.tv/x' }])
      chrome.runtime.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'))
      const errors: string[] = []
      const capture = new SpeechCapture(chrome as unknown as SpeechCaptureChrome)
      capture.onError((e) => errors.push(e.reason))
      await capture.start()

      expect(errors).toEqual(['capture_failed'])
      expect(chrome.offscreen.closeDocument).toHaveBeenCalled()
      expect(chrome.action.setBadgeText).not.toHaveBeenCalledWith({ text: 'REC' })
    })

    it('does not close an offscreen document it did not create (reuse path)', async () => {
      const chrome = createFakeChrome()
      chrome.runtime.getContexts.mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }])
      const { capture } = await setupStarted({ chrome })
      await capture.stop()
      // Document was pre-existing, so closeDocument must not be called.
      expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled()
    })
  })

  describe('Port messages', () => {
    it('forwards audio_chunk to onChunk subscribers', async () => {
      const { capture, port } = await setupStarted()
      const chunks: AudioChunk[] = []
      capture.onChunk((c) => chunks.push(c))
      port.messageHandlers[0]?.({ type: 'audio_chunk', chunk: CHUNK }, undefined)
      expect(chunks).toEqual([CHUNK])
    })

    it('forwards capture_error to onError and stops capture', async () => {
      const { capture, chrome, port } = await setupStarted()
      const errors: string[] = []
      capture.onError((e) => errors.push(e.reason))
      port.messageHandlers[0]?.({ type: 'capture_error', reason: 'permission_denied' }, undefined)
      expect(errors).toEqual(['permission_denied'])
      // §9: error stops capture — offscreen doc closed, badge cleared.
      await vi.waitFor(() => {
        expect(chrome.offscreen.closeDocument).toHaveBeenCalled()
      })
    })
  })

  describe('stop', () => {
    it('sends stop_capture, disconnects the Port, and closes the offscreen document', async () => {
      const { capture, chrome, port } = await setupStarted()
      await capture.stop()
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'stop_capture' })
      expect(port.disconnect).toHaveBeenCalled()
      expect(chrome.offscreen.closeDocument).toHaveBeenCalled()
    })

    it('stops everything on tab navigation off Twitch', async () => {
      const { chrome } = await setupStarted()
      chrome.tabs.onUpdated.fire(7, { url: 'https://example.com' } as chrome.tabs.OnUpdatedInfo, {} as chrome.tabs.Tab)
      await vi.waitFor(() => {
        expect(chrome.offscreen.closeDocument).toHaveBeenCalled()
      })
    })

    it('stops everything on tab close', async () => {
      const { chrome } = await setupStarted()
      chrome.tabs.onRemoved.fire(7)
      await vi.waitFor(() => {
        expect(chrome.offscreen.closeDocument).toHaveBeenCalled()
      })
    })

    it('ignores navigation events for other tabs', async () => {
      const { chrome } = await setupStarted()
      chrome.tabs.onUpdated.fire(99, { url: 'https://example.com' } as chrome.tabs.OnUpdatedInfo, {} as chrome.tabs.Tab)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled()
    })
  })

  describe('Port drop', () => {
    it('notifies onDisconnect and stops capture when the Port drops (SW suspension)', async () => {
      const { capture, chrome, port } = await setupStarted()
      const reasons: string[] = []
      capture.onDisconnect((r) => reasons.push(r))
      port.disconnectHandlers[0]?.()
      expect(reasons).toEqual(['port_disconnected'])
      expect(chrome.offscreen.closeDocument).toHaveBeenCalled()
      expect(capture['stopped']).toBe(true)
    })
  })

  describe('errors', () => {
    it('emits permission_denied when getMediaStreamId rejects', async () => {
      const chrome = createFakeChrome()
      chrome.tabs.query.mockResolvedValue([{ id: 7, url: 'https://www.twitch.tv/x' }])
      chrome.tabCapture.getMediaStreamId.mockRejectedValue(new Error('no permission'))
      const errors: string[] = []
      const capture = new SpeechCapture(chrome as unknown as SpeechCaptureChrome)
      capture.onError((e) => errors.push(e.reason))
      await capture.start()
      expect(errors).toEqual(['permission_denied'])
    })
  })

  describe('double-start protection', () => {
    it('ignores start() while already capturing', async () => {
      const { capture, chrome } = await setupStarted()
      await capture.start()
      expect(chrome.tabCapture.getMediaStreamId).toHaveBeenCalledTimes(1)
    })
  })
})
