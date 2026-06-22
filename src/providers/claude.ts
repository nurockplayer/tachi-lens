import { buildTranslationPrompt, parseTranslationResponse } from './prompt'
import type { ProviderModel, TranslationProvider } from './types'

export const CLAUDE_MODELS: ProviderModel[] = [
  { id: 'claude-3-5-haiku-latest', displayName: 'Claude 3.5 Haiku' },
  { id: 'claude-3-5-sonnet-latest', displayName: 'Claude 3.5 Sonnet' },
]

export const CLAUDE_DEFAULT_MODEL = 'claude-3-5-haiku-latest'

const BASE_URL = 'https://api.anthropic.com/v1'

export const createClaudeProvider = (
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): TranslationProvider => ({
  id: 'claude',
  displayName: 'Claude',
  models: CLAUDE_MODELS,
  defaultModel: CLAUDE_DEFAULT_MODEL,

  async translateBatch(requests, apiKey, model, targetLang) {
    const prompt = buildTranslationPrompt(requests, targetLang)

    try {
      const response = await fetchFn(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
          max_tokens: 4096,
        }),
      })

      if (!response.ok) {
        return allErrors(requests, `Claude API error (${response.status})`)
      }

      const data: unknown = await response.json()
      const text = extractClaudeText(data)

      if (!text) {
        return allErrors(requests, 'Empty response from Claude')
      }

      return parseTranslationResponse(text, requests)
    } catch (err) {
      return allErrors(requests, err instanceof Error ? err.message : 'Unknown Claude error')
    }
  },

  async validateKey(apiKey) {
    try {
      const response = await fetchFn(`${BASE_URL}/models`, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      })
      return {
        valid: response.ok,
        error: response.ok ? undefined : `Claude key validation failed (${response.status})`,
      }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
})

const extractClaudeText = (data: unknown): string | undefined => {
  const content = (data as Record<string, unknown>)?.content as Record<string, unknown>[] | undefined
  return (content?.[0] as Record<string, unknown>)?.text as string | undefined
}

const allErrors = (requests: { id: string }[], error: string) =>
  requests.map((r) => ({ id: r.id, error }))
