// Translator with Automatic Retry
// Calls provider directly for retries, bypassing the batch queue.

import type { BatchItemResult, ProviderId, TranslationProvider } from '@/providers/types'
import type { ProviderError, TranslationRequest, TranslationResult } from '@/shared/messages'
import { TranslationCache } from './cache'
import { type RateLimiter } from './rate-limiter'

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

export class TranslatorWithRetry {
  private deps: TranslatorWithRetryDependencies
  private maxRetries: number

  constructor(
    deps: TranslatorWithRetryDependencies,
    private options: { debounceMs: number; maxBatchSize: number },
  ) {
    this.deps = deps
    this.maxRetries = deps.maxRetries ?? 3
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    let attempt = 0
    let lastError: ProviderError | undefined

    while (attempt <= this.maxRetries) {
      // On retries, bypass rate limiter check — use exponential backoff instead
      const result = attempt === 0
        ? await this.callProviderOnce(request)
        : await this.callProviderOnceUnsafe(request)

      if (result.translatedText !== undefined) {
        return result
      }

      if (result.error?.type === 'rate_limited' || result.error?.type === 'network') {
        if (result.error?.type === 'rate_limited') {
          lastError = result.error
        }
        attempt++

        if (attempt <= this.maxRetries) {
          const delayMs = 500 * Math.pow(2, attempt - 1)
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          continue
        }
      }

      return result
    }

    return { messageId: request.messageId, error: lastError }
  }

  private async callProviderOnce(
    request: TranslationRequest,
  ): Promise<TranslationResult> {
    const settings = await this.deps.getSettings()
    const apiKey = await this.deps.getApiKey(settings.selectedProvider)

    if (!apiKey) {
      return {
        messageId: request.messageId,
        error: { type: 'auth', status: 401, message: 'No API key configured' },
      }
    }

    const provider = this.deps.getProvider(settings.selectedProvider)

    if (!provider) {
      return {
        messageId: request.messageId,
        error: { type: 'bad_request', status: 400, message: `Provider "${settings.selectedProvider}" not found` },
      }
    }

    const { selectedModel: model, targetLanguage: targetLang } = settings

    if (this.deps.rateLimiter.isLimited(settings.selectedProvider)) {
      return {
        messageId: request.messageId,
        error: {
          type: 'rate_limited',
          retryAfterMs: this.deps.rateLimiter.getRemainingCooldown(settings.selectedProvider),
          message: `Provider "${settings.selectedProvider}" is rate limited`,
        },
      }
    }

    const cacheKey = this.deps.cache.buildKey(request.text, targetLang, settings.selectedProvider, model)
    const cached = this.deps.cache.get(cacheKey)

    if (cached) {
      return this.toTranslationResult(request.messageId, cached)
    }

    return this.doFetch(request, settings.selectedProvider, apiKey, model, targetLang)
  }

  private async callProviderOnceUnsafe(
    request: TranslationRequest,
  ): Promise<TranslationResult> {
    const settings = await this.deps.getSettings()
    const apiKey = await this.deps.getApiKey(settings.selectedProvider)

    if (!apiKey) {
      return {
        messageId: request.messageId,
        error: { type: 'auth', status: 401, message: 'No API key configured' },
      }
    }

    const provider = this.deps.getProvider(settings.selectedProvider)

    if (!provider) {
      return {
        messageId: request.messageId,
        error: { type: 'bad_request', status: 400, message: `Provider "${settings.selectedProvider}" not found` },
      }
    }

    return this.doFetch(request, settings.selectedProvider, apiKey, settings.selectedModel, settings.targetLanguage)
  }

  private async doFetch(
    request: TranslationRequest,
    providerId: ProviderId,
    apiKey: string,
    model: string,
    targetLang: string,
  ): Promise<TranslationResult> {
    const provider = this.deps.getProvider(providerId)

    if (!provider) {
      return {
        messageId: request.messageId,
        error: { type: 'bad_request', status: 400, message: `Provider "${providerId}" not found` },
      }
    }

    const batchRequests = [{ id: request.messageId, text: request.text, sourceLang: request.sourceLang }]

    try {
      const batchResults = await provider.translateBatch(batchRequests, apiKey, model, targetLang)

      this.deps.rateLimiter.reset(providerId)

      const result = batchResults.find((r) => r.id === request.messageId)

      if (result) {
        const cacheKey = this.deps.cache.buildKey(request.text, targetLang, providerId, model)

        if (result.translatedText !== undefined) {
          this.deps.cache.set(cacheKey, result)
        }

        return this.toTranslationResult(request.messageId, result)
      }

      return {
        messageId: request.messageId,
        error: { type: 'invalid_response', message: 'No result for message in batch response' },
      }
    } catch (err) {
      this.deps.rateLimiter.recordError(providerId, 30_000)

      return {
        messageId: request.messageId,
        error: { type: 'network', message: err instanceof Error ? err.message : 'Unknown error' },
      }
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