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

    // Check rate limit before calling the provider
    if (this.deps.rateLimiter.isLimited(settings.selectedProvider)) {
      this.resolveAll(items, {
        type: 'rate_limited',
        retryAfterMs: this.deps.rateLimiter.getRemainingCooldown(settings.selectedProvider),
        message: `Provider "${settings.selectedProvider}" is rate limited`,
      } as ProviderError)

      return
    }

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

      // Reset rate limiter on successful API response
      this.deps.rateLimiter.reset(settings.selectedProvider)
    } catch (err) {
      // Record rate limit on network/provider errors
      this.deps.rateLimiter.recordError(settings.selectedProvider, 30_000)

      const error: ProviderError = {
        type: 'network',
        message: err instanceof Error ? err.message : 'Unknown error',
      }

      this.resolveAll(uncached, error)

      return
    }

    // Detect rate limit errors from batch response
    if (batchResults.some((r) => r.error?.includes('(429)'))) {
      this.deps.rateLimiter.recordError(settings.selectedProvider, 30_000)
    }

    for (const item of uncached) {
      const result = batchResults.find((r) => r.id === item.request.messageId)

      if (result) {
        if (result.translatedText !== undefined) {
          const cacheKey = this.deps.cache.buildKey(
            item.request.text,
            targetLang,
            settings.selectedProvider,
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
    if (/rate\s*limit|429|too many requests/i.test(errorMsg)) {
      return {
        messageId,
        error: {
          type: 'rate_limited',
          retryAfterMs: (batchResult as { retryAfterMs?: number }).retryAfterMs ?? 1_000,
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
