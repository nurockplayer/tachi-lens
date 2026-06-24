// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsUpdatePayload } from '@/shared/messages'

const stubDomGlobals = (): void => {
  vi.stubGlobal('document', {
    querySelector: vi.fn(() => null),
    body: {
      contains: vi.fn(() => false),
    },
    createElement: vi.fn(),
  })
  vi.stubGlobal('MutationObserver', vi.fn(() => ({
    observe: vi.fn(),
    disconnect: vi.fn(),
  })))
}

const createMockChrome = () => {
  const data: Record<string, unknown> = {
    userSettings: { translationEnabled: true, displayMode: 'below' },
  }

  return {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          if (typeof key === 'string') {
            return { [key]: data[key] }
          }
          return data
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(data, items)
        }),
      },
    },
    runtime: {
      onMessage: {
        addListener: vi.fn(),
      },
    },
  } as unknown as typeof chrome
}

describe('content script settings update', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads current user settings from local storage', async () => {
    stubDomGlobals()
    const chromeMock = createMockChrome()
    vi.stubGlobal('chrome', chromeMock)

    const { getSettings } = await import('./twitch-entry')
    const settings = await getSettings()

    expect(settings).toEqual({ translationEnabled: true, displayMode: 'below' })
    expect(chromeMock.storage.local.get).toHaveBeenCalledWith('userSettings')
  })

  it('updates settings in local storage when receiving settings_updated payload', async () => {
    stubDomGlobals()
    const chromeMock = createMockChrome()
    vi.stubGlobal('chrome', chromeMock)

    const { handleSettingsUpdate } = await import('./twitch-entry')
    const payload: SettingsUpdatePayload = { translationEnabled: false }
    await handleSettingsUpdate(payload)

    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      userSettings: { translationEnabled: false, displayMode: 'below' },
    })
  })

  it('merges payload with existing settings', async () => {
    stubDomGlobals()
    const chromeMock = createMockChrome()
    vi.stubGlobal('chrome', chromeMock)

    const { handleSettingsUpdate } = await import('./twitch-entry')
    await handleSettingsUpdate({ translationEnabled: false })

    const result = await chromeMock.storage.local.get('userSettings')
    expect(result.userSettings).toEqual({ translationEnabled: false, displayMode: 'below' })
  })

  it('handles empty existing settings gracefully', async () => {
    stubDomGlobals()
    const chromeMock = createMockChrome()
    chromeMock.storage.local.get = vi.fn(async () => ({}))
    vi.stubGlobal('chrome', chromeMock)

    const { handleSettingsUpdate } = await import('./twitch-entry')
    await handleSettingsUpdate({ displayMode: 'hover' })

    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      userSettings: { displayMode: 'hover' },
    })
  })
})
