import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BatchItemResult } from '@/providers/types'
import { GeminiQuotaStore, type GeminiQuotaSettings, type QuotaStorage } from './gemini-quota'
import { QuotaScheduler, type ScheduledBatch, type SchedulerRequest } from './quota-scheduler'

const profile: GeminiQuotaSettings = {
  requestsPerMinute: 100,
  inputTokensPerMinute: 10_000,
  requestsPerDay: 100,
  rpmSafetyPercent: 100,
  tpmSafetyPercent: 100,
  rpdSafetyPercent: 100,
  liveMaxWaitMs: 1_000,
  maxConcurrency: 1,
}

const storage = (): QuotaStorage => {
  const session: Record<string, unknown> = {}
  const local: Record<string, unknown> = {}
  return {
    getSession: async () => session,
    setSession: async (value) => { Object.assign(session, value) },
    getLocal: async () => local,
    setLocal: async (value) => { Object.assign(local, value) },
  }
}

const batch = (id: string, priority: 'live' | 'backlog', overrides: Partial<ScheduledBatch> = {}): ScheduledBatch => ({
  id,
  priority,
  requests: [{ id, text: id }],
  estimatedInputTokens: 1,
  profile,
  geminiAvailable: true,
  runGemini: vi.fn(async (requests: SchedulerRequest[]) => requests.map((request) => ({ id: request.id, translatedText: `g-${request.id}` }))),
  runDeepSeek: vi.fn(async (requests: SchedulerRequest[]) => requests.map((request) => ({ id: request.id, translatedText: `d-${request.id}` }))),
  ...overrides,
})

describe('QuotaScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('routes initial backlog directly to DeepSeek when only one Gemini reservation is available', async () => {
    const limited = { ...profile, requestsPerMinute: 1 }
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const batches = Array.from({ length: 5 }, (_, index) => batch(`b${index}`, 'backlog', { profile: limited }))

    const results = await Promise.all(batches.map((entry) => scheduler.schedule(entry)))

    expect(batches.filter((entry) => vi.mocked(entry.runGemini).mock.calls.length === 1)).toHaveLength(1)
    expect(batches.filter((entry) => vi.mocked(entry.runDeepSeek).mock.calls.length === 1)).toHaveLength(4)
    expect(results.flatMap((result) => result.results)).toHaveLength(5)
  })

  it('marks provider as gemini when DeepSeek fallback returns auth error', async () => {
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const request = batch('msg', 'live', {
      runGemini: vi.fn(async () => [{ id: 'msg', status: 429, error: 'quota' }]),
      runDeepSeek: vi.fn(async () => [{ id: 'msg', error: 'DeepSeek auth error', errorType: 'auth' as const }]),
    })

    const result = await scheduler.schedule(request)

    expect(result.results[0]!.translatedText).toBeUndefined()
    expect(result.providers.get('msg')).toBe('gemini')
    expect(request.runGemini).toHaveBeenCalledTimes(1)
    expect(request.runDeepSeek).toHaveBeenCalledTimes(1)
  })

  it('marks provider as gemini when DeepSeek fallback returns bad_request error', async () => {
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const request = batch('msg', 'live', {
      runGemini: vi.fn(async () => [{ id: 'msg', status: 429, error: 'quota' }]),
      runDeepSeek: vi.fn(async () => [{ id: 'msg', error: 'DeepSeek bad request', errorType: 'bad_request' as const }]),
    })

    const result = await scheduler.schedule(request)

    expect(result.results[0]!.translatedText).toBeUndefined()
    expect(result.providers.get('msg')).toBe('gemini')
    expect(request.runGemini).toHaveBeenCalledTimes(1)
    expect(request.runDeepSeek).toHaveBeenCalledTimes(1)
  })

  it('marks provider as deepseek when DeepSeek fallback succeeds', async () => {
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const request = batch('msg', 'live', {
      runGemini: vi.fn(async () => [{ id: 'msg', status: 429, error: 'quota' }]),
      runDeepSeek: vi.fn(async () => [{ id: 'msg', translatedText: 'd-msg' }]),
    })

    const result = await scheduler.schedule(request)

    expect(result.results[0]!.translatedText).toBe('d-msg')
    expect(result.providers.get('msg')).toBe('deepseek')
  })

  it('uses DeepSeek for a genuine Gemini 429 and does not probe Gemini during the resulting cooldown', async () => {
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const first = batch('first', 'live', {
      runGemini: vi.fn(async (requests: SchedulerRequest[]) => requests.map((request) => ({ id: request.id, status: 429, error: 'quota', retryAfterMs: 5_000 }))),
    })

    await expect(scheduler.schedule(first)).resolves.toMatchObject({ results: [{ translatedText: 'd-first' }] })

    const second = batch('second', 'live')
    await expect(scheduler.schedule(second)).resolves.toMatchObject({ results: [{ translatedText: 'd-second' }] })
    expect(second.runGemini).not.toHaveBeenCalled()
    expect(second.runDeepSeek).toHaveBeenCalledTimes(1)
  })

  it('reports clock_rollback as a bounded denial while overflowing to DeepSeek', async () => {
    let wallNow = 10_000
    const clock = {
      wallNow: () => wallNow,
      monotonicNow: () => 1_000,
    }
    const store = new GeminiQuotaStore(storage(), clock)
    await store.getUsage()
    const scheduler = new QuotaScheduler(store, { clock })

    wallNow -= 1
    const overflow = batch('during-rollback', 'backlog')
    const result = await scheduler.schedule(overflow)

    expect(result).toMatchObject({
      quotaDenial: 'clock_rollback',
      results: [{ translatedText: 'd-during-rollback' }],
    })
    expect(overflow.runGemini).not.toHaveBeenCalled()
    expect(overflow.runDeepSeek).toHaveBeenCalledTimes(1)
  })

  it('bounds DeepSeek dispatches to the configured concurrency', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { deepseekMaxConcurrency: 2, now: () => 1_000 })
    const unavailable = { geminiAvailable: false, runDeepSeek: vi.fn(async (requests: SchedulerRequest[]) => { await held; return requests.map((request) => ({ id: request.id, translatedText: request.id })) }) }
    const batches = ['a', 'b', 'c'].map((id) => batch(id, 'backlog', unavailable))

    const pending = batches.map((entry) => scheduler.schedule(entry))
    await vi.waitFor(() => expect(unavailable.runDeepSeek).toHaveBeenCalledTimes(2))
    release()
    await Promise.all(pending)

    expect(unavailable.runDeepSeek).toHaveBeenCalledTimes(3)
  })

  it('isolates Gemini concurrency per quotaKey', async () => {
    let releaseA!: () => void
    const heldA = new Promise<void>((resolve) => { releaseA = resolve })
    const runGemini = vi.fn(async (requests: SchedulerRequest[]) => {
      await heldA
      return requests.map((request) => ({ id: request.id, translatedText: `g-${request.id}` }))
    })
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const profileA = { ...profile, maxConcurrency: 1 }
    const profileB = { ...profile, maxConcurrency: 1 }
    const modelA = batch('model-a', 'backlog', { profile: profileA, quotaKey: 'model-a', runGemini })
    const modelB = batch('model-b', 'backlog', { profile: profileB, quotaKey: 'model-b', runGemini })

    const firstResult = scheduler.schedule(modelA)
    await vi.waitFor(() => expect(runGemini).toHaveBeenCalledTimes(1))
    const secondResult = scheduler.schedule(modelB)
    await vi.waitFor(() => expect(runGemini).toHaveBeenCalledTimes(2))
    expect(modelB.runDeepSeek).not.toHaveBeenCalled()

    releaseA()
    await expect(Promise.all([firstResult, secondResult])).resolves.toHaveLength(2)
  })

  it('enforces Gemini maxConcurrency independently of available RPM', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const runGemini = vi.fn(async (requests: SchedulerRequest[]) => {
      await held
      return requests.map((request) => ({ id: request.id, translatedText: request.id }))
    })
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const first = batch('first', 'backlog', { runGemini })
    const second = batch('second', 'backlog', { runGemini })

    const firstResult = scheduler.schedule(first)
    const secondResult = scheduler.schedule(second)
    await vi.waitFor(() => expect(runGemini).toHaveBeenCalledTimes(1))
    await expect(secondResult).resolves.toMatchObject({ results: [{ translatedText: 'd-second' }] })
    expect(second.runDeepSeek).toHaveBeenCalledTimes(1)

    release()
    await expect(firstResult).resolves.toMatchObject({ results: [{ translatedText: 'first' }] })
  })

  it('waits for a DeepSeek capacity signal without recursively draining live overflow', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const runDeepSeek = vi.fn(async (requests: SchedulerRequest[]) => {
      await held
      return requests.map((request) => ({ id: request.id, translatedText: request.id }))
    })
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage()), { deepseekMaxConcurrency: 2 })
    const settlements = new Map<string, number>()
    const pending = ['a', 'b', 'c'].map((id) => scheduler.schedule(batch(id, 'live', {
      geminiAvailable: false,
      runDeepSeek,
    })).then((result) => {
      settlements.set(id, (settlements.get(id) ?? 0) + 1)
      return result
    }))

    await vi.waitFor(() => expect(runDeepSeek).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runDeepSeek).toHaveBeenCalledTimes(2)

    release()
    await expect(Promise.all(pending)).resolves.toHaveLength(3)
    expect(runDeepSeek).toHaveBeenCalledTimes(3)
    expect([...settlements.values()]).toEqual([1, 1, 1])
  })

  it('enforces a persisted Gemini cooldown when a legacy batch has no quota profile', async () => {
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const first = batch('first', 'live', {
      profile: undefined,
      runGemini: vi.fn(async () => [{ id: 'first', status: 429, error: 'quota', retryAfterMs: 5_000 }]),
    })
    await scheduler.schedule(first)

    const second = batch('second', 'live', { profile: undefined })
    await scheduler.schedule(second)

    expect(second.runGemini).not.toHaveBeenCalled()
    expect(second.runDeepSeek).toHaveBeenCalledTimes(1)
  })

  it.each(['get', 'set'] as const)('routes to DeepSeek and resolves when quota storage %s rejects', async (failure) => {
    const failingStorage = storage()
    if (failure === 'get') failingStorage.getLocal = async () => { throw new Error('local get failed') }
    else failingStorage.setLocal = async () => { throw new Error('local set failed') }
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(failingStorage, () => 1_000), { now: () => 1_000 })
    const request = batch(failure, 'live')

    await expect(scheduler.schedule(request)).resolves.toMatchObject({
      results: [{ translatedText: `d-${failure}` }],
    })
    expect(request.runDeepSeek).toHaveBeenCalledTimes(1)
  })

  it('rolls back a transient failed reservation so the next batch can use Gemini', async () => {
    const session: Record<string, unknown> = {}
    const local: Record<string, unknown> = {}
    let failLocalWrite = true
    const store = new GeminiQuotaStore({
      getSession: async () => session,
      setSession: async (value) => { Object.assign(session, value) },
      getLocal: async () => local,
      setLocal: async (value) => {
        if (failLocalWrite) {
          failLocalWrite = false
          throw new Error('transient local write failure')
        }
        Object.assign(local, value)
      },
    }, () => 1_000)
    const scheduler = new QuotaScheduler(store, { now: () => 1_000 })
    const limited = { ...profile, requestsPerMinute: 1 }
    const first = batch('first', 'backlog', { profile: limited })
    const second = batch('second', 'backlog', { profile: limited })

    await scheduler.schedule(first)
    await scheduler.schedule(second)

    expect(first.runDeepSeek).toHaveBeenCalledTimes(1)
    expect(second.runGemini).toHaveBeenCalledTimes(1)
  })

  it('gives newly arrived live work a reservation before backlog awaiting storage', async () => {
    let releaseLoad!: () => void
    const loadHeld = new Promise<void>((resolve) => { releaseLoad = resolve })
    const session: Record<string, unknown> = {}
    const local: Record<string, unknown> = {}
    const store = new GeminiQuotaStore({
      getSession: async () => { await loadHeld; return session },
      setSession: async (value) => { Object.assign(session, value) },
      getLocal: async () => local,
      setLocal: async (value) => { Object.assign(local, value) },
    }, () => 1_000)
    const scheduler = new QuotaScheduler(store, { now: () => 1_000 })
    const limited = { ...profile, requestsPerMinute: 1 }
    const backlog = batch('backlog', 'backlog', { profile: limited })
    const live = batch('live', 'live', { profile: limited })

    const backlogResult = scheduler.schedule(backlog)
    await Promise.resolve()
    const liveResult = scheduler.schedule(live)
    releaseLoad()
    await Promise.all([backlogResult, liveResult])

    expect(live.runGemini).toHaveBeenCalledTimes(1)
    expect(backlog.runGemini).not.toHaveBeenCalled()
    expect(backlog.runDeepSeek).toHaveBeenCalledTimes(1)
  })

  it('uses DeepSeek for bounded backlog fairness while live work keeps Gemini priority', async () => {
    const wideProfile = { ...profile, maxConcurrency: 10 }
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const backlog = batch('backlog', 'backlog', { profile: wideProfile })
    const live = Array.from({ length: 4 }, (_, index) =>
      batch(`live-${index}`, 'live', { profile: wideProfile }),
    )

    await Promise.all([
      scheduler.schedule(backlog),
      ...live.map((entry) => scheduler.schedule(entry)),
    ])

    expect(live.every((entry) => vi.mocked(entry.runGemini).mock.calls.length === 1)).toBe(true)
    expect(backlog.runGemini).not.toHaveBeenCalled()
    expect(backlog.runDeepSeek).toHaveBeenCalledTimes(1)
  })

  it('does not refill Gemini ahead of a restrictive live capacity waiter', async () => {
    let releaseHolder!: () => void
    const held = new Promise<void>((resolve) => { releaseHolder = resolve })
    const highConcurrency = { ...profile, maxConcurrency: 3 }
    const restrictive = { ...profile, maxConcurrency: 1 }
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const holder = batch('holder', 'live', {
      profile: highConcurrency,
      runGemini: vi.fn(async (requests: SchedulerRequest[]) => {
        await held
        return requests.map((request) => ({ id: request.id, translatedText: `g-${request.id}` }))
      }),
    })
    const liveWaiter = batch('live-waiter', 'live', { profile: restrictive })
    const backlog = batch('backlog', 'backlog', { profile: highConcurrency })

    const holderResult = scheduler.schedule(holder)
    await vi.waitFor(() => expect(holder.runGemini).toHaveBeenCalledTimes(1))
    const liveResult = scheduler.schedule(liveWaiter)
    const backlogResult = scheduler.schedule(backlog)
    await vi.waitFor(() => expect(backlog.runDeepSeek).toHaveBeenCalledTimes(1))

    expect(backlog.runGemini).not.toHaveBeenCalled()
    expect(liveWaiter.runGemini).not.toHaveBeenCalled()

    releaseHolder()
    await expect(Promise.all([holderResult, liveResult, backlogResult])).resolves.toHaveLength(3)
    expect(liveWaiter.runGemini).toHaveBeenCalledTimes(1)
  })

  it('overflows an expired live batch while Gemini remains hung', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const never = new Promise<BatchItemResult[]>(() => undefined)
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => now), { now: () => now })
    const first = batch('first', 'live', { runGemini: vi.fn(() => never) })
    void scheduler.schedule(first)
    await vi.advanceTimersByTimeAsync(0)

    const second = batch('second', 'live')
    const result = scheduler.schedule(second)
    now += profile.liveMaxWaitMs + 1
    await vi.advanceTimersByTimeAsync(profile.liveMaxWaitMs + 1)

    await expect(result).resolves.toMatchObject({ results: [{ translatedText: 'd-second' }] })
    expect(second.runGemini).not.toHaveBeenCalled()
    expect(second.runDeepSeek).toHaveBeenCalledTimes(1)
  })

  it('keeps a live deadline on monotonic elapsed time when wall time moves backward', async () => {
    vi.useFakeTimers()
    let wallNow = 1_000
    let monotonicNow = 1_000
    const clock = {
      wallNow: () => wallNow,
      monotonicNow: () => monotonicNow,
    }
    const never = new Promise<BatchItemResult[]>(() => undefined)
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), clock), {
      clock,
    })
    const holder = batch('holder', 'live', { runGemini: vi.fn(() => never) })
    void scheduler.schedule(holder)
    await vi.advanceTimersByTimeAsync(0)

    const waiting = batch('waiting', 'live')
    let settled = false
    void scheduler.schedule(waiting).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)

    wallNow -= 60_000
    monotonicNow += profile.liveMaxWaitMs
    await vi.advanceTimersByTimeAsync(profile.liveMaxWaitMs)

    expect(settled).toBe(true)
    expect(waiting.runGemini).not.toHaveBeenCalled()
    expect(waiting.runDeepSeek).toHaveBeenCalledTimes(1)
  })

  it('does not apply the quota-wait deadline to an admitted Gemini request', async () => {
    vi.useFakeTimers()
    let now = 1_000
    let receivedSignal: AbortSignal | undefined
    let resolveGemini!: (results: BatchItemResult[]) => void
    const heldGemini = new Promise<BatchItemResult[]>((resolve) => { resolveGemini = resolve })
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => now), {
      now: () => now,
      providerTimeoutMs: 30_000,
    })
    const request = batch('in-flight', 'live', {
      runGemini: vi.fn((...args: unknown[]) => {
        receivedSignal = args[1] as AbortSignal | undefined
        return heldGemini
      }),
    })
    const result = scheduler.schedule(request)
    await vi.advanceTimersByTimeAsync(0)

    now += profile.liveMaxWaitMs
    await vi.advanceTimersByTimeAsync(profile.liveMaxWaitMs)

    expect(request.runGemini).toHaveBeenCalledTimes(1)
    expect(request.runDeepSeek).not.toHaveBeenCalled()
    expect(receivedSignal?.aborted).toBe(false)

    resolveGemini([{ id: 'in-flight', translatedText: 'g-in-flight' }])
    await expect(result).resolves.toMatchObject({ results: [{ translatedText: 'g-in-flight' }] })
  })

  it('releases a quota reservation when storage delay carries a live batch past its deadline', async () => {
    let now = 1_000
    let releaseLoad!: () => void
    const loadHeld = new Promise<void>((resolve) => { releaseLoad = resolve })
    const session: Record<string, unknown> = {}
    const local: Record<string, unknown> = {}
    const store = new GeminiQuotaStore({
      getSession: async () => { await loadHeld; return session },
      setSession: async (value) => { Object.assign(session, value) },
      getLocal: async () => local,
      setLocal: async (value) => { Object.assign(local, value) },
    }, () => now)
    const scheduler = new QuotaScheduler(store, { now: () => now })
    const request = batch('expired', 'live')
    const result = scheduler.schedule(request)
    await Promise.resolve()
    now += profile.liveMaxWaitMs + 1
    releaseLoad()

    await expect(result).resolves.toMatchObject({ results: [{ translatedText: 'd-expired' }] })
    await expect(store.getUsage()).resolves.toMatchObject({ rollingRequests: 0, requestsToday: 0 })
  })

  it('routes backlog to DeepSeek without re-reserving Gemini when quota.release fails after a successful reservation', async () => {
    let releaseLoad!: () => void
    const loadHeld = new Promise<void>((resolve) => { releaseLoad = resolve })
    let setCount = 0
    const session: Record<string, unknown> = {}
    const local: Record<string, unknown> = {}
    const store = new GeminiQuotaStore({
      getSession: async () => { await loadHeld; return session },
      setSession: async () => {},
      getLocal: async () => local,
      setLocal: async (value) => {
        setCount++
        // 1st setLocal = reserve persist (succeeds).
        // 2nd setLocal = release persist (fails).
        if (setCount === 2) throw new Error('release persist failed')
        Object.assign(local, value)
      },
    }, () => 1_000)
    const reserveSpy = vi.spyOn(store, 'reserve')
    // Ample RPM + concurrency: a later reserve WOULD succeed if called.
    const ample = { ...profile, requestsPerMinute: 2, maxConcurrency: 2 }
    const scheduler = new QuotaScheduler(store, { now: () => 1_000 })
    const backlog = batch('backlog', 'backlog', { profile: ample })
    const live = batch('live', 'live', { profile: ample })

    const backlogResult = scheduler.schedule(backlog)
    await Promise.resolve()
    const liveResult = scheduler.schedule(live)
    releaseLoad()
    const [backlogR, liveR] = await Promise.all([backlogResult, liveResult])

    // Backlog must route to DeepSeek — don't re-reserve after failed release.
    expect(backlogR.results).toMatchObject([{ translatedText: 'd-backlog' }])
    expect(backlogR.providers.get('backlog')).toBe('deepseek')
    expect(backlog.runGemini).not.toHaveBeenCalled()
    expect(backlog.runDeepSeek).toHaveBeenCalledTimes(1)

    // Live batch uses Gemini normally.
    expect(liveR.results).toMatchObject([{ translatedText: 'g-live' }])
    expect(live.runGemini).toHaveBeenCalledTimes(1)
    expect(live.runDeepSeek).not.toHaveBeenCalled()

    // Reserve called exactly twice: backlog + live. No third call for backlog.
    expect(reserveSpy).toHaveBeenCalledTimes(2)

    // Exactly-once settlement.
    expect(backlogR.results).toHaveLength(1)
    expect(liveR.results).toHaveLength(1)
  })

  it('synthesizes retryable Gemini rate-limit result when quota denial and DeepSeek fallback returns auth', async () => {
    const quotaProfile = { ...profile, requestsPerMinute: 1, rpmSafetyPercent: 100 }
    const store = new GeminiQuotaStore(storage(), () => 1_000)
    await store.reserve(quotaProfile, 1, 'default')
    const scheduler = new QuotaScheduler(store, { now: () => 1_000 })
    const request = batch('quota-denied', 'backlog', {
      profile: quotaProfile,
      geminiAvailable: true,
      runDeepSeek: vi.fn(async () => [{ id: 'quota-denied', error: 'DeepSeek auth error', errorType: 'auth' as const }]),
    })

    const result = await scheduler.schedule(request)

    expect(result.quotaDenial).toBe('rpm')
    expect(result.results[0]!.status).toBe(429)
    expect(result.results[0]!.errorType).toBe('rate_limited')
    expect(result.providers.get('quota-denied')).toBe('gemini')
    expect(request.runGemini).not.toHaveBeenCalled()
    expect(request.runDeepSeek).toHaveBeenCalledTimes(1)
  })

  it('synthesizes retryable Gemini rate-limit result when quota denial and DeepSeek fallback returns bad_request', async () => {
    const quotaProfile = { ...profile, requestsPerMinute: 1, rpmSafetyPercent: 100 }
    const store = new GeminiQuotaStore(storage(), () => 1_000)
    await store.reserve(quotaProfile, 1, 'default')
    const scheduler = new QuotaScheduler(store, { now: () => 1_000 })
    const request = batch('quota-denied', 'backlog', {
      profile: quotaProfile,
      geminiAvailable: true,
      runDeepSeek: vi.fn(async () => [{ id: 'quota-denied', error: 'DeepSeek bad request', errorType: 'bad_request' as const }]),
    })

    const result = await scheduler.schedule(request)

    expect(result.quotaDenial).toBe('rpm')
    expect(result.results[0]!.status).toBe(429)
    expect(result.results[0]!.errorType).toBe('rate_limited')
    expect(result.providers.get('quota-denied')).toBe('gemini')
    expect(request.runGemini).not.toHaveBeenCalled()
  })

  it('preserves DeepSeek fallback success when quota denial is set', async () => {
    const quotaProfile = { ...profile, requestsPerMinute: 1, rpmSafetyPercent: 100 }
    const store = new GeminiQuotaStore(storage(), () => 1_000)
    await store.reserve(quotaProfile, 1, 'default')
    const scheduler = new QuotaScheduler(store, { now: () => 1_000 })
    const request = batch('quota-fallback-ok', 'backlog', {
      profile: quotaProfile,
      geminiAvailable: true,
      runDeepSeek: vi.fn(async () => [{ id: 'quota-fallback-ok', translatedText: 'd-fallback' }]),
    })

    const result = await scheduler.schedule(request)

    expect(result.results[0]!.translatedText).toBe('d-fallback')
    expect(result.providers.get('quota-fallback-ok')).toBe('deepseek')
    expect(request.runGemini).not.toHaveBeenCalled()
  })

  it('synthesizes retryable Gemini rate-limit with live batch when quota denial and DeepSeek fallback returns auth', async () => {
    const quotaProfile = { ...profile, requestsPerMinute: 1, rpmSafetyPercent: 100, liveMaxWaitMs: 5_000 }
    const store = new GeminiQuotaStore(storage(), () => 1_000)
    await store.reserve(quotaProfile, 1, 'default')
    const scheduler = new QuotaScheduler(store, { now: () => 1_000 })
    const request = batch('live-quota-denied', 'live', {
      profile: quotaProfile,
      geminiAvailable: true,
      runDeepSeek: vi.fn(async () => [{ id: 'live-quota-denied', error: 'DeepSeek auth error', errorType: 'auth' as const }]),
    })

    const result = await scheduler.schedule(request)

    expect(result.results[0]!.status).toBe(429)
    expect(result.results[0]!.errorType).toBe('rate_limited')
    expect(result.providers.get('live-quota-denied')).toBe('gemini')
    expect(request.runGemini).not.toHaveBeenCalled()
  })

  it('synthesizes retryable Gemini rate-limit result with retry timing from quota denial nextAvailableAt', async () => {
    const now = 1_000
    const quotaProfile = { ...profile, requestsPerMinute: 1, rpmSafetyPercent: 100 }
    const store = new GeminiQuotaStore(storage(), () => now)
    // Consume the single RPM slot -> oldest reservation expires at now + ROLLING_WINDOW_MS = 61_000
    await store.reserve(quotaProfile, 1, 'default')
    const scheduler = new QuotaScheduler(store, { now: () => now })
    const request = batch('get-retry-timing', 'backlog', {
      profile: quotaProfile,
      geminiAvailable: true,
      runDeepSeek: vi.fn(async () => [{ id: 'get-retry-timing', error: 'DeepSeek auth error', errorType: 'auth' as const }]),
    })

    const result = await scheduler.schedule(request)

    // nextAvailableAt from RPM denial = 61_000. Now = 1_000. Timing = 60_000.
    expect(result.quotaDenial).toBe('rpm')
    expect(result.results[0]!.status).toBe(429)
    expect(result.results[0]!.errorType).toBe('rate_limited')
    expect(result.results[0]!.retryAfterMs).toBe(60_000)
    expect(result.providers.get('get-retry-timing')).toBe('gemini')
  })

  it('synthesizes retryable Gemini rate-limit on deadline expiry when DeepSeek fallback returns auth', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const never = new Promise<BatchItemResult[]>(() => undefined)
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => now), { now: () => now })
    const holder = batch('holder', 'live', { runGemini: vi.fn(() => never) })
    void scheduler.schedule(holder)
    await vi.advanceTimersByTimeAsync(0)

    const expired = batch('expired', 'live', {
      runDeepSeek: vi.fn(async () => [{ id: 'expired', error: 'DeepSeek auth error', errorType: 'auth' as const }]),
    })
    const result = scheduler.schedule(expired)
    now += profile.liveMaxWaitMs + 1
    await vi.advanceTimersByTimeAsync(profile.liveMaxWaitMs + 1)

    const settled = await result
    expect(settled.results[0]!.status).toBe(429)
    expect(settled.results[0]!.errorType).toBe('rate_limited')
    expect(settled.results[0]!.retryAfterMs).toBe(30_000)
    expect(settled.providers.get('expired')).toBe('gemini')
    expect(expired.runGemini).not.toHaveBeenCalled()
  })

  it('synthesizes retryable Gemini rate-limit when Gemini unavailable and DeepSeek fallback returns auth', async () => {
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const request = batch('ds-auth', 'backlog', {
      geminiAvailable: false,
      runDeepSeek: vi.fn(async () => [{ id: 'ds-auth', error: 'DeepSeek auth error', errorType: 'auth' as const }]),
    })

    const result = await scheduler.schedule(request)

    expect(result.results[0]!.status).toBe(429)
    expect(result.results[0]!.errorType).toBe('rate_limited')
    expect(result.results[0]!.retryAfterMs).toBe(30_000)
    expect(result.providers.get('ds-auth')).toBe('gemini')
    expect(request.runGemini).not.toHaveBeenCalled()
  })

  it('synthesizes retryable Gemini rate-limit when Gemini unavailable and DeepSeek fallback returns bad_request', async () => {
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const request = batch('ds-bad', 'backlog', {
      geminiAvailable: false,
      runDeepSeek: vi.fn(async () => [{ id: 'ds-bad', error: 'DeepSeek bad request', errorType: 'bad_request' as const }]),
    })

    const result = await scheduler.schedule(request)

    expect(result.results[0]!.status).toBe(429)
    expect(result.results[0]!.errorType).toBe('rate_limited')
    expect(result.providers.get('ds-bad')).toBe('gemini')
    expect(request.runGemini).not.toHaveBeenCalled()
  })

  it('preserves DeepSeek fallback success when Gemini is unavailable', async () => {
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const request = batch('ds-ok', 'backlog', {
      geminiAvailable: false,
      runDeepSeek: vi.fn(async () => [{ id: 'ds-ok', translatedText: 'd-ok' }]),
    })

    const result = await scheduler.schedule(request)

    expect(result.results[0]!.translatedText).toBe('d-ok')
    expect(result.providers.get('ds-ok')).toBe('deepseek')
    expect(request.runGemini).not.toHaveBeenCalled()
  })

  it('preserves DeepSeek fallback network error when Gemini is unavailable', async () => {
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const request = batch('ds-net', 'backlog', {
      geminiAvailable: false,
      runDeepSeek: vi.fn(async () => [{ id: 'ds-net', error: 'DeepSeek network error', errorType: 'network' as const }]),
    })

    const result = await scheduler.schedule(request)

    expect(result.results[0]!.errorType).toBe('network')
    expect(result.providers.get('ds-net')).toBe('deepseek')
    expect(request.runGemini).not.toHaveBeenCalled()
  })

  it('deferred capacity waiter reserves the same-key slot so backlog cannot overtake', async () => {
    let releaseHolder!: () => void
    const holderPending = new Promise<void>((resolve) => { releaseHolder = resolve })
    let unblockPersist!: () => void
    const persistGate = new Promise<void>((resolve) => { unblockPersist = resolve })
    let setLocalCalls = 0
    const session: Record<string, unknown> = {}
    const local: Record<string, unknown> = {}
    const gatedStorage: QuotaStorage = {
      getSession: async () => session,
      setSession: async (v) => { Object.assign(session, v) },
      getLocal: async () => local,
      setLocal: async (v) => {
        setLocalCalls++
        // H's reserve ⇒ setLocal #1. Bridge's reserve ⇒ setLocal #2 ⇒ gate.
        if (setLocalCalls === 2) await persistGate
        Object.assign(local, v)
      },
    }
    const store = new GeminiQuotaStore(gatedStorage, () => 1_000)
    const scheduler = new QuotaScheduler(store, { now: () => 1_000 })
    const limited = { ...profile, maxConcurrency: 1 }
    const H = batch('holder', 'live', {
      profile: limited,
      runGemini: vi.fn(async () => {
        await holderPending
        return [{ id: 'holder', translatedText: 'g-holder' }]
      }),
    })
    const L1 = batch('deferred-waiter', 'live', { profile: limited })
    const Bridge = batch('bridge', 'live', { profile: limited, quotaKey: 'other-model' })
    const B = batch('backlog', 'backlog', { profile: limited })

    // Step 1: H starts Gemini and stays in-flight.
    scheduler.schedule(H)
    await vi.waitFor(() => expect(H.runGemini).toHaveBeenCalledTimes(1))

    // Step 2: Schedule L1, Bridge, B. Drain evaluates:
    //   L1 → hasGeminiCapacity false (H same-key in-flight) → capacityDeferred
    //   Bridge → hasGeminiCapacity true (different key) → reserve → persist gated
    scheduler.schedule(L1)
    scheduler.schedule(Bridge)
    scheduler.schedule(B)

    // Step 3: Wait until Bridge hits the persist gate.
    await vi.waitFor(() => expect(setLocalCalls).toBe(2))

    // Step 4: Release H while Bridge's persist is gated.
    // H's runGemini resolves → .then settles H → .finally removes from inFlight.
    releaseHolder()

    // Step 5: Unblock Bridge's persist → Bridge starts Gemini → drain continues to B.
    // hasGeminiCapacity(B): inFlight=[Bridge] (different key), capacityDeferred=[L1] (same key)
    // OLD (sameKeyInFlight.length < providerLimit): 0 < 1 → true → B takes Gemini (BUG)
    // NEW (sameKeyInFlight.length + sameKeyDeferred.length < providerLimit): 0+1 < 1 → false → B→DeepSeek
    unblockPersist()

    await vi.waitFor(() => {
      expect(B.runGemini).not.toHaveBeenCalled()
      expect(B.runDeepSeek).toHaveBeenCalledTimes(1)
    })
    // L1 gets Gemini in the subsequent drain.
    await vi.waitFor(() => expect(L1.runGemini).toHaveBeenCalledTimes(1))
  })

  it('isolates live quota waiter check by quotaKey so an unrelated backlog uses Gemini', async () => {
    const flashProfile = { ...profile, requestsPerMinute: 1, rpmSafetyPercent: 100, maxConcurrency: 1, liveMaxWaitMs: 5_000 }
    const proSettings = { ...profile, requestsPerMinute: 1, rpmSafetyPercent: 100, maxConcurrency: 1, liveMaxWaitMs: 120_000 }
    const store = new GeminiQuotaStore(storage(), () => 1_000)
    // Pre-reserve the Pro RPM slot so the live Pro batch gets a quota denial.
    await store.reserve(proSettings, 1, 'gemini-2.5-pro')
    const scheduler = new QuotaScheduler(store, { now: () => 1_000 })
    const proLive = batch('pro-live', 'live', { profile: proSettings, quotaKey: 'gemini-2.5-pro' })
    const flashBacklog = batch('flash-backlog', 'backlog', { profile: flashProfile, quotaKey: 'gemini-2.5-flash' })

    void scheduler.schedule(proLive)
    void scheduler.schedule(flashBacklog)

    // With current scoped hasLiveQuotaWaiter, the Flash backlog is NOT blocked
    // by the unrelated Pro quota waiter, so Flash runs Gemini.
    // With old unscoped hasLiveQuotaWaiter(), Flash IS blocked → goes to DeepSeek.
    //
    // Assert: Flash calls runGemini and does NOT call runDeepSeek.
    await vi.waitFor(() => {
      expect(flashBacklog.runGemini).toHaveBeenCalledTimes(1)
    })
    expect(flashBacklog.runDeepSeek).not.toHaveBeenCalled()

    // Pro live waiter remains waiting for quota — it did NOT run Gemini.
    expect(proLive.runGemini).not.toHaveBeenCalled()
  })

  it('times out a hung provider and settles the batch exactly once', async () => {
    vi.useFakeTimers()
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage()), { providerTimeoutMs: 1_000 })
    let receivedSignal: AbortSignal | undefined
    const request = batch('hung', 'backlog', {
      runGemini: vi.fn((...args: unknown[]) => {
        receivedSignal = args[1] as AbortSignal | undefined
        return new Promise<BatchItemResult[]>(() => undefined)
      }),
    })
    let settlements = 0
    const result = scheduler.schedule(request).then((value) => {
      settlements++
      return value
    })

    await vi.advanceTimersByTimeAsync(1_001)

    await expect(result).resolves.toMatchObject({ results: [{ error: 'Gemini request timed out' }] })
    expect(settlements).toBe(1)
    expect(receivedSignal?.aborted).toBe(true)
  })
})
