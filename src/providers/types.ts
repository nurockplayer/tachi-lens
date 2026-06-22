// TranslationProvider interface — all LLM API adapters implement this contract.
// Defined early so SW, Popup, and providers can be built in parallel.

export interface ProviderModel {
  id: string
  displayName: string
  maxTokens?: number
}

export interface TranslationProvider {
  readonly id: string
  readonly displayName: string
  readonly models: ProviderModel[]
  readonly defaultModel: string

  /** Translate a batch of messages. Returns results in the same order. */
  translateBatch(
    requests: { id: string; text: string }[],
    apiKey: string,
    model: string,
    targetLang: string,
  ): Promise<Map<string, string>>

  /** Verify the API key is valid by making a minimal API call. */
  validateKey(apiKey: string): Promise<boolean>
}

export interface KeyValidationResult {
  valid: boolean
  error?: string
}
