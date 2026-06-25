// Translator with Automatic Retry
// Extends Translator to support automatic retry on rate limit errors.

import type { BatchItemResult, ProviderId, TranslationProvider } from '@/providers/types'
import type { ProviderError, TranslationRequest, TranslationResult } from '@/shared/messages'
import { TranslationCache } from './cache'
import { type RateLimiter } from './rate-limiter'
import { Translator } from './translator'

export interface TranslatorWithRetryDependencies {
  cache: TranslationCache
  rateLimiter: RateLimiter
  getSettings: () => Promise<{
    selectedProvider: ProviderId
    selectedModel: string
    targetLanguage: string
  }>
  getApiKey: (providerId: ProviderId) => Promise<string | undefined>
  getProvider: (providerId: ProviderId) => TranslationProvider | undefined
  maxRetries?: number
}

export class TranslatorWithRetry extends Translator {
  private maxRetries: number

  constructor(
    deps: TranslatorWithRetryDependencies,
    options: { debounceMs: number; maxBatchSize: number },
  ) {
    super(
      {
        cache: deps.cache,
        rateLimiter: deps.rateLimiter,
        getSettings: deps.getSettings,
        getApiKey: deps.getApiKey,
        getProvider: deps.getProvider,
      },
      options,
    )
    this.maxRetries = deps.maxRetries ?? 3
  }

  override async translate(request: TranslationRequest): Promise<TranslationResult> {
    let attempt = 0
    let lastError: ProviderError | undefined

    while (attempt <= this.maxRetries) {
      const result = await super.translate(request)

      // If successful, return immediately
      if (result.translatedText !== undefined) {
        return result
      }

      // If error is rate limit, record and retry
      if (result.error?.type === 'rate_limited') {
        lastError = result.error
        attempt++

        if (attempt <= this.maxRetries) {
          const retryAfterMs = result.error.retryAfterMs ?? 1_000
          await new Promise((resolve) => setTimeout(resolve, retryAfterMs))
          continue
        }
      }

      // Non-retryable error
      return result
    }

    return { messageId: request.messageId, error: lastError }
  }
}