import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeStorageAccess } from '@/storage/settings'
import { getGeminiProviderDayId } from './gemini-quota'

vi.mock('@/storage/settings', () => ({
  initializeStorageAccess: vi.fn(async () => undefined),
  getUserSettings: vi.fn(async () => ({
    selectedProvider: 'deepseek',
    selectedModel: 'deepseek-v4-flash',
    targetLanguage: 'zh-TW',
    speechConfig: {
      speechEnabled: true,
      speechProvider: 'gemini',
      speechModel: 'gemini-2.5-flash',
      speechTargetLanguage: 'zh-TW',
      captionMaxLines: 2,
      captionOpacity: 100,
      maxSessionMinutes: 30,
    },
  })),
  getApiKeyForServiceWorker: vi.fn(async () => undefined),
  getRuntimeState: vi.fn(async () => ({})),
  getChannelSettings: vi.fn(async () => undefined),
  mergeSettings: vi.fn((global: unknown) => global),
  saveApiKey: vi.fn(async () => undefined),
  deleteApiKey: vi.fn(async () => undefined),
  getMaskedApiKeyForPopup: vi.fn(async () => undefined),
  saveUserSettings: vi.fn(async () => undefined),
  getSpeechApiKeyForServiceWorker: vi.fn(async () => 'speech-key'),
}))

vi.mock('@/providers/registry', () => ({
  getProvider: vi.fn(() => undefined),
}))

vi.mock('@/providers/speech-registry', () => ({
  getSpeechProvider: vi.fn(() => ({
    id: 'gemini',
    displayName: 'Gemini',
    models: [],
    defaultModel: 'gemini-2.5-flash',
    transcribeChunk: vi.fn(async () => []),
    validateKey: vi.fn(async () => ({ valid: true })),
  })),
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

  it('ignores malformed settings updates without dereferencing their payload', async () => {
    const chromeRuntime = createChromeRuntime()
    vi.stubGlobal('chrome', chromeRuntime)

    await import('./service-worker')

    const handler = chromeRuntime.runtime.onMessage.addListener.mock.calls[0]?.[0] as
      | ((message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => boolean)
      | undefined

    if (!handler) {
      throw new Error('Expected a message handler to be registered')
    }

    expect(() => handler({ type: 'settings_updated', payload: null }, undefined, vi.fn())).not.toThrow()
    expect(() => handler({ type: 'settings_updated', payload: 'invalid' }, undefined, vi.fn())).not.toThrow()
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

  describe('privacy-safe counter aggregation (#60)', () => {
    const setup = async () => {
      const diagnosticsStorage = vi.fn(async (_value: unknown) => undefined)
      const sendMessage = vi.fn(async (_message: unknown) => undefined)
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
      if (!handler) throw new Error('Expected a message handler to be registered')
      return { diagnosticsStorage, sendMessage, handler }
    }

    const sendCounterEvent = (handler: (message: unknown, _s: unknown, r: (response: unknown) => void) => boolean, stage: string, count = 1) => {
      handler({ type: 'diagnostic_event', payload: { id: `c-${stage}-${Date.now()}`, stage, timestamp: Date.now(), count } }, undefined, vi.fn())
    }

    const getDiagnosticsSnapshot = async (handler: (message: unknown, _s: unknown, r: (response: unknown) => void) => boolean) => {
      const sendResponse = vi.fn()
      expect(handler({ type: 'get_diagnostics', payload: {} }, undefined, sendResponse)).toBe(true)
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1))
      const response = sendResponse.mock.calls[0]![0] as { type: string; payload: { events: Array<Record<string, unknown>> } }
      return response.payload.events
    }

    it('does not persist or broadcast counter events individually', async () => {
      const { diagnosticsStorage, sendMessage, handler } = await setup()

      // Counter events are privacy-safe aggregate signals. Each is just a
      // stage + count; even a burst must not spam storage or the Popup.
      for (const stage of ['batch_dedup_removed', 'queue_overflow_drop', 'queue_obsolete_drop', 'in_flight_coalesced', 'l2_cache_hit']) {
        sendCounterEvent(handler, stage)
      }

      await Promise.resolve()
      await Promise.resolve()

      expect(diagnosticsStorage).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('aggregates repeated counter events into one bounded count on get_diagnostics', async () => {
      const { diagnosticsStorage, sendMessage, handler } = await setup()

      // 7 overflow drops accumulate into a single bounded event.
      for (let i = 0; i < 7; i++) sendCounterEvent(handler, 'queue_overflow_drop')

      const events = await getDiagnosticsSnapshot(handler)

      const overflow = events.find((event) => event.stage === 'queue_overflow_drop')
      expect(overflow).toBeDefined()
      expect(overflow?.count).toBe(7)
      expect(events).toHaveLength(1)
      expect(diagnosticsStorage).toHaveBeenCalledWith(expect.objectContaining({ translationDiagnostics: expect.any(Array) }))
      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect((sendMessage.mock.calls[0]![0] as { payload: { events: Array<Record<string, unknown>> } }).payload.events).toHaveLength(1)
    })

    it('counters never carry chat text, usernames, channel names, or provider bodies', async () => {
      const { handler } = await setup()

      for (const stage of ['batch_dedup_removed', 'in_flight_coalesced', 'queue_overflow_drop', 'queue_obsolete_drop', 'l2_cache_hit']) {
        sendCounterEvent(handler, stage)
      }
      const events = await getDiagnosticsSnapshot(handler)

      const serialized = JSON.stringify(events)
      expect(serialized).not.toMatch(/private chat|@viewer|somechannel|sk-[a-z0-9_-]+|quota exhausted|你好/i)
      // Every counter event carries only stage, count, id, timestamp.
      for (const event of events) {
        expect(Object.keys(event).sort()).toEqual(['count', 'id', 'stage', 'timestamp'])
      }
    })

    it('keeps the diagnostics store bounded when many counter and lifecycle events arrive', async () => {
      const { diagnosticsStorage, handler } = await setup()

      // 100 counter events collapse to 4 aggregated events; mixed with
      // lifecycle events the store stays at MAX_DIAGNOSTICS (20).
      for (let i = 0; i < 100; i++) sendCounterEvent(handler, 'queue_overflow_drop')
      for (let i = 0; i < 40; i++) {
        handler({ type: 'diagnostic_event', payload: { id: `d-${i}`, stage: 'message_detected', timestamp: Date.now() + i } }, undefined, vi.fn())
      }

      const events = await getDiagnosticsSnapshot(handler)
      expect(events.length).toBeLessThanOrEqual(20)
      expect(diagnosticsStorage).toHaveBeenCalled()
      const stored = diagnosticsStorage.mock.calls[diagnosticsStorage.mock.calls.length - 1]?.[0] as { translationDiagnostics: Array<Record<string, unknown>> }
      expect(stored.translationDiagnostics.length).toBeLessThanOrEqual(20)
    })
  })

  it('responds to get_quota_health with a typed quota-health result', async () => {
    const chromeRuntime = {
      ...createChromeRuntime(),
      runtime: {
        ...createChromeRuntime().runtime,
        sendMessage: vi.fn(async () => undefined),
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
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

    const sendResponse = vi.fn()
    expect(handler({ type: 'get_quota_health', payload: {} }, undefined, sendResponse)).toBe(true)

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledTimes(1)
    })

    const response = sendResponse.mock.calls[0]![0] as { type: string; payload: unknown[] }
    expect(response.type).toBe('quota_health_result')
    expect(Array.isArray(response.payload)).toBe(true)
    const result = response.payload[0] as { status?: string; snapshotStatus?: string; quotaKey?: string }
    expect(result.quotaKey).toBe('default')
    expect(result.status).toBe('healthy')
    expect(result.snapshotStatus).toBe('missing')
    // The payload must never contain secrets, chat text, usernames, or channels.
    expect(JSON.stringify(response)).not.toMatch(/sk-[a-z0-9_-]+|sk-secret|private chat|@username/i)
  })

  it('resets quota accounting for reset_quota_health and returns a typed result', async () => {
    const wallNow = Date.now()
    const chromeRuntime = {
      ...createChromeRuntime(),
      runtime: {
        ...createChromeRuntime().runtime,
        sendMessage: vi.fn(async () => undefined),
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
        local: {
          get: vi.fn(async () => ({
            geminiQuotaUsage: {
              quotaVersion: 99,
              wallHighWaterMark: wallNow,
              clockTrusted: false,
              buckets: {
                default: {
                  reservations: [],
                  cooldownUntil: wallNow + 60_000,
                  providerDay: '2099-01-01',
                  requestsToday: 200,
                },
              },
            },
          })),
          set: vi.fn(async () => undefined),
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

    const sendResponse = vi.fn()
    expect(handler({ type: 'reset_quota_health', payload: { quotaKey: 'default' } }, undefined, sendResponse))
      .toBe(true)

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledTimes(1)
    })

    const response = sendResponse.mock.calls[0]![0] as {
      type: string
      payload: { ok: boolean; resetKeys: string[] }
    }
    expect(response.type).toBe('quota_health_reset_result')
    expect(response.payload.ok).toBe(true)
    expect(response.payload.resetKeys).toEqual(['default'])
    // The reset writes a clean, empty quota accounting snapshot.
    expect(chromeRuntime.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        geminiQuotaUsage: expect.objectContaining({ quotaVersion: 3, buckets: {} }),
      }),
    )
  })

  it('reports a requested model with no exact bucket as inheriting the legacy baseline cooldown', async () => {
    const wallNow = Date.now()
    const chromeRuntime = {
      ...createChromeRuntime(),
      runtime: {
        ...createChromeRuntime().runtime,
        sendMessage: vi.fn(async () => undefined),
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
        local: {
          get: vi.fn(async () => ({
            geminiQuotaUsage: {
              quotaVersion: 3,
              wallHighWaterMark: wallNow,
              clockTrusted: true,
              buckets: {},
              legacyBaseline: {
                reservations: [],
                cooldownUntil: wallNow + 3_600_000,
                providerDay: getGeminiProviderDayId(wallNow),
                requestsToday: 1,
              },
            },
          })),
          set: vi.fn(async () => undefined),
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

    const sendResponse = vi.fn()
    expect(handler({
      type: 'get_quota_health',
      payload: { quotaKey: 'gemini-2.5-flash' },
    }, undefined, sendResponse)).toBe(true)

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledTimes(1)
    })

    const response = sendResponse.mock.calls[0]![0] as { type: string; payload: unknown[] }
    expect(response.type).toBe('quota_health_result')
    expect(response.payload).toHaveLength(1)
    const result = response.payload[0] as { quotaKey: string; status: string; cooldownUntil?: number }
    expect(result.quotaKey).toBe('gemini-2.5-flash')
    expect(result.status).toBe('cooldown')
    expect(result.cooldownUntil).toBe(wallNow + 3_600_000)
  })

  it('reports a requested model with no exact bucket as inheriting a malformed legacy baseline', async () => {
    const wallNow = Date.now()
    const chromeRuntime = {
      ...createChromeRuntime(),
      runtime: {
        ...createChromeRuntime().runtime,
        sendMessage: vi.fn(async () => undefined),
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
        local: {
          get: vi.fn(async () => ({
            geminiQuotaUsage: {
              quotaVersion: 3,
              wallHighWaterMark: wallNow,
              clockTrusted: true,
              buckets: {},
              legacyBaseline: {
                reservations: 'corrupt',
                cooldownUntil: 0,
                providerDay: getGeminiProviderDayId(wallNow),
                requestsToday: 0,
              },
            },
          })),
          set: vi.fn(async () => undefined),
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

    const sendResponse = vi.fn()
    expect(handler({
      type: 'get_quota_health',
      payload: { quotaKey: 'gemini-2.5-pro' },
    }, undefined, sendResponse)).toBe(true)

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledTimes(1)
    })

    const response = sendResponse.mock.calls[0]![0] as { type: string; payload: unknown[] }
    expect(response.type).toBe('quota_health_result')
    expect(response.payload).toHaveLength(1)
    const result = response.payload[0] as { quotaKey: string; status: string }
    expect(result.quotaKey).toBe('gemini-2.5-pro')
    expect(result.status).toBe('malformed_snapshot')
  })

  describe('speech_control routing (#160)', () => {
    const createSpeechChrome = () => {
      const sendMessage = vi.fn(async () => undefined)
      const storageLocal: Record<string, unknown> = {}
      const storageSession: Record<string, unknown> = {}
      const chromeRuntime = {
        ...createChromeRuntime(),
        runtime: {
          ...createChromeRuntime().runtime,
          sendMessage,
        },
        storage: {
          local: {
            get: vi.fn(async (keys: string | string[] | Record<string, unknown> | null) => {
              if (typeof keys === 'string') return { [keys]: storageLocal[keys] }
              if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, storageLocal[k]]))
              return { ...storageLocal }
            }),
            set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(storageLocal, items) }),
          },
          session: {
            get: vi.fn(async (keys: string | string[] | Record<string, unknown> | null) => {
              if (typeof keys === 'string') return { [keys]: storageSession[keys] }
              if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, storageSession[k]]))
              return { ...storageSession }
            }),
            set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(storageSession, items) }),
          },
        },
        tabs: {
          query: vi.fn(async () => []),
          sendMessage,
        },
      }
      return { chromeRuntime, sendMessage }
    }

    it('routes speech_control start to the pipeline without throwing', async () => {
      const { chromeRuntime } = createSpeechChrome()
      vi.stubGlobal('chrome', chromeRuntime)

      await import('./service-worker')

      const handler = chromeRuntime.runtime.onMessage.addListener.mock.calls[0]?.[0] as
        | ((message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => boolean)
        | undefined
      if (!handler) throw new Error('Expected a message handler to be registered')

      // start must be routed (returns false = async fire-and-forget broadcast).
      const result = handler({ type: 'speech_control', payload: { action: 'start' } }, undefined, vi.fn())
      expect(result).toBe(false)

      // Give the pipeline's async start time to run without an unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    it('routes speech_control stop and toggle', async () => {
      const { chromeRuntime } = createSpeechChrome()
      vi.stubGlobal('chrome', chromeRuntime)

      await import('./service-worker')

      const handler = chromeRuntime.runtime.onMessage.addListener.mock.calls[0]?.[0] as
        | ((message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => boolean)
        | undefined
      if (!handler) throw new Error('Expected a message handler to be registered')

      expect(handler({ type: 'speech_control', payload: { action: 'stop' } }, undefined, vi.fn())).toBe(false)
      expect(handler({ type: 'speech_control', payload: { action: 'toggle', channelName: 'somechannel' } }, undefined, vi.fn())).toBe(false)

      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    it('rejects malformed speech_control payloads (falls through to the router)', async () => {
      const { chromeRuntime } = createSpeechChrome()
      vi.stubGlobal('chrome', chromeRuntime)

      await import('./service-worker')

      const handler = chromeRuntime.runtime.onMessage.addListener.mock.calls[0]?.[0] as
        | ((message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => boolean)
        | undefined
      if (!handler) throw new Error('Expected a message handler to be registered')

      // Unknown action is not a valid speech_control → not routed by the guard.
      const result = handler({ type: 'speech_control', payload: { action: 'banana' } }, undefined, vi.fn())
      expect(result).toBe(false)
    })
  })

  describe('speech settings routing (#174)', () => {
    it('forwards Popup speech settings updates to content scripts', async () => {
      const sendMessage = vi.fn(async () => undefined)
      const chromeRuntime = {
        ...createChromeRuntime(),
        tabs: {
          query: vi.fn(async () => [{ id: 42 }]),
          sendMessage,
        },
      }
      vi.stubGlobal('chrome', chromeRuntime)

      await import('./service-worker')

      const handler = chromeRuntime.runtime.onMessage.addListener.mock.calls[0]?.[0] as
        | ((message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => boolean)
        | undefined
      if (!handler) throw new Error('Expected a message handler to be registered')

      const payload = { speechTargetLanguage: 'ja', captionOpacity: 65 }
      expect(handler({ type: 'speech_settings_updated', payload }, undefined, vi.fn())).toBe(false)

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalledWith(42, {
          type: 'speech_settings_updated',
          payload,
        })
      })
    })
  })
})
