// TranslationProvider interface — all LLM API adapters implement this contract.
// Defined early so SW, Popup, and providers can be built in parallel.

export interface ProviderModel {
  id: string
  displayName: string
  maxTokens?: number
}

/** Per-message result that supports partial failure within a batch. */
export interface BatchItemResult {
  id: string
  translatedText?: string
  error?: string
}

export interface TranslationProvider {
  readonly id: string
  readonly displayName: string
  readonly models: ProviderModel[]
  readonly defaultModel: string

  /** Translate a batch of messages. Each item may succeed or fail independently. */
  translateBatch(
    requests: { id: string; text: string }[],
    apiKey: string,
    model: string,
    targetLang: string,
  ): Promise<BatchItemResult[]>

  /** Verify the API key is valid by making a minimal API call. */
  validateKey(apiKey: string): Promise<KeyValidationResult>
}

export interface KeyValidationResult {
  valid: boolean
  error?: string
}
