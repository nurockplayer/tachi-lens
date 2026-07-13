import { describe, expect, it, vi } from 'vitest'
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
  providerDayStartHourUtc: 0,
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
  it('routes initial backlog directly to DeepSeek when only one Gemini reservation is available', async () => {
    const limited = { ...profile, requestsPerMinute: 1 }
    const scheduler = new QuotaScheduler(new GeminiQuotaStore(storage(), () => 1_000), { now: () => 1_000 })
    const batches = Array.from({ length: 5 }, (_, index) => batch(`b${index}`, 'backlog', { profile: limited }))

    const results = await Promise.all(batches.map((entry) => scheduler.schedule(entry)))

    expect(batches.filter((entry) => vi.mocked(entry.runGemini).mock.calls.length === 1)).toHaveLength(1)
    expect(batches.filter((entry) => vi.mocked(entry.runDeepSeek).mock.calls.length === 1)).toHaveLength(4)
    expect(results.flatMap((result) => result.results)).toHaveLength(5)
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
})
