import type { BatchItemResult } from '@/providers/types'
import { createSystemClock, type Clock } from './clock'
import {
  GeminiQuotaStore,
  normalizeGeminiQuotaSettings,
  type GeminiQuotaDenial,
  type GeminiQuotaSettings,
} from './gemini-quota'
import { advanceFairServiceCount, selectFairPriority } from './priority-fairness'

export type BatchPriority = 'live' | 'backlog'

export interface SchedulerRequest {
  id: string
  text: string
  sourceLang?: string
}

export interface ScheduledBatch {
  id: string
  priority: BatchPriority
  requests: SchedulerRequest[]
  estimatedInputTokens: number
  profile?: GeminiQuotaSettings
  quotaKey?: string
  geminiAvailable: boolean
  runGemini: (requests: SchedulerRequest[], signal?: AbortSignal) => Promise<BatchItemResult[]>
  getDeepSeekCachedResults?: (requests: SchedulerRequest[]) => BatchItemResult[]
  runDeepSeek: (requests: SchedulerRequest[], signal?: AbortSignal) => Promise<BatchItemResult[]>
}

export interface ScheduledBatchResult {
  results: BatchItemResult[]
  providers: Map<string, 'gemini' | 'deepseek'>
  quotaDenial?: GeminiQuotaDenial
}

export interface QuotaSchedulerOptions {
  deepseekMaxConcurrency?: number
  providerTimeoutMs?: number
  clock?: Pick<Clock, 'monotonicNow'>
  /** @deprecated Use clock.monotonicNow. */
  now?: () => number
}

interface QueuedBatch extends Omit<ScheduledBatch, 'profile' | 'quotaKey'> {
  profile: GeminiQuotaSettings
  quotaKey: string
  resolve: (result: ScheduledBatchResult) => void
  deadline: number
  fallbackRequests?: SchedulerRequest[]
  geminiResults?: BatchItemResult[]
  settled: boolean
  quotaDenial?: GeminiQuotaDenial
  waitingForQuota?: boolean
}

const allErrors = (
  requests: SchedulerRequest[],
  message: string,
  errorType: BatchItemResult['errorType'] = 'unknown',
): BatchItemResult[] => requests.map((request) => ({ id: request.id, error: message, errorType }))

const completeResults = (
  requests: SchedulerRequest[],
  results: BatchItemResult[],
  missingMessage: string,
): BatchItemResult[] => {
  const byId = new Map(results.map((result) => [result.id, result]))
  return requests.map((request) => byId.get(request.id) ?? {
    id: request.id,
    error: missingMessage,
    errorType: 'invalid_response',
  })
}

/** Owns provider capacity, Gemini reservations, deadlines, and terminal settlement. */
export class QuotaScheduler {
  private live: QueuedBatch[] = []
  private backlog: QueuedBatch[] = []
  private geminiInFlight = new Set<QueuedBatch>()
  private deepseekInFlight = 0
  private draining = false
  private drainQueued = false
  private drainRequested = false
  private wakeTimer: ReturnType<typeof setTimeout> | undefined
  private wakeAt: number | undefined
  private consecutiveLiveServices = 0
  private readonly deepseekMaxConcurrency: number
  private readonly providerTimeoutMs: number
  private readonly now: () => number

  constructor(
    private quota: GeminiQuotaStore,
    options: QuotaSchedulerOptions = {},
  ) {
    this.deepseekMaxConcurrency = this.positiveInteger(options.deepseekMaxConcurrency, 2)
    this.providerTimeoutMs = this.positiveInteger(options.providerTimeoutMs, 30_000)
    this.now = options.clock?.monotonicNow ?? options.now ?? createSystemClock().monotonicNow
  }

  schedule(batch: ScheduledBatch): Promise<ScheduledBatchResult> {
    const profile = normalizeGeminiQuotaSettings(batch.profile)
    const quotaKey = typeof batch.quotaKey === 'string' && batch.quotaKey.trim()
      ? batch.quotaKey.trim()
      : 'default'
    const deadline = batch.priority === 'live' ? this.now() + profile.liveMaxWaitMs : this.now()

    return new Promise((resolve) => {
      this.push({ ...batch, profile, quotaKey, resolve, deadline, settled: false })
      this.requestDrain()
    })
  }

  private requestDrain(): void {
    this.drainRequested = true
    if (this.draining || this.drainQueued) return

    this.drainQueued = true
    queueMicrotask(() => {
      this.drainQueued = false
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    this.drainRequested = false
    const deferred = new Set<QueuedBatch>()
    const capacityDeferred = new Set<QueuedBatch>()

    try {
      while (true) {
        const next = this.shift(deferred)
        if (!next) return
        const { batch, preserveBacklogPriority } = next

        try {
          const now = this.now()
          const expired = batch.priority === 'live' && now >= batch.deadline

          if (expired || batch.fallbackRequests || !batch.geminiAvailable) {
            if (!this.startDeepSeek(batch, batch.fallbackRequests ?? batch.requests)) {
              this.push(batch)
              deferred.add(batch)
            }
            continue
          }

          if (
            batch.priority === 'backlog' &&
            (
              (preserveBacklogPriority && this.hasRunnable(this.live, deferred)) ||
              this.hasLiveQuotaWaiter(batch.quotaKey)
            )
          ) {
            if (!this.startDeepSeek(batch, batch.requests)) {
              this.push(batch)
              deferred.add(batch)
            }
            continue
          }

          if (!this.hasGeminiCapacity(batch, capacityDeferred)) {
            if (batch.priority === 'live') {
              this.push(batch)
              deferred.add(batch)
              capacityDeferred.add(batch)
              this.scheduleWake(batch.deadline)
              continue
            }

            if (!this.startDeepSeek(batch, batch.requests)) {
              this.push(batch)
              deferred.add(batch)
            }
            continue
          }

          let reservation
          try {
            reservation = await this.quota.reserve(batch.profile, batch.estimatedInputTokens, batch.quotaKey)
          } catch {
            if (this.shouldYieldBacklogToLive(batch, deferred)) {
              this.push(batch, true)
              deferred.add(batch)
              continue
            }
            if (!this.startDeepSeek(batch, batch.requests)) {
              this.push(batch)
              deferred.add(batch)
            }
            continue
          }

          if (!reservation.accepted) {
            batch.quotaDenial = reservation.reason
            if (this.shouldYieldBacklogToLive(batch, deferred)) {
              this.push(batch, true)
              deferred.add(batch)
              continue
            }
            const canWait = batch.priority === 'live' &&
              reservation.nextAvailableAt !== undefined &&
              reservation.nextAvailableAt <= batch.deadline &&
              this.now() < batch.deadline

            if (canWait) {
              batch.waitingForQuota = true
              this.push(batch)
              deferred.add(batch)
              this.scheduleWake(Math.min(reservation.nextAvailableAt!, batch.deadline))
              continue
            }

            if (!this.startDeepSeek(batch, batch.requests)) {
              this.push(batch)
              deferred.add(batch)
            }
            continue
          }

          if (batch.priority === 'live' && this.now() >= batch.deadline) {
            if (reservation.reservationId) {
              try {
                await this.quota.release(reservation.reservationId)
              } catch {
                // Failing closed may consume quota, but the batch must still terminate.
              }
            }
            if (!this.startDeepSeek(batch, batch.requests)) {
              this.push(batch)
              deferred.add(batch)
            }
            continue
          }

          if (
            batch.priority === 'backlog' &&
            this.hasRunnable(this.live, deferred) &&
            reservation.reservationId
          ) {
            try {
              await this.quota.release(reservation.reservationId)
              this.push(batch, true)
              deferred.add(batch)
              continue
            } catch {
              // The persisted reservation remains consumed. Route this batch
              // conservatively to DeepSeek — never re-reserve consumed quota.
              batch.fallbackRequests = batch.requests
              this.push(batch, true)
              deferred.add(batch)
              continue
            }
          }

          batch.waitingForQuota = false
          this.startGemini(batch)
        } catch (error) {
          this.settle(batch, {
            results: allErrors(batch.requests, error instanceof Error ? error.message : 'Scheduler failed', 'unknown'),
            providers: new Map(batch.requests.map((request) => [request.id, 'gemini'] as const)),
          })
        }
      }
    } finally {
      this.draining = false
      if (this.drainRequested) this.requestDrain()
    }
  }

  private startGemini(batch: QueuedBatch): void {
    this.recordService(batch.priority)
    this.geminiInFlight.add(batch)

    void this.withTimeout(
      (signal) => batch.runGemini(batch.requests, signal),
      this.providerTimeoutMs,
      new Error('Gemini request timed out'),
    )
      .then(async (rawResults) => {
        if (batch.settled) return
        const results = completeResults(batch.requests, rawResults, 'No Gemini result for message')
        const fallbackRequests = batch.requests.filter((request) =>
          results.some((result) => result.id === request.id && result.status === 429),
        )

        if (fallbackRequests.length === 0) {
          this.settle(batch, {
            results,
            providers: new Map(batch.requests.map((request) => [request.id, 'gemini'] as const)),
          })
          return
        }

        const reportedRetryAfter = results.find((result) => result.status === 429)?.retryAfterMs
        const retryAfterMs = typeof reportedRetryAfter === 'number' &&
          Number.isFinite(reportedRetryAfter) && reportedRetryAfter >= 0
          ? reportedRetryAfter
          : 30_000
        try {
          await this.quota.openCooldown(retryAfterMs, batch.quotaKey)
        } catch {
          // The affected batch must still fall back; the in-memory store remains conservative.
        }
        batch.geminiResults = results
        batch.fallbackRequests = fallbackRequests
        this.push(batch, true)
        this.requestDrain()
      })
      .catch((error: unknown) => {
        this.settle(batch, {
          results: allErrors(
            batch.requests,
            error instanceof Error ? error.message : 'Gemini request failed',
            error instanceof Error && error.message === 'Gemini request timed out' ? 'timeout' : 'network',
          ),
          providers: new Map(batch.requests.map((request) => [request.id, 'gemini'] as const)),
        })
      })
      .finally(() => {
        this.geminiInFlight.delete(batch)
        this.requestDrain()
      })
  }

  private hasGeminiCapacity(
    batch: QueuedBatch,
    capacityDeferred: Set<QueuedBatch>,
  ): boolean {
    const sameKey = (contender: QueuedBatch) => contender.quotaKey === batch.quotaKey
    const sameKeyInFlight = [...this.geminiInFlight].filter(sameKey)
    const sameKeyDeferred = [...capacityDeferred].filter(sameKey)

    const providerLimit = [...sameKeyInFlight, ...sameKeyDeferred]
      .map((contender) => contender.profile.maxConcurrency)
      .reduce(
        (minimum, limit) => Math.min(minimum, limit),
        batch.profile.maxConcurrency,
      )
    return sameKeyInFlight.length < providerLimit
  }

  private startDeepSeek(batch: QueuedBatch, requests: SchedulerRequest[]): boolean {
    let cachedResults: BatchItemResult[] = []
    try {
      cachedResults = batch.getDeepSeekCachedResults?.(requests) ?? []
    } catch {
      // A cache read failure must degrade to a provider call, not strand work.
    }
    const cachedIds = new Set(cachedResults.map((result) => result.id))
    const uncachedRequests = requests.filter((request) => !cachedIds.has(request.id))

    if (uncachedRequests.length === 0) {
      this.recordService(batch.priority)
      this.finishDeepSeek(batch, requests, cachedResults)
      return true
    }

    if (this.deepseekInFlight >= this.deepseekMaxConcurrency) return false
    this.recordService(batch.priority)
    this.deepseekInFlight++

    void this.withTimeout(
      (signal) => batch.runDeepSeek(uncachedRequests, signal),
      this.providerTimeoutMs,
      new Error('DeepSeek request timed out'),
    )
      .then((results) => this.finishDeepSeek(batch, requests, [...cachedResults, ...results]))
      .catch((error: unknown) => this.finishDeepSeek(
        batch,
        requests,
        [...cachedResults, ...allErrors(
          uncachedRequests,
          error instanceof Error ? error.message : 'DeepSeek request failed',
          error instanceof Error && error.message === 'DeepSeek request timed out' ? 'timeout' : 'network',
        )],
      ))
      .finally(() => {
        this.deepseekInFlight--
        this.requestDrain()
      })
    return true
  }

  private finishDeepSeek(
    batch: QueuedBatch,
    requests: SchedulerRequest[],
    rawResults: BatchItemResult[],
  ): void {
    if (batch.settled) return
    const fallbackResults = completeResults(requests, rawResults, 'No DeepSeek result for message')

    if (!batch.geminiResults) {
      const protectedDenial = batch.quotaDenial ? 'gemini' : undefined
      this.settle(batch, {
        results: batch.requests.map((request) => {
          const fallback = fallbackResults.find((entry) => entry.id === request.id)
          if (
            protectedDenial &&
            (fallback?.errorType === 'auth' || fallback?.errorType === 'bad_request')
          ) {
            return {
              id: request.id,
              error: 'Gemini is rate limited',
              status: 429,
              retryAfterMs: 30_000,
              errorType: 'rate_limited' as const,
            }
          }
          return fallback ?? { id: request.id, error: 'DeepSeek fallback failed', errorType: 'unknown' as const }
        }),
        providers: new Map(batch.requests.map((request) => {
          const fallback = fallbackResults.find((entry) => entry.id === request.id)
          if (
            protectedDenial &&
            (fallback?.errorType === 'auth' || fallback?.errorType === 'bad_request')
          ) {
            return [request.id, 'gemini'] as const
          }
          return [request.id, 'deepseek'] as const
        })),
        ...(batch.quotaDenial ? { quotaDenial: batch.quotaDenial } : {}),
      })
      return
    }

    const replacements = new Map(fallbackResults.map((result) => [result.id, result]))
    const fallbackIds = new Set(requests.map((request) => request.id))
    const primary = new Map(batch.geminiResults.map((result) => [result.id, result]))
    this.settle(batch, {
      results: batch.requests.map((request) => {
        if (!fallbackIds.has(request.id)) {
          return primary.get(request.id) ?? { id: request.id, error: 'Gemini result missing', errorType: 'invalid_response' }
        }

        const fallback = replacements.get(request.id)
        const original = primary.get(request.id)
        if (
          original?.status === 429 &&
          (fallback?.errorType === 'auth' || fallback?.errorType === 'bad_request')
        ) {
          return original
        }
        return fallback ?? { id: request.id, error: 'DeepSeek fallback failed', errorType: 'unknown' }
      }),
      providers: new Map(batch.requests.map((request) => {
        const sentToDeepSeek = fallbackIds.has(request.id)
        if (sentToDeepSeek) {
          const original = primary.get(request.id)
          const replacement = replacements.get(request.id)
          const keptGemini = original?.status === 429 &&
            (replacement?.errorType === 'auth' || replacement?.errorType === 'bad_request')
          return [request.id, keptGemini ? 'gemini' : 'deepseek'] as const
        }
        return [request.id, 'gemini'] as const
      })),
      ...(batch.quotaDenial ? { quotaDenial: batch.quotaDenial } : {}),
    })
  }

  private settle(batch: QueuedBatch, result: ScheduledBatchResult): void {
    if (batch.settled) return
    batch.settled = true
    batch.resolve(result)
  }

  private push(batch: QueuedBatch, front = false): void {
    if (batch.settled) return
    const queue = batch.priority === 'live' ? this.live : this.backlog
    if (front) queue.unshift(batch)
    else queue.push(batch)
  }

  private shift(deferred: Set<QueuedBatch>): { batch: QueuedBatch; preserveBacklogPriority: boolean } | undefined {
    const liveIndex = this.live.findIndex((batch) => !deferred.has(batch))
    const backlogIndex = this.backlog.findIndex((batch) => !deferred.has(batch))
    const hasLive = liveIndex >= 0
    const hasBacklog = backlogIndex >= 0
    if (hasLive && hasBacklog && selectFairPriority(
      hasLive,
      hasBacklog,
      this.consecutiveLiveServices,
    ) === 'backlog') {
      return { batch: this.backlog.splice(backlogIndex, 1)[0]!, preserveBacklogPriority: true }
    }

    if (hasLive) {
      return { batch: this.live.splice(liveIndex, 1)[0]!, preserveBacklogPriority: false }
    }
    return hasBacklog
      ? { batch: this.backlog.splice(backlogIndex, 1)[0]!, preserveBacklogPriority: false }
      : undefined
  }

  private hasRunnable(queue: QueuedBatch[], deferred: Set<QueuedBatch>): boolean {
    return queue.some((batch) => !deferred.has(batch))
  }

  private hasLiveQuotaWaiter(quotaKey: string): boolean {
    return this.live.some((batch) => batch.waitingForQuota && batch.quotaKey === quotaKey)
  }

  private shouldYieldBacklogToLive(
    batch: QueuedBatch,
    deferred: Set<QueuedBatch>,
  ): boolean {
    return batch.priority === 'backlog' &&
      this.hasRunnable(this.live, deferred)
  }

  private recordService(priority: BatchPriority): void {
    this.consecutiveLiveServices = advanceFairServiceCount(
      this.consecutiveLiveServices,
      priority,
      this.backlog.length > 0,
    )
  }

  private scheduleWake(at: number): void {
    if (!Number.isFinite(at)) return
    if (this.wakeTimer && this.wakeAt !== undefined && this.wakeAt <= at) return
    if (this.wakeTimer) clearTimeout(this.wakeTimer)

    this.wakeAt = at
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      this.wakeAt = undefined
      this.requestDrain()
    }, Math.max(0, at - this.now()))
  }

  private withTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    timeoutError: Error,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
        reject(timeoutError)
      }, timeoutMs)
      const operation = Promise.resolve().then(() => run(controller.signal))
      operation.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error('Provider request failed'))
        },
      )
    })
  }

  private positiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : fallback
  }
}
