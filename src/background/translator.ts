import type { BatchItemResult, ProviderId, TranslationProvider } from '@/providers/types'
import { buildTranslationPrompt } from '@/providers/prompt'
import type { DiagnosticStage, ProviderError, TranslationRequest, TranslationResult } from '@/shared/messages'
import { TranslationCache } from './cache'
import { type RateLimiter } from './rate-limiter'
import { CharacterTokenEstimator, type GeminiQuotaSettings } from './gemini-quota'
import { type QuotaScheduler, type SchedulerRequest } from './quota-scheduler'
import { advanceFairServiceCount, selectFairPriority } from './priority-fairness'
import type { TranslationCacheRecord } from './translation-cache-db'

/**
 * The persistent (L2) cache surface the Translator reads and writes on demand.
 *
 * Shape-compatible with `TranslationCacheDb` so the Service Worker can inject
 * the real IndexedDB adapter while unit tests inject a stub. The interface is
 * deliberately minimal: the translator never opens, counts, or iterates the
 * store, and never hydrates it at startup — it only does per-key lookups and
 * write-throughs keyed by the shared canonical translation identity.
 */
export interface PersistentTranslationCache {
  get(key: string): Promise<TranslationCacheRecord | null>
  put(key: string, record: TranslationCacheRecord): Promise<void>
}

export interface TranslatorDependencies {
  cache: TranslationCache
  /**
   * Optional persistent (L2) IndexedDB cache. When absent, the translator
   * behaves exactly as before: L1-only with the provider on miss. All
   * IndexedDB failures are cache-layer failures that fall back to the
   * existing L1/provider path and never reject a translation request.
   */
  persistentCache?: PersistentTranslationCache
  rateLimiter: RateLimiter
  getSettings: () => Promise<{
    selectedProvider: ProviderId
    selectedModel: string
    targetLanguage: string
    translationEnabled?: boolean
    geminiQuota?: GeminiQuotaSettings
    geminiQuotaProfiles?: Record<string, GeminiQuotaSettings>
  }>
  /**
   * Optional channel-effective enablement check for queued work. The router
   * supplies the trusted sender channel without widening the runtime payload;
   * absent in unit tests, flush falls back to getSettings().translationEnabled.
   */
  getTranslationEnabled?: (channelName?: string) => Promise<boolean | undefined>
  getApiKey: (providerId: ProviderId) => Promise<string | undefined>
  getProvider: (providerId: ProviderId) => TranslationProvider | undefined
  quotaScheduler?: QuotaScheduler
  /**
   * Optional privacy-safe aggregate counter for deduplication/coalescing work.
   * Called once per removed/coalesced request with a counter stage only — the
   * payload never includes chat text, usernames, provider bodies, or
   * translation output (#60). Wired from the Service Worker into the existing
   * diagnostic pipeline; absent in unit tests.
   */
  reportDiagnosticCount?: (stage: DiagnosticStage) => void
}

export interface TranslatorOptions {
  batchWindowMs: number
  maxBatchSize: number
}

interface PendingItem {
  request: TranslationRequest
  channelName?: string
  resolve: (result: TranslationResult) => void
  completion: Promise<TranslationResult>
  enqueuedAt: number
}

const DEEPSEEK_FALLBACK_PROVIDER: ProviderId = 'deepseek'
const DEEPSEEK_FALLBACK_MODEL = 'deepseek-v4-flash'
const tokenEstimator = new CharacterTokenEstimator()

/**
 * Only a non-empty, non-whitespace translatedText is a usable translation.
 *
 * Empty, whitespace-only, or missing translations are not settled as success
 * and are never cached; the Content Script keeps such messages retryable so a
 * later provider attempt can still succeed (issue #129).
 */
const hasUsableTranslation = (result: BatchItemResult): boolean =>
  typeof result.translatedText === 'string' && result.translatedText.trim().length > 0

/** Build the minimal successful record persisted to the L2 IndexedDB cache. */
const buildL2Record = (
  key: string,
  result: BatchItemResult,
): TranslationCacheRecord => ({
  key,
  translatedText: result.translatedText as string,
  storedAt: Date.now(),
})

export class Translator {
  private liveQueue: PendingItem[] = []
  private backlogQueue: PendingItem[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private consecutiveLiveBatches = 0
  private inFlightTranslations = new Map<string, Promise<TranslationResult>>()
  private activeBatch = false
  private activeBatchItems = new Set<PendingItem>()
  private cancelledMessageIds = new Set<string>()
  private flushRequested = false

  constructor(
    private deps: TranslatorDependencies,
    private options: TranslatorOptions,
  ) {}

  /**
   * Store a successful provider result in the cache layers.
   *
   * The L1 in-memory cache is always populated synchronously (unchanged
   * behavior). The L2 IndexedDB write-through is best-effort and
   * fire-and-forget: a failed write is a cache-layer failure that must never
   * turn a successful translation into an error, so it is swallowed here
   * (#104).
   */
  private persistCachedResult(cacheKey: string, result: BatchItemResult): void {
    this.deps.cache.set(cacheKey, result)
    if (this.deps.persistentCache) {
      void this.deps.persistentCache.put(cacheKey, buildL2Record(cacheKey, result))
        .catch(() => undefined)
    }
  }

  translate(request: TranslationRequest, options: { channelName?: string } = {}): Promise<TranslationResult> {
    return new Promise((resolve) => {
      let settled = false
      let complete!: (result: TranslationResult) => void
      const completion = new Promise<TranslationResult>((completionResolve) => {
        complete = completionResolve
      })
      const settle = (result: TranslationResult): void => {
        if (settled) return
        settled = true
        complete(result)
        resolve(result)
      }
      const priority = request.priority ?? 'live'
      const queue = priority === 'live' ? this.liveQueue : this.backlogQueue
      queue.push({ request, channelName: options.channelName, resolve: settle, completion, enqueuedAt: this.now() })

      if (queue.length >= this.options.maxBatchSize) {
        this.flushImmediately(this.liveQueue.length > 0 ? 'live' : priority)
      } else if (!this.timer) {
        this.scheduleTimer()
      }
    })
  }

  /**
   * Settle queued work invalidated by a chat disable before it can reach the
   * provider. An omitted channel means the global setting changed; a channel
   * name limits cancellation to that channel's pending requests.
   */
  async cancelQueuedTranslations(channelName?: string): Promise<void> {
    const liveCandidates = this.liveQueue
    const backlogCandidates = this.backlogQueue
    const activeCandidates = [...this.activeBatchItems]
    this.liveQueue = []
    this.backlogQueue = []

    const shouldCancel = async (item: PendingItem): Promise<boolean> => {
      if (channelName !== undefined) return item.channelName === channelName
      if (!this.deps.getTranslationEnabled) return true

      try {
        return (await this.deps.getTranslationEnabled(item.channelName)) !== true
      } catch {
        // The authoritative disable was already received. If the effective
        // state cannot be read, drop the work rather than risk provider cost.
        return true
      }
    }

    const cancelMatching = async (queue: PendingItem[]): Promise<PendingItem[]> => {
      const remaining: PendingItem[] = []
      for (const item of queue) {
        if (!(await shouldCancel(item))) {
          remaining.push(item)
          continue
        }
        if (this.activeBatchItems.has(item)) this.cancelledMessageIds.add(item.request.messageId)
        item.resolve({ messageId: item.request.messageId })
      }
      return remaining
    }

    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const [remainingLive, remainingBacklog] = await Promise.all([
      cancelMatching(liveCandidates),
      cancelMatching(backlogCandidates),
      cancelMatching(activeCandidates),
    ])

    // Preserve work that arrived while effective settings were being read.
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.liveQueue = [...remainingLive, ...this.liveQueue]
    this.backlogQueue = [...remainingBacklog, ...this.backlogQueue]
    if (this.liveQueue.length > 0 || this.backlogQueue.length > 0) this.scheduleTimer()
  }

  private async filterEnabledItems(
    items: PendingItem[],
    fallbackEnabled: boolean | undefined,
  ): Promise<PendingItem[]> {
    const enabled = await Promise.all(items.map(async (item) => {
      if (this.cancelledMessageIds.has(item.request.messageId)) return false
      const channelEnabled = await this.deps.getTranslationEnabled?.(item.channelName)
      return channelEnabled ?? fallbackEnabled
    }))
    const active: PendingItem[] = []
    for (const [index, item] of items.entries()) {
      if (enabled[index] === false) {
        item.resolve({ messageId: item.request.messageId })
      } else {
        active.push(item)
      }
    }
    return active
  }

  private async runUncancelledBatch(
    requests: SchedulerRequest[],
    signal: AbortSignal | undefined,
    run: (requests: SchedulerRequest[], signal?: AbortSignal) => Promise<BatchItemResult[]>,
  ): Promise<BatchItemResult[]> {
    const activeRequests = requests.filter((request) => !this.cancelledMessageIds.has(request.id))
    const cancelledRequests = requests.filter((request) => this.cancelledMessageIds.has(request.id))
    const results = activeRequests.length > 0 ? await run(activeRequests, signal) : []
    return [
      ...results,
      ...cancelledRequests.map((request) => ({
        id: request.id,
        error: 'Translation canceled',
        errorType: 'unknown' as const,
      })),
    ]
  }

  private flushImmediately(priority?: 'live' | 'backlog'): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.activeBatch) {
      this.flushRequested = true
      return
    }

    this.flushRequested = false
    this.activeBatch = true
    void this.flush(priority).finally(() => {
      this.activeBatch = false
      this.activeBatchItems.clear()
      this.cancelledMessageIds.clear()
      this.drainAfterActiveBatch()
    })
  }

  private drainAfterActiveBatch(): void {
    if (this.flushRequested) {
      this.flushRequested = false
      queueMicrotask(() => { this.flushImmediately() })
      return
    }

    const remaining = this.liveQueue.length + this.backlogQueue.length

    if (this.liveQueue.length >= this.options.maxBatchSize ||
        this.backlogQueue.length >= this.options.maxBatchSize) {
      queueMicrotask(() => { this.flushImmediately() })
      return
    }

    if (remaining > 0 && !this.timer) {
      // The remaining items have no pending batch-window timer (they were
      // enqueued while earlier full batches were already flushing). They are a
      // burst tail, not a fresh partial batch, so drain them immediately to
      // avoid leaving their Promises pending on a timer that may never fire.
      queueMicrotask(() => { this.flushImmediately() })
    }
  }

  private scheduleTimer(): void {
    const deadline = this.nextBatchDeadline()
    if (deadline === undefined) return
    const delay = Math.max(0, deadline - this.now())
    this.timer = setTimeout(() => { this.flushImmediately() }, delay)
  }

  private nextBatchDeadline(): number | undefined {
    const liveOldest = this.liveQueue[0]
    const backlogOldest = this.backlogQueue[0]
    const oldest = !liveOldest ? backlogOldest
      : !backlogOldest ? liveOldest
      : liveOldest.enqueuedAt <= backlogOldest.enqueuedAt ? liveOldest : backlogOldest
    if (!oldest) return undefined
    return oldest.enqueuedAt + this.options.batchWindowMs
  }

  private now(): number {
    return Date.now()
  }

  private async flush(priority?: 'live' | 'backlog'): Promise<void> {
    this.timer = null
    const selectedPriority = this.selectPriority(priority)
    const queue = selectedPriority === 'live' ? this.liveQueue : this.backlogQueue
    const items = queue.splice(0, this.options.maxBatchSize)

    if (items.length === 0) return
    this.activeBatchItems.clear()
    for (const item of items) this.activeBatchItems.add(item)

    this.consecutiveLiveBatches = advanceFairServiceCount(
      this.consecutiveLiveBatches,
      selectedPriority,
      this.backlogQueue.length > 0,
    )

    let ownedItems = items
    try {

    const settings = await this.deps.getSettings()
    const activeItems = await this.filterEnabledItems(items, settings.translationEnabled)
    if (activeItems.length === 0) return
    ownedItems = activeItems
    const { selectedModel: model, targetLanguage: targetLang } = settings

    let uncached: PendingItem[] = []
    // Flush-local deduplication (#56): requests sharing a canonical identity
    // within this flush are grouped under the first request for that identity.
    // Only the group leader becomes a provider item; every follower shares the
    // leader's completion and fans the outcome out to its own messageId. This
    // is distinct from the in-flight registry below, which coalesces identical
    // work across separate flushes (owned by #58).
    const flushLeaders = new Map<string, PendingItem>()

    for (const item of activeItems) {
      const cacheKey = this.deps.cache.buildKey(
        item.request.text,
        targetLang,
        settings.selectedProvider,
        model,
        item.request.sourceLang,
      )
      // Coalescing shares a completion promise, so keep it inside the same
      // channel cancellation domain. The translation cache remains global.
      const coalescingKey = item.channelName === undefined
        ? cacheKey
        : `${item.channelName}\u0000${cacheKey}`
      const inFlightKey = `${selectedPriority}:${coalescingKey}`
      const cached = this.deps.cache.get(cacheKey)

      if (cached) {
        item.resolve(this.toTranslationResult(item.request.messageId, cached))
        continue
      }

      // A duplicate within this flush follows its group leader. The leader is
      // registered below after the same-flush and in-flight lookups miss, so
      // the first request with a given identity always leads its group.
      const flushLeader = flushLeaders.get(coalescingKey)
      if (flushLeader) {
        this.deps.reportDiagnosticCount?.('batch_dedup_removed')
        void flushLeader.completion.then((result) => item.resolve({
          ...result,
          messageId: item.request.messageId,
        }))
        continue
      }

      // Backlog may safely share a live leader because the live request has
      // the tighter deadline. Live work must never inherit backlog latency.
      const inFlight = selectedPriority === 'backlog'
        ? this.inFlightTranslations.get(`live:${coalescingKey}`) ?? this.inFlightTranslations.get(inFlightKey)
        : this.inFlightTranslations.get(inFlightKey)
      if (inFlight) {
        this.deps.reportDiagnosticCount?.('in_flight_coalesced')
        void inFlight.then((result) => item.resolve({
          ...result,
          messageId: item.request.messageId,
        }))
      } else {
        this.inFlightTranslations.set(inFlightKey, item.completion)
        void item.completion.then(() => {
          if (this.inFlightTranslations.get(inFlightKey) === item.completion) {
            this.inFlightTranslations.delete(inFlightKey)
          }
        })
        flushLeaders.set(coalescingKey, item)
        uncached.push(item)
      }
    }

    ownedItems = uncached

    // On-demand L2 lookup (#104): after L1, flush-local dedup, and in-flight
    // lookups all miss, query the persistent IndexedDB cache once per distinct
    // canonical identity. This never hydrates the database at startup and is
    // skipped entirely when no persistent cache is wired in. An L2 hit is
    // promoted into L1 and settled without any provider work. Any L2 read
    // failure is a cache-layer failure: it is treated as a miss and falls back
    // to the provider path below, never rejecting the request.
    if (uncached.length > 0 && this.deps.persistentCache) {
      const l2Lookups = new Map<string, Promise<TranslationCacheRecord | null>>()
      const l2HitKeys = new Set<string>()

      await Promise.all(uncached.map(async (item) => {
        const cacheKey = this.deps.cache.buildKey(
          item.request.text,
          targetLang,
          settings.selectedProvider,
          model,
          item.request.sourceLang,
        )
        let lookup = l2Lookups.get(cacheKey)
        if (!lookup) {
          // Wrap in Promise.resolve().then so a synchronous throw from the
          // adapter is also treated as a cache-layer failure, not a flush crash.
          lookup = Promise.resolve()
            .then(() => this.deps.persistentCache!.get(cacheKey))
            .catch(() => null)
          l2Lookups.set(cacheKey, lookup)
        }
        const record = await lookup
        if (record && typeof record.translatedText === 'string' && record.translatedText.trim().length > 0) {
          l2HitKeys.add(cacheKey)
        }
      }))

      if (l2HitKeys.size > 0) {
        const stillUncached: PendingItem[] = []
        for (const item of uncached) {
          const cacheKey = this.deps.cache.buildKey(
            item.request.text,
            targetLang,
            settings.selectedProvider,
            model,
            item.request.sourceLang,
          )
          const record = l2HitKeys.has(cacheKey)
            ? await l2Lookups.get(cacheKey)!
            : null
          if (record) {
            this.deps.cache.set(cacheKey, {
              id: item.request.messageId,
              translatedText: record.translatedText,
            })
            item.resolve(this.toTranslationResult(item.request.messageId, {
              id: item.request.messageId,
              translatedText: record.translatedText,
            }))
            this.deps.reportDiagnosticCount?.('l2_cache_hit')
          } else {
            stillUncached.push(item)
          }
        }
        uncached.length = 0
        uncached.push(...stillUncached)
      }
    }

    uncached = await this.filterEnabledItems(uncached, settings.translationEnabled)
    if (uncached.length === 0) return

    const apiKey = await this.deps.getApiKey(settings.selectedProvider)

    const schedulerManaged = Boolean(this.deps.quotaScheduler) &&
      (settings.selectedProvider === 'gemini' || settings.selectedProvider === 'deepseek')

    if (!apiKey && !(schedulerManaged && settings.selectedProvider === 'deepseek')) {
      this.resolveAll(uncached, {
        type: 'auth',
        status: 401,
        message: 'No API key configured',
      } as ProviderError)

      return
    }

    const provider = this.deps.getProvider(settings.selectedProvider)

    if (!provider && !schedulerManaged) {
      this.resolveAll(uncached, {
        type: 'bad_request',
        status: 400,
        message: `Provider "${settings.selectedProvider}" not found`,
      } as ProviderError)

      return
    }

    // Settings can change while API-key, cache, or quota preparation awaits.
    // Recheck immediately before any provider-capable branch so an active
    // flush cannot resurrect work invalidated by a disable.
    uncached = await this.filterEnabledItems(uncached, settings.translationEnabled)
    if (uncached.length === 0) return

    if (schedulerManaged && this.deps.quotaScheduler) {
      const selectedGemini = settings.selectedProvider === 'gemini'
      const deepseekModel = selectedGemini ? DEEPSEEK_FALLBACK_MODEL : model
      const scheduled = await this.deps.quotaScheduler.schedule({
        id: uncached.map((item) => item.request.messageId).join(','),
        priority: selectedPriority,
        requests: uncached.map((item) => ({ id: item.request.messageId, text: item.request.text, sourceLang: item.request.sourceLang })),
        estimatedInputTokens: tokenEstimator.estimate(buildTranslationPrompt(uncached.map((item) => ({
          id: item.request.messageId,
          text: item.request.text,
          sourceLang: item.request.sourceLang,
        })), targetLang)),
        profile: settings.geminiQuotaProfiles?.[model] ?? settings.geminiQuota,
        quotaKey: model,
        geminiAvailable: selectedGemini && Boolean(apiKey && provider) && !this.deps.rateLimiter.isLimited('gemini'),
        primaryProvider: selectedGemini ? 'gemini' : 'deepseek',
        runGemini: (requests, signal) => this.runUncancelledBatch(
          requests,
          signal,
          (activeRequests, activeSignal) => provider
            ? provider.translateBatch(activeRequests, apiKey!, model, targetLang, activeSignal)
            : Promise.resolve(activeRequests.map((request) => ({ id: request.id, error: 'Gemini provider is unavailable' }))),
        ),
        getDeepSeekCachedResults: (requests) => this.getDeepSeekCachedResults(requests, targetLang, deepseekModel),
        runDeepSeek: (requests, signal) => this.runUncancelledBatch(
          requests,
          signal,
          (activeRequests, activeSignal) => this.runDeepSeekBatch(activeRequests, targetLang, deepseekModel, activeSignal),
        ),
      })

      for (const item of uncached) {
        if (this.cancelledMessageIds.has(item.request.messageId)) {
          item.resolve({ messageId: item.request.messageId })
          continue
        }
        const result = scheduled.results.find((entry) => entry.id === item.request.messageId)
        const providerId = scheduled.providers.get(item.request.messageId) ?? 'gemini'
        const resultModel = providerId === 'deepseek' ? deepseekModel : model
        if (providerId === 'gemini' && result && hasUsableTranslation(result)) {
          this.persistCachedResult(this.deps.cache.buildKey(
            item.request.text,
            targetLang,
            providerId,
            resultModel,
            item.request.sourceLang,
          ), result)
        }
        item.resolve(result
          ? this.toTranslationResult(item.request.messageId, result)
          : { messageId: item.request.messageId, error: { type: 'invalid_response', message: 'No result for message in batch response' } })
      }
      return
    }

    // The scheduler branch above handles Gemini's missing primary credentials.
    // Every remaining legacy path has already resolved those actionable errors.
    if (!apiKey || !provider) return

    // A real Gemini 429 opens a provider-specific cooldown. Route new work to
    // DeepSeek during that window instead of repeatedly calling Gemini.
    if (this.deps.rateLimiter.isLimited(settings.selectedProvider)) {
      const retryAfterMs = this.deps.rateLimiter.getRemainingCooldown(settings.selectedProvider)

      if (settings.selectedProvider === 'gemini') {
        await this.translateWithDeepSeekFallback(
          uncached.filter((item) => !this.cancelledMessageIds.has(item.request.messageId)),
          targetLang,
          retryAfterMs,
        )
      } else {
        this.resolveAll(uncached, {
          type: 'rate_limited',
          retryAfterMs,
          message: `Provider "${settings.selectedProvider}" is rate limited`,
        } as ProviderError)
      }

      return
    }

    uncached = await this.filterEnabledItems(uncached, settings.translationEnabled)
    if (uncached.length === 0) return

    const batchRequests = uncached.map((item) => ({
      id: item.request.messageId,
      text: item.request.text,
      sourceLang: item.request.sourceLang,
    }))

    let batchResults: BatchItemResult[]

    try {
      batchResults = await provider.translateBatch(
        batchRequests,
        apiKey,
        model,
        targetLang,
      )
    } catch (err) {
      const error: ProviderError = {
        type: 'network',
        message: err instanceof Error ? err.message : 'Unknown error',
      }

      this.resolveAll(uncached, error)

      return
    }

    const structuredRateLimitedResult = batchResults.find((result) => result.status === 429)
    const rateLimitedResult = structuredRateLimitedResult ?? batchResults.find((result) =>
      result.status === 429 || result.error?.includes('(429)'),
    )

    if (rateLimitedResult) {
      this.deps.rateLimiter.recordError(
        settings.selectedProvider,
        rateLimitedResult.retryAfterMs ?? 30_000,
      )

      if (settings.selectedProvider === 'gemini' && structuredRateLimitedResult) {
        const fallbackIds = new Set(
          batchResults.filter((result) => result.status === 429).map((result) => result.id),
        )
        const fallbackItems = uncached.filter((item) => fallbackIds.has(item.request.messageId))
        const primaryItems = uncached.filter((item) => !fallbackIds.has(item.request.messageId))

        this.resolveBatchResults(
          primaryItems,
          batchResults,
          settings.selectedProvider,
          model,
          targetLang,
        )

        await this.translateWithDeepSeekFallback(
          fallbackItems,
          targetLang,
          structuredRateLimitedResult.retryAfterMs ?? 30_000,
          new Map(
            batchResults
              .filter((result) => result.status === 429)
              .map((result) => [result.id, result]),
          ),
        )

        return
      }
    } else {
      this.deps.rateLimiter.reset(settings.selectedProvider)
    }

    this.resolveBatchResults(
      uncached,
      batchResults,
      settings.selectedProvider,
      model,
      targetLang,
    )
    } catch (error) {
      this.resolveAll(ownedItems, {
        type: 'network',
        message: error instanceof Error ? error.message : 'Translation pipeline failed',
      })
    }
  }

  private selectPriority(preferred?: 'live' | 'backlog'): 'live' | 'backlog' {
    const hasLive = this.liveQueue.length > 0
    const hasBacklog = this.backlogQueue.length > 0

    const fairPriority = selectFairPriority(hasLive, hasBacklog, this.consecutiveLiveBatches)
    if (hasLive && hasBacklog) return fairPriority!
    if (preferred === 'live' && hasLive) return 'live'
    if (preferred === 'backlog' && hasBacklog) return 'backlog'
    return hasLive ? 'live' : 'backlog'
  }

  private async runDeepSeekBatch(
    requests: Array<{ id: string; text: string; sourceLang?: string }>,
    targetLang: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<BatchItemResult[]> {
    const cancelledIds = new Set(
      requests
        .filter((request) => this.cancelledMessageIds.has(request.id))
        .map((request) => request.id),
    )
    const eligibleRequests = requests.filter((request) => !cancelledIds.has(request.id))
    const results = new Map(
      this.getDeepSeekCachedResults(eligibleRequests, targetLang, model)
        .map((result) => [result.id, result] as const),
    )
    let uncached = eligibleRequests.filter((request) => {
      return !results.has(request.id)
    })
    const resultFor = (request: { id: string }): BatchItemResult =>
      (cancelledIds.has(request.id) || this.cancelledMessageIds.has(request.id))
      ? { id: request.id, error: 'Translation canceled', errorType: 'unknown' }
      : results.get(request.id)!

    if (uncached.length === 0) return requests.map(resultFor)

    const apiKey = await this.deps.getApiKey(DEEPSEEK_FALLBACK_PROVIDER)
    uncached = uncached.filter((request) => !this.cancelledMessageIds.has(request.id))
    if (uncached.length === 0) return requests.map(resultFor)
    const provider = this.deps.getProvider(DEEPSEEK_FALLBACK_PROVIDER)
    if (!apiKey) {
      for (const request of uncached) {
        results.set(request.id, {
          id: request.id,
          error: 'No DeepSeek API key is configured',
          status: 401,
          errorType: 'auth',
        })
      }
      return requests.map(resultFor)
    }
    if (!provider) {
      for (const request of uncached) {
        results.set(request.id, {
          id: request.id,
          error: 'DeepSeek provider is unavailable',
          status: 400,
          errorType: 'bad_request',
        })
      }
      return requests.map(resultFor)
    }

    if (this.deps.rateLimiter.isLimited(DEEPSEEK_FALLBACK_PROVIDER)) {
      const retryAfterMs = this.deps.rateLimiter.getRemainingCooldown(DEEPSEEK_FALLBACK_PROVIDER)
      for (const request of uncached) {
        results.set(request.id, {
          id: request.id,
          error: 'DeepSeek is rate limited',
          status: 429,
          retryAfterMs,
          errorType: 'rate_limited',
        })
      }
      return requests.map(resultFor)
    }

    let providerResults: BatchItemResult[]
    try {
      providerResults = signal
        ? await provider.translateBatch(uncached, apiKey, model, targetLang, signal)
        : await provider.translateBatch(uncached, apiKey, model, targetLang)
    } catch (error) {
      providerResults = uncached.map((request) => ({
        id: request.id,
        error: error instanceof Error ? error.message : 'Unknown DeepSeek error',
        errorType: 'network',
      }))
    }

    const rateLimited = providerResults.find((result) => result.status === 429)
    if (rateLimited) {
      this.deps.rateLimiter.recordError(
        DEEPSEEK_FALLBACK_PROVIDER,
        rateLimited.retryAfterMs ?? 30_000,
      )
    } else if (!this.deps.rateLimiter.isLimited(DEEPSEEK_FALLBACK_PROVIDER)) {
      this.deps.rateLimiter.reset(DEEPSEEK_FALLBACK_PROVIDER)
    }

    const byId = new Map(providerResults.map((result) => [result.id, result]))
    for (const request of uncached) {
      const result = byId.get(request.id) ?? {
        id: request.id,
        error: 'No result for message in DeepSeek batch response',
        errorType: 'invalid_response' as const,
      }
      results.set(request.id, result)
      if (hasUsableTranslation(result)) {
        this.persistCachedResult(this.deps.cache.buildKey(
          request.text,
          targetLang,
          DEEPSEEK_FALLBACK_PROVIDER,
          model,
          request.sourceLang,
        ), result)
      }
    }

    return requests.map(resultFor)
  }

  private getDeepSeekCachedResults(
    requests: Array<{ id: string; text: string; sourceLang?: string }>,
    targetLang: string,
    model: string,
  ): BatchItemResult[] {
    return requests.flatMap((request) => {
      const cached = this.deps.cache.get(this.deps.cache.buildKey(
        request.text,
        targetLang,
        DEEPSEEK_FALLBACK_PROVIDER,
        model,
        request.sourceLang,
      ))
      return cached ? [{ ...cached, id: request.id }] : []
    })
  }

  private async translateWithDeepSeekFallback(
    items: PendingItem[],
    targetLang: string,
    geminiRetryAfterMs: number,
    originalResults = new Map<string, BatchItemResult>(),
  ): Promise<void> {
    if (items.length === 0) return
    const batchRequests = items.map((item) => ({
      id: item.request.messageId,
      text: item.request.text,
      sourceLang: item.request.sourceLang,
    }))
    const batchResults = await this.runDeepSeekBatch(
      batchRequests,
      targetLang,
      DEEPSEEK_FALLBACK_MODEL,
    )
    const activeItems = items.filter((item) => !this.cancelledMessageIds.has(item.request.messageId))
    for (const item of items) {
      if (!activeItems.includes(item)) item.resolve({ messageId: item.request.messageId })
    }
    const byId = new Map(batchResults.map((result) => [result.id, result]))
    const unavailable = activeItems.filter((item) => {
      const errorType = byId.get(item.request.messageId)?.errorType
      return errorType === 'auth' || errorType === 'bad_request'
    })
    const available = activeItems.filter((item) => !unavailable.includes(item))

    if (unavailable.length > 0) {
      const reason = byId.get(unavailable[0]!.request.messageId)?.error ?? 'DeepSeek is unavailable'
      this.resolveFallbackUnavailable(unavailable, geminiRetryAfterMs, originalResults, reason)
    }
    this.resolveBatchResults(
      available,
      batchResults,
      DEEPSEEK_FALLBACK_PROVIDER,
      DEEPSEEK_FALLBACK_MODEL,
      targetLang,
      false,
    )
  }

  private resolveFallbackUnavailable(
    items: PendingItem[],
    geminiRetryAfterMs: number,
    originalResults: Map<string, BatchItemResult>,
    reason: string,
  ): void {
    for (const item of items) {
      const original = originalResults.get(item.request.messageId)

      if (original) {
        const result = this.toTranslationResult(item.request.messageId, original)

        if (result.error) {
          item.resolve({
            ...result,
            error: {
              ...result.error,
              message: `${result.error.message} DeepSeek fallback unavailable: ${reason}.`,
            },
          })
          continue
        }
      }

      item.resolve({
        messageId: item.request.messageId,
        error: {
          type: 'rate_limited',
          retryAfterMs: geminiRetryAfterMs,
          message: `Gemini is rate limited. DeepSeek fallback unavailable: ${reason}.`,
        },
      })
    }
  }

  private resolveBatchResults(
    items: PendingItem[],
    batchResults: BatchItemResult[],
    providerId: ProviderId,
    model: string,
    targetLang: string,
    cacheResults = true,
  ): void {
    for (const item of items) {
      const result = batchResults.find((entry) => entry.id === item.request.messageId)

      if (result) {
        if (cacheResults && hasUsableTranslation(result)) {
          const cacheKey = this.deps.cache.buildKey(
            item.request.text,
            targetLang,
            providerId,
            model,
            item.request.sourceLang,
          )

          this.persistCachedResult(cacheKey, result)
        }

        item.resolve(this.toTranslationResult(item.request.messageId, result))
      } else {
        item.resolve({
          messageId: item.request.messageId,
          error: { type: 'invalid_response', message: 'No result for message in batch response' },
        })
      }
    }
  }

  private resolveAll(items: PendingItem[], error: ProviderError): void {
    for (const item of items) {
      item.resolve({ messageId: item.request.messageId, error })
    }
  }

  private toTranslationResult(
    messageId: string,
    batchResult: BatchItemResult,
  ): TranslationResult {
    // Only a non-empty, non-whitespace translation is a success. An empty or
    // whitespace-only translatedText is an invalid response so the Content
    // Script keeps the message retryable instead of settling it as done (#129).
    if (hasUsableTranslation(batchResult)) {
      return { messageId, translatedText: batchResult.translatedText }
    }
    if (typeof batchResult.translatedText === 'string') {
      return {
        messageId,
        error: { type: 'invalid_response', message: 'Provider returned an empty translation' },
      }
    }

    const errorMsg = batchResult.error ?? 'Unknown error'

    if (batchResult.errorType === 'auth') {
      return {
        messageId,
        error: { type: 'auth', status: batchResult.status ?? 401, message: errorMsg },
      }
    }

    if (batchResult.errorType === 'bad_request') {
      return {
        messageId,
        error: { type: 'bad_request', status: batchResult.status ?? 400, message: errorMsg },
      }
    }

    if (batchResult.errorType === 'network' || batchResult.errorType === 'timeout' || batchResult.errorType === 'invalid_response') {
      return {
        messageId,
        error: { type: batchResult.errorType, message: errorMsg },
      }
    }

    if (batchResult.errorType === 'rate_limited') {
      return {
        messageId,
        error: {
          type: 'rate_limited',
          retryAfterMs: batchResult.retryAfterMs ?? 1_000,
          message: errorMsg,
        },
      }
    }

    // Detect rate limit patterns in error string
    if (batchResult.status === 429 || /rate\s*limit|429|too many requests/i.test(errorMsg)) {
      return {
        messageId,
        error: {
          type: 'rate_limited',
          retryAfterMs: batchResult.retryAfterMs ?? 1_000,
          message: errorMsg,
        },
      }
    }

    return {
      messageId,
      error: { type: 'unknown', message: errorMsg },
    }
  }
}
