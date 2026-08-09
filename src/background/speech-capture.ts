// Service Worker speech capture primitive (v0.3 speech, Spec §7/§9).
//
// `SpeechCapture` is the capture-half of the speech pipeline (#160 consumes it).
// It owns the offscreen document lifecycle and the tabCapture stream id, and
// exposes a `SpeechSource`-shaped surface so the pipeline never touches
// offscreen/tabCapture internals:
//
//   start()  → resolve active Twitch tab → getMediaStreamId({ targetTabId })
//              → ensure offscreen doc (USER_MEDIA) → runtime message
//              { start_capture, streamId } → receive the offscreen Port
//   stop()   → tear everything down, clear badge
//   onChunk / onError / onDisconnect callbacks → drive the pipeline
//
// The stream id is requested from the Service Worker. D1 (Spec §14): research
// requires an invocation window rooted in a user gesture; the SW is woken
// inside that window by the Popup's explicit enable click, and
// `chrome.tabCapture.getMediaStreamId` is called synchronously within the same
// event-loop turn as `start()` so the gesture window is still open. The Popup
// consent panel IS the user gesture (Spec §8.2). PoC of the live gesture is
// deferred to the manual PoC checklist (real audio path).

import { OFFSCREEN_DOCUMENT_URL, OFFSCREEN_PORT_NAME, OFFSCREEN_JUSTIFICATION } from '@/offscreen/protocol'
import type { OffscreenToSwPortMessage, SpeechCaptureError, SwToOffscreenMessage } from '@/offscreen/protocol'
import { isOffscreenToSwPortMessage } from '@/offscreen/protocol'
import type { AudioChunk } from '@/providers/speech-types'

/** Chrome-version guard: offscreen getContexts / tabCapture.getMediaStreamId need 116+. */
const MIN_CHROME_VERSION = 116

/**
 * `SpeechSource`-shaped surface consumed by the pipeline (#160). The pipeline
 * only ever sees these methods/callbacks; it never imports offscreen/tabCapture.
 */
export interface SpeechSource {
  start(): Promise<void>
  stop(): Promise<void>
  onChunk(callback: (chunk: AudioChunk) => void): void
  onError(callback: (error: SpeechCaptureError) => void): void
  onDisconnect(callback: (reason: string) => void): void
}

/** Narrow chrome.runtime.Port surface needed by SpeechCapture (test seam). */
export interface SpeechCapturePort {
  name: string
  postMessage(message: OffscreenToSwPortMessage): void
  disconnect(): void
  onMessage: {
    addListener(callback: (message: unknown, port: unknown) => void): void
    removeListener(callback: (message: unknown, port: unknown) => void): void
  }
  onDisconnect: {
    addListener(callback: () => void): void
    removeListener(callback: () => void): void
  }
}

/** Chrome API surfaces injected into SpeechCapture so tests can fake them. */
export interface SpeechCaptureChrome {
  runtime: {
    onConnect: {
      addListener(callback: (port: unknown) => void): void
      removeListener(callback: (port: unknown) => void): void
    }
    getContexts(
      filter: chrome.runtime.ContextFilter,
    ): Promise<chrome.runtime.ExtensionContext[]>
    getURL(path: string): string
    sendMessage(message: SwToOffscreenMessage): Promise<unknown>
  }
  offscreen: {
    createDocument(options: {
      url: string
      reasons: chrome.offscreen.Reason[]
      justification: string
    }): Promise<void>
    closeDocument(): Promise<void>
  }
  tabs: {
    query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>
    onUpdated: chrome.events.Event<
      (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void
    >
    onRemoved: chrome.events.Event<
      (tabId: number, removeInfo: chrome.tabs.OnRemovedInfo) => void
    >
  }
  tabCapture: {
    getMediaStreamId(options: { targetTabId: number }): Promise<string>
  }
  action?: {
    setBadgeText(details: { text: string }): Promise<void>
    setBadgeBackgroundColor(details: { color: string }): Promise<void>
  }
}

const TWITCH_HOST_SUFFIX = '.twitch.tv'

/** True when `url` is a twitch.tv page (Spec §7: capture only on Twitch). */
export const isTwitchUrl = (url: string | undefined): boolean => {
  if (!url) return false
  try {
    const { hostname } = new URL(url)
    return hostname === 'twitch.tv' || hostname.endsWith(TWITCH_HOST_SUFFIX)
  } catch {
    return false
  }
}

const NOT_CAPTURING = 'not_capturing'

/**
 * Service Worker speech capture primitive. Instantiate once in the SW; the
 * pipeline (#160) calls `start()`/`stop()` and registers the three callbacks.
 */
export class SpeechCapture implements SpeechSource {
  private offscreenPort: SpeechCapturePort | null = null
  private targetTabId: number | null = null
  private readonly chunkCallbacks: Array<(chunk: AudioChunk) => void> = []
  private readonly errorCallbacks: Array<(error: SpeechCaptureError) => void> = []
  private readonly disconnectCallbacks: Array<(reason: string) => void> = []
  private readonly portMessageHandler = (message: unknown): void => this.onPortMessage(message)
  private readonly portDisconnectHandler = (): void => this.onPortDisconnect()
  private readonly tabUpdatedHandler = (
    tabId: number,
    changeInfo: chrome.tabs.OnUpdatedInfo,
  ): void => this.onTabUpdated(tabId, changeInfo)
  private readonly tabRemovedHandler = (tabId: number): void => this.onTabRemoved(tabId)
  private onConnectListener: ((port: unknown) => void) | null = null
  private stopped = true
  /** True when this session created the offscreen document and must close it. */
  private offscreenOwned = false

  constructor(private readonly chromeApi: SpeechCaptureChrome) {}

  // --- SpeechSource surface -------------------------------------------------

  async start(): Promise<void> {
    if (!this.stopped) return

    const targetTab = await this.resolveTwitchTab()
    if (!targetTab) {
      this.emitError({ reason: 'no_twitch_tab' })
      return
    }
    this.targetTabId = targetTab.id

    // D1 call site: getMediaStreamId is invoked here, synchronously within the
    // user-gesture window opened by the Popup enable click (see module comment).
    let streamId: string
    try {
      streamId = await this.chromeApi.tabCapture.getMediaStreamId({ targetTabId: targetTab.id })
    } catch (error) {
      this.emitError({ reason: 'permission_denied', message: error instanceof Error ? error.message : undefined })
      this.targetTabId = null
      return
    }

    try {
      await this.ensureOffscreenDocument()
    } catch (error) {
      this.emitError({ reason: 'capture_failed', message: error instanceof Error ? error.message : undefined })
      this.targetTabId = null
      return
    }

    // The offscreen doc opens the Port on `start_capture` (Spec §1 arrow
    // "offscreen → SW"); the SW just waits for onConnect to deliver it.
    this.attachConnectListener()

    try {
      await this.sendToOffscreen({ type: 'start_capture', streamId })
    } catch (error) {
      this.emitError({ reason: 'capture_failed', message: error instanceof Error ? error.message : undefined })
      await this.stop()
      return
    }
    this.stopped = false
    this.attachTabLifecycleListeners()
    await this.setBadgeRecording(true)
  }

  async stop(): Promise<void> {
    if (this.stopped && !this.offscreenPort && !this.offscreenOwned) return

    this.stopped = true
    this.detachTabLifecycleListeners()
    this.detachConnectListener()
    // stop_capture to a vanished offscreen doc is expected; never surface it.
    await this.sendToOffscreen({ type: 'stop_capture' }).catch(() => undefined)
    this.disconnectPort(NOT_CAPTURING)
    await this.closeOffscreenDocument()
    this.targetTabId = null
    await this.setBadgeRecording(false)
  }

  onChunk(callback: (chunk: AudioChunk) => void): void {
    this.chunkCallbacks.push(callback)
  }

  onError(callback: (error: SpeechCaptureError) => void): void {
    this.errorCallbacks.push(callback)
  }

  onDisconnect(callback: (reason: string) => void): void {
    this.disconnectCallbacks.push(callback)
  }

  // --- internal --------------------------------------------------------------

  private async resolveTwitchTab(): Promise<{ id: number; url?: string } | null> {
    const tabs = await this.chromeApi.tabs.query({ active: true, lastFocusedWindow: true })
    const tab = tabs.find((entry) => entry.id !== undefined && isTwitchUrl(entry.url))
    return tab && tab.id !== undefined ? { id: tab.id, url: tab.url } : null
  }

  private async ensureOffscreenDocument(): Promise<void> {
    const contexts = await this.chromeApi.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
    if (contexts.length > 0) {
      this.offscreenOwned = false
      return
    }
    await this.chromeApi.offscreen.createDocument({
      url: this.chromeApi.runtime.getURL(OFFSCREEN_DOCUMENT_URL),
      reasons: ['USER_MEDIA'] as chrome.offscreen.Reason[],
      justification: OFFSCREEN_JUSTIFICATION,
    })
    this.offscreenOwned = true
  }

  private async sendToOffscreen(message: SwToOffscreenMessage): Promise<void> {
    const send = async (): Promise<void> => {
      await this.chromeApi.runtime.sendMessage(message)
    }
    try {
      await send()
    } catch (error) {
      // A freshly-created offscreen document may not have attached its message
      // listener yet; retry briefly so a normal startup race never fails the
      // first enable. If it still fails, rethrow so start() can tear down the
      // offscreen document it created (stop() swallows the rethrow).
      const retries = message.type === 'start_capture' ? 5 : 0
      for (let attempt = 0; attempt < retries; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        try {
          await send()
          return
        } catch { /* retry */ }
      }
      throw error instanceof Error ? error : new Error('sendToOffscreen failed')
    }
  }

  private attachConnectListener(): void {
    if (this.onConnectListener) return
    this.onConnectListener = (port: unknown): void => {
      this.attachPort(port)
    }
    this.chromeApi.runtime.onConnect.addListener(this.onConnectListener)
  }

  private detachConnectListener(): void {
    if (!this.onConnectListener) return
    this.chromeApi.runtime.onConnect.removeListener(this.onConnectListener)
    this.onConnectListener = null
  }

  private attachPort(port: unknown): void {
    const candidate = port as SpeechCapturePort | undefined
    if (!candidate || candidate.name !== OFFSCREEN_PORT_NAME) return
    if (this.offscreenPort) {
      candidate.disconnect()
      return
    }
    this.offscreenPort = candidate
    candidate.onMessage.addListener(this.portMessageHandler)
    candidate.onDisconnect.addListener(this.portDisconnectHandler)
  }

  private onPortMessage(message: unknown): void {
    if (!isOffscreenToSwPortMessage(message)) return

    if (message.type === 'audio_chunk') {
      for (const cb of this.chunkCallbacks) cb(message.chunk)
      return
    }
    if (message.type === 'capture_error') {
      this.emitError({ reason: message.reason, message: message.message })
      // §9: tabCapture/getUserMedia/graph failures stop capture immediately
      // (no auto-retry). The offscreen has already stopped its stream; the SW
      // tears down the offscreen document and clears the badge. Idempotent.
      void this.stop()
      return
    }
    if (message.type === 'capture_started') {
      // The offscreen doc is live; nothing further to do (pipeline subscribes
      // to onChunk/onError). Capture is active.
    }
  }

  private onPortDisconnect(): void {
    if (this.offscreenPort) {
      this.offscreenPort.onMessage.removeListener(this.portMessageHandler)
      this.offscreenPort.onDisconnect.removeListener(this.portDisconnectHandler)
      this.offscreenPort = null
    }
    this.detachConnectListener()
    this.detachTabLifecycleListeners()
    const reason = this.stopped ? 'stopped' : 'port_disconnected'
    for (const cb of this.disconnectCallbacks) cb(reason)
    this.stopped = true
    this.targetTabId = null
    void this.closeOffscreenDocument()
    void this.setBadgeRecording(false)
  }

  private disconnectPort(reason: string): void {
    if (!this.offscreenPort) return
    this.offscreenPort.onMessage.removeListener(this.portMessageHandler)
    this.offscreenPort.onDisconnect.removeListener(this.portDisconnectHandler)
    this.offscreenPort.disconnect()
    this.offscreenPort = null
    for (const cb of this.disconnectCallbacks) cb(reason)
  }

  private onTabUpdated(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo): void {
    if (this.targetTabId !== tabId) return
    if (changeInfo.url === undefined) return
    if (!isTwitchUrl(changeInfo.url)) {
      void this.stop()
    }
  }

  private onTabRemoved(tabId: number): void {
    if (this.targetTabId !== tabId) return
    void this.stop()
  }

  private attachTabLifecycleListeners(): void {
    this.chromeApi.tabs.onUpdated.addListener(this.tabUpdatedHandler)
    this.chromeApi.tabs.onRemoved.addListener(this.tabRemovedHandler)
  }

  private detachTabLifecycleListeners(): void {
    this.chromeApi.tabs.onUpdated.removeListener(this.tabUpdatedHandler)
    this.chromeApi.tabs.onRemoved.removeListener(this.tabRemovedHandler)
  }

  private async closeOffscreenDocument(): Promise<void> {
    // Only close a document this session created; a document owned by another
    // session (or an already-closed one) is left alone.
    if (!this.offscreenOwned) return
    this.offscreenOwned = false
    try {
      await this.chromeApi.offscreen.closeDocument()
    } catch (error) {
      // Already closed / not present is fine.
      if (error instanceof Error && /not found|no document/i.test(error.message)) return
    }
  }

  private async setBadgeRecording(recording: boolean): Promise<void> {
    if (!this.chromeApi.action) return
    try {
      if (recording) {
        await this.chromeApi.action.setBadgeText({ text: 'REC' })
        await this.chromeApi.action.setBadgeBackgroundColor({ color: '#e53935' })
      } else {
        await this.chromeApi.action.setBadgeText({ text: '' })
      }
    } catch {
      // Badge is best-effort UI; capture continues regardless.
    }
  }

  private emitError(error: SpeechCaptureError): void {
    for (const cb of this.errorCallbacks) cb(error)
  }
}

// --- SW wiring helper --------------------------------------------------------

/** A no-op chrome.events.Event-shaped stub for missing API surfaces. */
const createNoopEvent = (): {
  addListener: () => void
  removeListener: () => void
} => ({
  addListener: () => undefined,
  removeListener: () => undefined,
})

/**
 * Build the real `SpeechCaptureChrome` adapter from the live `chrome` global.
 * Kept separate so `SpeechCapture` stays pure and unit-testable with fakes.
 *
 * Every surface is accessed defensively (optional chaining + no-op stubs) so
 * importing `service-worker.ts` in unit tests with a minimal `chrome` mock
 * never throws; the adapter's methods are only ever *called* by the real SW
 * when the pipeline (#160) drives capture.
 */
export const createSpeechCaptureChrome = (): SpeechCaptureChrome => {
  const runtime = chrome.runtime
  const tabs = chrome.tabs
  const offscreen = chrome.offscreen
  const tabCapture = chrome.tabCapture
  const action = chrome.action
  return {
    runtime: {
      onConnect: runtime?.onConnect ?? createNoopEvent(),
      getContexts: (filter) => runtime?.getContexts?.(filter) ?? Promise.resolve([]),
      getURL: (path) => runtime?.getURL?.(path) ?? path,
      sendMessage: (message) => runtime?.sendMessage?.(message) ?? Promise.resolve(undefined),
    },
    offscreen: {
      createDocument: (options) => offscreen?.createDocument(options) ?? Promise.resolve(),
      closeDocument: () => offscreen?.closeDocument() ?? Promise.resolve(),
    },
    tabs: {
      query: (queryInfo) => tabs?.query(queryInfo) ?? Promise.resolve([]),
      onUpdated: tabs?.onUpdated ?? createNoopEvent(),
      onRemoved: tabs?.onRemoved ?? createNoopEvent(),
    },
    tabCapture: {
      getMediaStreamId: (options) => tabCapture?.getMediaStreamId(options) ?? Promise.resolve(''),
    },
    action,
  }
}

export const MIN_SUPPORTED_CHROME_VERSION = MIN_CHROME_VERSION
