import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_MODEL_POLICY } from '@/providers/model-policy'
import { MODEL_POLICY_REFRESH_INTERVAL_MS, MODEL_POLICY_STORAGE_KEY, ModelPolicyStore } from './model-policy-store'

const NOW = Date.parse('2026-09-27T12:00:00.000Z')

const testPolicy = () => ({
  schemaVersion: 1 as const,
  revision: 20,
  issuedAt: '2026-09-27T00:00:00.000Z',
  expiresAt: '2026-10-01T00:00:00.000Z',
  minimumClientVersion: '0.3.0',
  policies: [
    { provider: 'gemini' as const, workload: 'chat' as const, recommended: 'gemini-test-chat', fallbacks: ['gemini-test-legacy'], models: [{ id: 'gemini-test-chat', configuration: 'gemini-low-thinking' as const }, { id: 'gemini-test-legacy', configuration: 'default' as const }] },
    { provider: 'gemini' as const, workload: 'speech' as const, recommended: 'gemini-test-speech', fallbacks: ['gemini-test-legacy'], models: [{ id: 'gemini-test-speech', configuration: 'gemini-low-thinking' as const }, { id: 'gemini-test-legacy', configuration: 'default' as const }] },
    { provider: 'deepseek' as const, workload: 'chat' as const, recommended: 'deepseek-test-chat', fallbacks: ['deepseek-test-legacy'], models: [{ id: 'deepseek-test-chat', configuration: 'deepseek-disabled-thinking' as const }, { id: 'deepseek-test-legacy', configuration: 'deepseek-disabled-thinking' as const }] },
  ],
})

const createStorage = (initial: Record<string, unknown> = {}) => {
  const data = { ...initial }
  return {
    data,
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, items) }),
  }
}

const jsonResponse = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), { status: 200, ...init })

describe('ModelPolicyStore', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('fetches the fixed URL once and returns the validated remote policy', async () => {
    const storage = createStorage()
    const fetchFn = vi.fn(async () => jsonResponse({ ...testPolicy(), revision: 21 }))
    const store = new ModelPolicyStore({ storage, fetchFn, now: () => NOW, clientVersion: '0.3.3' })

    const [first, second] = await Promise.all([store.get(), store.get()])

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/raw\.githubusercontent\.com\/nurockplayer\/tachi-lens\/main\/public\/model-policy\.json$/), expect.objectContaining({ redirect: 'error' }))
    expect(first).toMatchObject({ source: 'remote', manifest: { revision: 21 } })
    expect(second).toEqual(first)
    expect(storage.set).toHaveBeenCalledWith({ [MODEL_POLICY_STORAGE_KEY]: expect.objectContaining({ attemptedAt: NOW }) })
  })

  it('defaults client compatibility to the packaged version', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ ...testPolicy(), revision: 21 }))
    const store = new ModelPolicyStore({ storage: createStorage(), fetchFn, now: () => NOW })

    await expect(store.get()).resolves.toMatchObject({ source: 'remote', manifest: { revision: 21 } })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('retains a remote result and refresh throttle in memory when storage fails', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ ...testPolicy(), revision: 21 }))
    const store = new ModelPolicyStore({
      storage: { get: async () => { throw new Error('read failed') }, set: async () => { throw new Error('write failed') } },
      fetchFn,
      now: () => NOW,
      clientVersion: '0.3.3',
    })

    const first = await store.get()
    const second = await store.get()
    expect(first).toMatchObject({ source: 'remote', manifest: { revision: 21 } })
    expect(second).toEqual(first)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('throttles another fetch across store instances and revalidates the cached LKG', async () => {
    const storage = createStorage()
    const firstFetch = vi.fn(async () => jsonResponse({ ...testPolicy(), revision: 21 }))
    await new ModelPolicyStore({ storage, fetchFn: firstFetch, now: () => NOW, clientVersion: '0.3.3' }).get()
    const secondFetch = vi.fn(async () => jsonResponse(testPolicy()))
    const second = await new ModelPolicyStore({ storage, fetchFn: secondFetch, now: () => NOW + 1, clientVersion: '0.3.3' }).get()

    expect(secondFetch).not.toHaveBeenCalled()
    expect(second).toMatchObject({ source: 'cached', manifest: { revision: 21 } })
    expect(MODEL_POLICY_REFRESH_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
  })

  it('keeps the previous LKG after an invalid remote response and persists the failed attempt', async () => {
    const storage = createStorage()
    const valid = new ModelPolicyStore({ storage, fetchFn: async () => jsonResponse({ ...testPolicy(), revision: 21 }), now: () => NOW, clientVersion: '0.3.3' })
    await valid.get()
    const invalid = new ModelPolicyStore({ storage, fetchFn: async () => jsonResponse({ ...testPolicy(), extra: 'no' }), now: () => NOW + MODEL_POLICY_REFRESH_INTERVAL_MS, clientVersion: '0.3.3' })

    await expect(invalid.get()).resolves.toMatchObject({ source: 'cached', manifest: { revision: 21 } })
    expect(storage.data[MODEL_POLICY_STORAGE_KEY]).toMatchObject({ attemptedAt: NOW + MODEL_POLICY_REFRESH_INTERVAL_MS })
  })

  it('refreshes when persisted attempt time is in the future', async () => {
    const storage = createStorage({
      [MODEL_POLICY_STORAGE_KEY]: { manifest: { ...testPolicy(), revision: 21 }, attemptedAt: NOW + 86_400_000 },
    })
    const fetchFn = vi.fn(async () => jsonResponse({ ...testPolicy(), revision: 22 }))
    const store = new ModelPolicyStore({ storage, fetchFn, now: () => NOW, clientVersion: '0.3.3' })

    await expect(store.get()).resolves.toMatchObject({ source: 'remote', manifest: { revision: 22 } })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('rejects an older remote revision and preserves the higher validated LKG', async () => {
    const storage = createStorage({
      [MODEL_POLICY_STORAGE_KEY]: { manifest: { ...testPolicy(), revision: 22 }, attemptedAt: NOW - MODEL_POLICY_REFRESH_INTERVAL_MS },
    })
    const store = new ModelPolicyStore({
      storage,
      fetchFn: async () => jsonResponse({ ...testPolicy(), revision: 21 }),
      now: () => NOW,
      clientVersion: '0.3.3',
    })

    await expect(store.get()).resolves.toMatchObject({ source: 'cached', manifest: { revision: 22 } })
    expect(storage.data[MODEL_POLICY_STORAGE_KEY]).toMatchObject({ manifest: { revision: 22 }, attemptedAt: NOW })
  })

  it('validates remote expiry at body completion time', async () => {
    let now = NOW
    const expiring = { ...testPolicy(), revision: 21, expiresAt: new Date(NOW + 1000).toISOString() }
    const payload = new TextEncoder().encode(JSON.stringify(expiring))
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        now = NOW + 1000
        controller.enqueue(payload)
        controller.close()
      },
    }))
    const store = new ModelPolicyStore({
      storage: createStorage(),
      fetchFn: async () => response,
      now: () => now,
      clientVersion: '0.3.3',
    })

    await expect(store.get()).resolves.toEqual({ source: 'bundled', manifest: BUNDLED_MODEL_POLICY })
  })

  it.each([false, true])('revalidates after delayed storage %s and preserves the prior LKG', async (rejectWrite) => {
    let now = NOW
    let releaseWrite: () => void = () => undefined
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const previous = { ...testPolicy(), revision: 19 }
    let failWriteOnce = rejectWrite
    const data: Record<string, unknown> = {
      [MODEL_POLICY_STORAGE_KEY]: { manifest: previous, attemptedAt: NOW - MODEL_POLICY_REFRESH_INTERVAL_MS },
    }
    const storage = {
      data,
      get: vi.fn(async (key: string) => ({ [key]: data[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        await writeGate
        Object.assign(data, items)
        if (failWriteOnce) {
          failWriteOnce = false
          throw new Error('delayed write failed')
        }
      }),
    }
    const remote = { ...testPolicy(), revision: 21, expiresAt: new Date(NOW + 1000).toISOString() }
    const store = new ModelPolicyStore({
      storage,
      fetchFn: async () => jsonResponse(remote),
      now: () => now,
      clientVersion: '0.3.3',
    })

    const resultPromise = store.get()
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalledTimes(1))
    now = NOW + 1000
    releaseWrite()
    await expect(resultPromise).resolves.toMatchObject({ source: 'cached', manifest: { revision: 19 } })
    expect(data[MODEL_POLICY_STORAGE_KEY]).toMatchObject({ manifest: { revision: 19 } })
  })

  it('rejects redirected, oversized, and slow responses and falls back to bundled policy', async () => {
    const redirectResponse = { ...jsonResponse(testPolicy()), redirected: true } as Response
    const redirectStore = new ModelPolicyStore({ storage: createStorage(), fetchFn: async () => redirectResponse, now: () => NOW, clientVersion: '0.3.3' })
    const tooLargeStore = new ModelPolicyStore({ storage: createStorage(), fetchFn: async () => new Response(' '.repeat(32 * 1024 + 1), { status: 200 }), now: () => NOW, clientVersion: '0.3.3' })
    const slowStore = new ModelPolicyStore({ storage: createStorage(), fetchFn: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))), now: () => NOW, clientVersion: '0.3.3' })

    expect((await redirectStore.get()).source).toBe('bundled')
    expect((await tooLargeStore.get()).source).toBe('bundled')
    await expect(slowStore.get()).resolves.toMatchObject({ source: 'bundled' })
  })

  it('uses the bundled policy when storage operations fail', async () => {
    const store = new ModelPolicyStore({
      storage: { get: async () => { throw new Error('storage unavailable') }, set: async () => { throw new Error('storage unavailable') } },
      fetchFn: async () => { throw new Error('offline') },
      now: () => NOW,
      clientVersion: '0.3.3',
    })

    await expect(store.get()).resolves.toEqual({ source: 'bundled', manifest: BUNDLED_MODEL_POLICY })
  })
})
