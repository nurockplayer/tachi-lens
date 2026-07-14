import type { BatchItemResult, ProviderId, TranslationProvider } from '@/providers/types'
import { buildTranslationPrompt } from '@/providers/prompt'
import type { ProviderError, TranslationRequest, TranslationResult } from '@/shared/messages'
import { TranslationCache } from './cache'
import { type RateLimiter } from './rate-limiter'
import { CharacterTokenEstimator, type GeminiQuotaSettings } from './gemini-quota'
import { type QuotaScheduler } from './quota-scheduler'
import { advanceFairServiceCount, selectFairPriority } from './priority-fairness'

export interface TranslatorDependencies {
  cache: TranslationCache
  rateLimiter: RateLimiter
  getSettings: () => Promise<{
    selectedProvider: ProviderId
    selectedModel: string
    targetLanguage: string
    geminiQuota?: GeminiQuotaSettings
    geminiQuotaProfiles?: Record<string, GeminiQuotaSettings>
  }>
  getApiKey: (providerId: ProviderId) => Promise<string | undefined>
  getProvider: (providerId: ProviderId) => TranslationProvider | undefined
  quotaScheduler?: QuotaScheduler
}

export interface TranslatorOptions {
  debounceMs: number
  maxBatchSize: number
}

interface PendingItem {
  request: TranslationRequest
  resolve: (result: TranslationResult) => void
  completion: Promise<TranslationResult>
}

const DEEPSEEK_FALLBACK_PROVIDER: ProviderId = 'deepseek'
const DEEPSEEK_FALLBACK_MODEL = 'deepseek-v4-flash'
const tokenEstimator = new CharacterTokenEstimator()

export class Translator {
  private liveQueue: PendingItem[] = []
  private backlogQueue: PendingItem[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private consecutiveLiveBatches = 0
  private inFlightTranslations = new Map<string, Promise<TranslationResult>>()

  constructor(
    private deps: TranslatorDependencies,
    private options: TranslatorOptions,
  ) {}

  translate(request: TranslationRequest): Promise<TranslationResult> {
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
      queue.push({ request, resolve: settle, completion })

      if (queue.length >= this.options.maxBatchSize) {
        this.flushImmediately(this.liveQueue.length > 0 ? 'live' : priority)
      } else if (!this.timer) {
        this.timer = setTimeout(() => { void this.flush() }, this.options.debounceMs)
      }
    })
  }

  private flushImmediately(priority: 'live' | 'backlog'): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    void this.flush(priority)
  }

  private async flush(priority?: 'live' | 'backlog'): Promise<void> {
    this.timer = null
    const selectedPriority = this.selectPriority(priority)
    const queue = selectedPriority === 'live' ? this.liveQueue : this.backlogQueue
    const items = queue.splice(0, this.options.maxBatchSize)

    if (items.length === 0) return

    this.consecutiveLiveBatches = advanceFairServiceCount(
      this.consecutiveLiveBatches,
      selectedPriority,
      this.backlogQueue.length > 0,
    )

    if ((this.liveQueue.length > 0 || this.backlogQueue.length > 0) && !this.timer) {
      this.timer = setTimeout(() => { void this.flush() }, this.options.debounceMs)
    }

    let ownedItems = items
    try {

    const settings = await this.deps.getSettings()
    const apiKey = await this.deps.getApiKey(settings.selectedProvider)

    const schedulerManaged = Boolean(this.deps.quotaScheduler) &&
      (settings.selectedProvider === 'gemini' || settings.selectedProvider === 'deepseek')

    if (!apiKey && !(schedulerManaged && settings.selectedProvider === 'deepseek')) {
      this.resolveAll(items, {
        type: 'auth',
        status: 401,
        message: 'No API key configured',
      } as ProviderError)

      return
    }

    const provider = this.deps.getProvider(settings.selectedProvider)

    if (!provider && !schedulerManaged) {
      this.resolveAll(items, {
        type: 'bad_request',
        status: 400,
        message: `Provider "${settings.selectedProvider}" not found`,
      } as ProviderError)

      return
    }

    const { selectedModel: model, targetLanguage: targetLang } = settings

    const uncached: PendingItem[] = []

    for (const item of items) {
      const cacheKey = this.deps.cache.buildKey(
        item.request.text,
        targetLang,
        settings.selectedProvider,
        model,
        item.request.sourceLang,
      )
      const inFlightKey = `${selectedPriority}:${cacheKey}`
      const cached = this.deps.cache.get(cacheKey)

      if (cached) {
        item.resolve(this.toTranslationResult(item.request.messageId, cached))
      } else {
        // Backlog may safely share a live leader because the live request has
        // the tighter deadline. Live work must never inherit backlog latency.
        const inFlight = selectedPriority === 'backlog'
          ? this.inFlightTranslations.get(`live:${cacheKey}`) ?? this.inFlightTranslations.get(inFlightKey)
          : this.inFlightTranslations.get(inFlightKey)
        if (inFlight) {
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
          uncached.push(item)
        }
      }
    }

    ownedItems = uncached
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
        runGemini: (requests, signal) => provider
          ? provider.translateBatch(requests, apiKey!, model, targetLang, signal)
          : Promise.resolve(requests.map((request) => ({ id: request.id, error: 'Gemini provider is unavailable' }))),
        getDeepSeekCachedResults: (requests) => this.getDeepSeekCachedResults(requests, targetLang, deepseekModel),
        runDeepSeek: (requests, signal) => this.runDeepSeekBatch(requests, targetLang, deepseekModel, signal),
      })

      for (const item of uncached) {
        const result = scheduled.results.find((entry) => entry.id === item.request.messageId)
        const providerId = scheduled.providers.get(item.request.messageId) ?? 'gemini'
        const resultModel = providerId === 'deepseek' ? deepseekModel : model
        if (providerId === 'gemini' && result?.translatedText !== undefined) {
          this.deps.cache.set(this.deps.cache.buildKey(
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
        await this.translateWithDeepSeekFallback(uncached, targetLang, retryAfterMs)
      } else {
        this.resolveAll(uncached, {
          type: 'rate_limited',
          retryAfterMs,
          message: `Provider "${settings.selectedProvider}" is rate limited`,
        } as ProviderError)
      }

      return
    }

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
    const results = new Map(
      this.getDeepSeekCachedResults(requests, targetLang, model)
        .map((result) => [result.id, result] as const),
    )
    const uncached = requests.filter((request) => {
      return !results.has(request.id)
    })

    if (uncached.length === 0) return requests.map((request) => results.get(request.id)!)

    const apiKey = await this.deps.getApiKey(DEEPSEEK_FALLBACK_PROVIDER)
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
      return requests.map((request) => results.get(request.id)!)
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
      return requests.map((request) => results.get(request.id)!)
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
      return requests.map((request) => results.get(request.id)!)
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
      if (result.translatedText !== undefined) {
        this.deps.cache.set(this.deps.cache.buildKey(
          request.text,
          targetLang,
          DEEPSEEK_FALLBACK_PROVIDER,
          model,
          request.sourceLang,
        ), result)
      }
    }

    return requests.map((request) => results.get(request.id)!)
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
    const byId = new Map(batchResults.map((result) => [result.id, result]))
    const unavailable = items.filter((item) => {
      const errorType = byId.get(item.request.messageId)?.errorType
      return errorType === 'auth' || errorType === 'bad_request'
    })
    const available = items.filter((item) => !unavailable.includes(item))

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
        if (cacheResults && result.translatedText !== undefined) {
          const cacheKey = this.deps.cache.buildKey(
            item.request.text,
            targetLang,
            providerId,
            model,
            item.request.sourceLang,
          )

          this.deps.cache.set(cacheKey, result)
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
    if (batchResult.translatedText !== undefined) {
      return { messageId, translatedText: batchResult.translatedText }
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
