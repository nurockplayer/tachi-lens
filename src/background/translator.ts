import type { BatchItemResult, ProviderId, TranslationProvider } from '@/providers/types'
import type { ProviderError, TranslationRequest, TranslationResult } from '@/shared/messages'
import { TranslationCache } from './cache'
import { type RateLimiter } from './rate-limiter'

export interface TranslatorDependencies {
  cache: TranslationCache
  rateLimiter: RateLimiter
  getSettings: () => Promise<{
    selectedProvider: ProviderId
    selectedModel: string
    targetLanguage: string
  }>
  getApiKey: (providerId: ProviderId) => Promise<string | undefined>
  getProvider: (providerId: ProviderId) => TranslationProvider | undefined
}

export interface TranslatorOptions {
  debounceMs: number
  maxBatchSize: number
}

interface PendingItem {
  request: TranslationRequest
  resolve: (result: TranslationResult) => void
}

const DEEPSEEK_FALLBACK_PROVIDER: ProviderId = 'deepseek'
const DEEPSEEK_FALLBACK_MODEL = 'deepseek-v4-flash'

export class Translator {
  private queue: PendingItem[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private deps: TranslatorDependencies,
    private options: TranslatorOptions,
  ) {}

  translate(request: TranslationRequest): Promise<TranslationResult> {
    return new Promise((resolve) => {
      this.queue.push({ request, resolve })

      if (this.queue.length >= this.options.maxBatchSize) {
        this.flushImmediately()
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.options.debounceMs)
      }
    })
  }

  private flushImmediately(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    void this.flush()
  }

  private async flush(): Promise<void> {
    this.timer = null

    const items = this.queue.splice(0, this.options.maxBatchSize)

    if (items.length === 0) return

    const settings = await this.deps.getSettings()
    const apiKey = await this.deps.getApiKey(settings.selectedProvider)

    if (!apiKey) {
      this.resolveAll(items, {
        type: 'auth',
        status: 401,
        message: 'No API key configured',
      } as ProviderError)

      return
    }

    const provider = this.deps.getProvider(settings.selectedProvider)

    if (!provider) {
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
      )
      const cached = this.deps.cache.get(cacheKey)

      if (cached) {
        item.resolve(this.toTranslationResult(item.request.messageId, cached))
      } else {
        uncached.push(item)
      }
    }

    if (uncached.length === 0) return

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
  }

  private async translateWithDeepSeekFallback(
    items: PendingItem[],
    targetLang: string,
    geminiRetryAfterMs: number,
    originalResults = new Map<string, BatchItemResult>(),
  ): Promise<void> {
    if (items.length === 0) return

    const uncached: PendingItem[] = []

    for (const item of items) {
      const cacheKey = this.deps.cache.buildKey(
        item.request.text,
        targetLang,
        DEEPSEEK_FALLBACK_PROVIDER,
        DEEPSEEK_FALLBACK_MODEL,
      )
      const cached = this.deps.cache.get(cacheKey)

      if (cached) {
        item.resolve(this.toTranslationResult(item.request.messageId, cached))
      } else {
        uncached.push(item)
      }
    }

    if (uncached.length === 0) return

    const apiKey = await this.deps.getApiKey(DEEPSEEK_FALLBACK_PROVIDER)

    if (!apiKey) {
      this.resolveFallbackUnavailable(
        uncached,
        geminiRetryAfterMs,
        originalResults,
        'no DeepSeek API key is configured',
      )
      return
    }

    const provider = this.deps.getProvider(DEEPSEEK_FALLBACK_PROVIDER)

    if (!provider) {
      this.resolveFallbackUnavailable(
        uncached,
        geminiRetryAfterMs,
        originalResults,
        'the DeepSeek provider is unavailable',
      )
      return
    }

    if (this.deps.rateLimiter.isLimited(DEEPSEEK_FALLBACK_PROVIDER)) {
      this.resolveAll(uncached, {
        type: 'rate_limited',
        retryAfterMs: this.deps.rateLimiter.getRemainingCooldown(DEEPSEEK_FALLBACK_PROVIDER),
        message: 'DeepSeek fallback is rate limited',
      } as ProviderError)
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
        DEEPSEEK_FALLBACK_MODEL,
        targetLang,
      )
    } catch (err) {
      this.resolveAll(uncached, {
        type: 'network',
        message: err instanceof Error ? err.message : 'Unknown DeepSeek fallback error',
      })
      return
    }

    const rateLimitedResult = batchResults.find((result) =>
      result.status === 429 || result.error?.includes('(429)'),
    )

    if (rateLimitedResult) {
      this.deps.rateLimiter.recordError(
        DEEPSEEK_FALLBACK_PROVIDER,
        rateLimitedResult.retryAfterMs ?? 30_000,
      )
    } else {
      this.deps.rateLimiter.reset(DEEPSEEK_FALLBACK_PROVIDER)
    }

    this.resolveBatchResults(
      uncached,
      batchResults,
      DEEPSEEK_FALLBACK_PROVIDER,
      DEEPSEEK_FALLBACK_MODEL,
      targetLang,
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
  ): void {
    for (const item of items) {
      const result = batchResults.find((entry) => entry.id === item.request.messageId)

      if (result) {
        if (result.translatedText !== undefined) {
          const cacheKey = this.deps.cache.buildKey(
            item.request.text,
            targetLang,
            providerId,
            model,
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
