import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeStorageAccess, saveUserSettings, getUserSettings } from '@/storage/settings'

vi.mock('@/storage/settings', () => ({
  initializeStorageAccess: vi.fn(async () => undefined),
  getUserSettings: vi.fn(async () => ({
    selectedProvider: 'deepseek',
    selectedModel: 'deepseek-v4-flash',
    targetLanguage: 'zh-TW',
    displayMode: 'below',
    translationEnabled: true,
    botNameBlacklist: [],
    minTextLength: 2,
  })),
  saveUserSettings: vi.fn(async (updates: Record<string, unknown>) => updates),
  getApiKeyForServiceWorker: vi.fn(async () => undefined),
  getRuntimeState: vi.fn(async () => ({})),
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
  tabs: {
    query: vi.fn(async () => [
      { id: 101 },
      { id: 102 },
    ]),
    sendMessage: vi.fn(async () => undefined),
  },
})

const defaultSettings = {
  selectedProvider: 'deepseek' as const,
  selectedModel: 'deepseek-v4-flash' as const,
  targetLanguage: 'zh-TW' as const,
  displayMode: 'below' as const,
  translationEnabled: true,
  botNameBlacklist: [] as string[],
  minTextLength: 2,
}

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
})

describe('command handling', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(initializeStorageAccess).mockClear()
    vi.mocked(saveUserSettings).mockClear()
    vi.mocked(getUserSettings).mockClear()
  })

  it('registers a command listener on startup', async () => {
    const chromeRuntime = createChromeRuntime()
    vi.stubGlobal('chrome', chromeRuntime)

    await import('./service-worker')

    expect(chromeRuntime.commands.onCommand.addListener).toHaveBeenCalledTimes(1)
    const handler = chromeRuntime.commands.onCommand.addListener.mock.calls[0]?.[0]
    expect(handler).toBeTypeOf('function')
  })

  it('toggle-translation disables translation when currently enabled and broadcasts', async () => {
    const chromeRuntime = createChromeRuntime()
    vi.stubGlobal('chrome', chromeRuntime)
    vi.mocked(getUserSettings).mockResolvedValue({ ...defaultSettings, translationEnabled: true })

    await import('./service-worker')

    const handler = chromeRuntime.commands.onCommand.addListener.mock.calls[0]?.[0] as ((command: string) => Promise<void>) | undefined
    if (!handler) throw new Error('Expected a command handler')
    await handler('toggle-translation')

    expect(saveUserSettings).toHaveBeenCalledWith({ translationEnabled: false })
    expect(chromeRuntime.tabs.query).toHaveBeenCalledWith({})
    expect(chromeRuntime.tabs.sendMessage).toHaveBeenCalledTimes(2)
    expect(chromeRuntime.tabs.sendMessage).toHaveBeenCalledWith(101, {
      type: 'settings_updated',
      payload: { translationEnabled: false },
    })
    expect(chromeRuntime.tabs.sendMessage).toHaveBeenCalledWith(102, {
      type: 'settings_updated',
      payload: { translationEnabled: false },
    })
  })

  it('toggle-translation enables translation when currently disabled', async () => {
    const chromeRuntime = createChromeRuntime()
    vi.stubGlobal('chrome', chromeRuntime)
    vi.mocked(getUserSettings).mockResolvedValue({ ...defaultSettings, translationEnabled: false })

    await import('./service-worker')

    const handler = chromeRuntime.commands.onCommand.addListener.mock.calls[0]?.[0] as ((command: string) => Promise<void>) | undefined
    if (!handler) throw new Error('Expected a command handler')
    await handler('toggle-translation')

    expect(saveUserSettings).toHaveBeenCalledWith({ translationEnabled: true })
  })

  it('toggle-display-mode cycles from below → hover → collapse → below', async () => {
    const chromeRuntime = createChromeRuntime()
    vi.stubGlobal('chrome', chromeRuntime)

    await import('./service-worker')

    const handler = chromeRuntime.commands.onCommand.addListener.mock.calls[0]?.[0] as ((command: string) => Promise<void>) | undefined
    if (!handler) throw new Error('Expected a command handler')

    vi.mocked(getUserSettings).mockResolvedValue({ ...defaultSettings, displayMode: 'below' })
    await handler('toggle-display-mode')
    expect(saveUserSettings).toHaveBeenCalledWith({ displayMode: 'hover' })

    vi.mocked(getUserSettings).mockResolvedValue({ ...defaultSettings, displayMode: 'hover' })
    await handler('toggle-display-mode')
    expect(saveUserSettings).toHaveBeenCalledWith({ displayMode: 'collapse' })

    vi.mocked(getUserSettings).mockResolvedValue({ ...defaultSettings, displayMode: 'collapse' })
    await handler('toggle-display-mode')
    expect(saveUserSettings).toHaveBeenCalledWith({ displayMode: 'below' })
  })

  it('ignores unknown commands without saving or broadcasting', async () => {
    const chromeRuntime = createChromeRuntime()
    vi.stubGlobal('chrome', chromeRuntime)

    await import('./service-worker')

    const handler = chromeRuntime.commands.onCommand.addListener.mock.calls[0]?.[0] as ((command: string) => Promise<void>) | undefined
    if (!handler) throw new Error('Expected a command handler')
    await handler('unknown-command')

    expect(saveUserSettings).not.toHaveBeenCalled()
    expect(chromeRuntime.tabs.sendMessage).not.toHaveBeenCalled()
  })
})
