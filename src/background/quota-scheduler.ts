import type { BatchItemResult } from '@/providers/types'
import { GeminiQuotaStore, type GeminiQuotaSettings } from './gemini-quota'

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
  geminiAvailable: boolean
  runGemini: (requests: SchedulerRequest[]) => Promise<BatchItemResult[]>
  runDeepSeek: (requests: SchedulerRequest[]) => Promise<BatchItemResult[]>
}

export interface ScheduledBatchResult {
  results: BatchItemResult[]
  providers: Map<string, 'gemini' | 'deepseek'>
}

export interface QuotaSchedulerOptions {
  deepseekMaxConcurrency?: number
  now?: () => number
}

interface QueuedBatch extends ScheduledBatch {
  resolve: (result: ScheduledBatchResult) => void
  deadline?: number
  fallbackRequests?: SchedulerRequest[]
  geminiResults?: BatchItemResult[]
}

const allErrors = (requests: SchedulerRequest[], message: string): BatchItemResult[] =>
  requests.map((request) => ({ id: request.id, error: message }))

/** A single drain loop that atomically reserves Gemini capacity before dispatch. */
export class QuotaScheduler {
  private live: QueuedBatch[] = []
  private backlog: QueuedBatch[] = []
  private geminiInFlight = 0
  private deepseekInFlight = 0
  private draining = false
  private wakeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly deepseekMaxConcurrency: number
  private readonly now: () => number

  constructor(
    private quota: GeminiQuotaStore,
    options: QuotaSchedulerOptions = {},
  ) {
    this.deepseekMaxConcurrency = Math.max(1, options.deepseekMaxConcurrency ?? 2)
    this.now = options.now ?? Date.now
  }

  schedule(batch: ScheduledBatch): Promise<ScheduledBatchResult> {
    return new Promise((resolve) => {
      this.push({ ...batch, resolve, deadline: batch.profile ? this.now() + batch.profile.liveMaxWaitMs : undefined })
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true

    try {
      while (true) {
        const batch = this.shift()
        if (!batch) return

        if (batch.fallbackRequests || !batch.geminiAvailable) {
          if (!this.startDeepSeek(batch, batch.fallbackRequests ?? batch.requests)) {
            this.push(batch, true)
            return
          }
          continue
        }

        const maxGeminiConcurrency = Math.max(1, batch.profile?.maxConcurrency ?? 1)
        if (this.geminiInFlight >= maxGeminiConcurrency) {
          if (batch.priority === 'live') {
            this.push(batch, true)
            return
          }
          if (!this.startDeepSeek(batch, batch.requests)) {
            this.push(batch, true)
            return
          }
          continue
        }

        if (batch.profile) {
          const reservation = await this.quota.reserve(batch.profile, batch.estimatedInputTokens)
          if (!reservation.accepted) {
            if (batch.priority === 'live' && reservation.nextAvailableAt !== undefined && reservation.nextAvailableAt <= (batch.deadline ?? this.now())) {
              this.push(batch, true)
              this.scheduleWake(reservation.nextAvailableAt)
              return
            }
            if (!this.startDeepSeek(batch, batch.requests)) {
              this.push(batch, true)
              return
            }
            continue
          }
        }

        this.startGemini(batch)
      }
    } finally {
      this.draining = false
      const liveCanProgress = this.live.length > 0 && !this.wakeTimer && this.geminiInFlight === 0
      const backlogCanProgress = this.live.length === 0 && this.backlog.length > 0 && this.deepseekInFlight < this.deepseekMaxConcurrency
      if (liveCanProgress || backlogCanProgress) {
        void this.drain()
      }
    }
  }

  private startGemini(batch: QueuedBatch): void {
    this.geminiInFlight++
    void batch.runGemini(batch.requests)
      .then(async (results) => {
        const fallbackRequests = batch.requests.filter((request) => results.some((result) => result.id === request.id && result.status === 429))
        if (fallbackRequests.length > 0) {
          const retryAfterMs = results.find((result) => result.status === 429)?.retryAfterMs ?? 30_000
          await this.quota.openCooldown(retryAfterMs)
          batch.geminiResults = results
          batch.fallbackRequests = fallbackRequests
          this.push(batch, true)
          queueMicrotask(() => { void this.drain() })
        } else {
          batch.resolve({
            results,
            providers: new Map(batch.requests.map((request) => [request.id, 'gemini'] as const)),
          })
        }
      })
      .catch((error: unknown) => batch.resolve({
        results: allErrors(batch.requests, error instanceof Error ? error.message : 'Gemini request failed'),
        providers: new Map(batch.requests.map((request) => [request.id, 'gemini'] as const)),
      }))
      .finally(() => {
        this.geminiInFlight--
        void this.drain()
      })
  }

  private startDeepSeek(batch: QueuedBatch, requests: SchedulerRequest[]): boolean {
    if (this.deepseekInFlight >= this.deepseekMaxConcurrency) return false
    this.deepseekInFlight++

    void batch.runDeepSeek(requests)
      .then((fallbackResults) => {
        if (!batch.geminiResults) {
          batch.resolve({
            results: fallbackResults,
            providers: new Map(batch.requests.map((request) => [request.id, 'deepseek'] as const)),
          })
          return
        }

        const replacements = new Map(fallbackResults.map((result) => [result.id, result]))
        const fallbackIds = new Set(requests.map((request) => request.id))
        batch.resolve({
          results: batch.geminiResults.map((result) => fallbackIds.has(result.id) ? replacements.get(result.id) ?? result : result),
          providers: new Map(batch.requests.map((request) => [request.id, fallbackIds.has(request.id) ? 'deepseek' : 'gemini'] as const)),
        })
      })
      .catch((error: unknown) => batch.resolve({
        results: allErrors(requests, error instanceof Error ? error.message : 'DeepSeek request failed'),
        providers: new Map(batch.requests.map((request) => [request.id, 'deepseek'] as const)),
      }))
      .finally(() => {
        this.deepseekInFlight--
        void this.drain()
      })
    return true
  }

  private push(batch: QueuedBatch, front = false): void {
    const queue = batch.priority === 'live' ? this.live : this.backlog
    if (front) queue.unshift(batch)
    else queue.push(batch)
  }

  private shift(): QueuedBatch | undefined {
    return this.live.shift() ?? this.backlog.shift()
  }

  private scheduleWake(at: number): void {
    const delay = Math.max(0, at - this.now())
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      void this.drain()
    }, delay)
  }
}
