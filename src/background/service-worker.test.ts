import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeStorageAccess } from '@/storage/settings'

vi.mock('@/storage/settings', () => ({
  initializeStorageAccess: vi.fn(async () => undefined),
  getUserSettings: vi.fn(async () => ({
    selectedProvider: 'deepseek',
    selectedModel: 'deepseek-v4-flash',
    targetLanguage: 'zh-TW',
  })),
  getApiKeyForServiceWorker: vi.fn(async () => undefined),
  getRuntimeState: vi.fn(async () => ({})),
  getChannelSettings: vi.fn(async () => undefined),
  mergeSettings: vi.fn((global: unknown) => global),
  saveApiKey: vi.fn(async () => undefined),
  deleteApiKey: vi.fn(async () => undefined),
  getMaskedApiKeyForPopup: vi.fn(async () => undefined),
  saveUserSettings: vi.fn(async () => undefined),
}))

vi.mock('@/providers/registry', () => ({
  getProvider: vi.fn(() => undefined),
}))

const createChromeRuntime = () => ({
  runtime: {
    onMessage: {
      addListener: vi.fn(),
    },
    onInstalled: {
      addListener: vi.fn(),
    },
  },
  commands: {
    onCommand: {
      addListener: vi.fn(),
    },
  },
})

describe('service worker startup', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(initializeStorageAccess).mockClear()
  })

  it('initializes storage access on startup and when the extension is installed', async () => {
    const chromeRuntime = createChromeRuntime()
    vi.stubGlobal('chrome', chromeRuntime)

    await import('./service-worker')

    expect(initializeStorageAccess).toHaveBeenCalledTimes(1)
    const onInstalledCall = chromeRuntime.runtime.onInstalled.addListener.mock.calls[0]
    if (!onInstalledCall) {
      throw new Error('Expected service worker to register an onInstalled listener')
    }

    const onInstalled = onInstalledCall[0]
    if (typeof onInstalled !== 'function') {
      throw new Error('Expected registered onInstalled listener to be callable')
    }

    onInstalled()

    expect(initializeStorageAccess).toHaveBeenCalledTimes(2)
  })

  it('registers a message listener on startup', async () => {
    const chromeRuntime = createChromeRuntime()
    vi.stubGlobal('chrome', chromeRuntime)

    await import('./service-worker')

    expect(chromeRuntime.runtime.onMessage.addListener).toHaveBeenCalledTimes(1)
    const handler = chromeRuntime.runtime.onMessage.addListener.mock.calls[0]?.[0]
    expect(handler).toBeTypeOf('function')
  })

  it('delegates valid translate_request to the router via the message handler', async () => {
    const chromeRuntime = createChromeRuntime()
    vi.stubGlobal('chrome', chromeRuntime)

    await import('./service-worker')

    const handler = chromeRuntime.runtime.onMessage.addListener.mock.calls[0]?.[0] as
      | ((message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => boolean)
      | undefined

    if (!handler) {
      throw new Error('Expected a message handler to be registered')
    }

    const sendResponse = vi.fn()
    const result = handler(
      { type: 'translate_request', payload: { messageId: 'm1', text: 'Hello' } },
      undefined,
      sendResponse,
    )

    expect(result).toBe(true)
  })

  it('returns false for unknown message types via the handler', async () => {
    const chromeRuntime = createChromeRuntime()
    vi.stubGlobal('chrome', chromeRuntime)

    await import('./service-worker')

    const handler = chromeRuntime.runtime.onMessage.addListener.mock.calls[0]?.[0] as
      | ((message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => boolean)
      | undefined

    if (!handler) {
      throw new Error('Expected a message handler to be registered')
    }

    const result = handler({ type: 'nonsense', payload: {} }, undefined, vi.fn())

    expect(result).toBe(false)
  })

  it('records diagnostic events and returns them to the Popup as a snapshot', async () => {
    const chromeRuntime = createChromeRuntime()
    vi.stubGlobal('chrome', chromeRuntime)

    await import('./service-worker')

    const handler = chromeRuntime.runtime.onMessage.addListener.mock.calls[0]?.[0] as
      | ((message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => boolean)
      | undefined

    if (!handler) {
      throw new Error('Expected a message handler to be registered')
    }

    const event = { id: 'd1', stage: 'message_detected', timestamp: 1000 }
    handler({ type: 'diagnostic_event', payload: event }, undefined, vi.fn())

    const sendResponse = vi.fn()
    expect(handler({ type: 'get_diagnostics', payload: {} }, undefined, sendResponse)).toBe(true)

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        type: 'diagnostics_snapshot',
        payload: { events: [event] },
      })
    })
  })

  it('removes translation failure detail before persisting or broadcasting diagnostics', async () => {
    const diagnosticsStorage = vi.fn(async () => undefined)
    const sendMessage = vi.fn(async () => undefined)
    const chromeRuntime = {
      ...createChromeRuntime(),
      runtime: {
        ...createChromeRuntime().runtime,
        sendMessage,
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: diagnosticsStorage,
        },
      },
    }
    vi.stubGlobal('chrome', chromeRuntime)

    await import('./service-worker')

    const handler = chromeRuntime.runtime.onMessage.addListener.mock.calls[0]?.[0] as
      | ((message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => boolean)
      | undefined

    if (!handler) {
      throw new Error('Expected a message handler to be registered')
    }

    handler({
      type: 'diagnostic_event',
      payload: {
        id: 'd-sensitive',
        stage: 'translation_failed',
        timestamp: 1000,
        detail: 'Private chat text and key sk-secret-key',
      },
    }, undefined, vi.fn())

    const safeEvent = { id: 'd-sensitive', stage: 'translation_failed', timestamp: 1000 }
    await vi.waitFor(() => {
      expect(diagnosticsStorage).toHaveBeenCalledWith({ translationDiagnostics: [safeEvent] })
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'diagnostics_snapshot',
        payload: { events: [safeEvent] },
      })
    })

    const sendResponse = vi.fn()
    expect(handler({ type: 'get_diagnostics', payload: {} }, undefined, sendResponse)).toBe(true)

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        type: 'diagnostics_snapshot',
        payload: {
          events: [safeEvent],
        },
      })
    })
  })
})
