import { buildTranslationPrompt, parseTranslationResponse } from './prompt'
import type { ProviderModel, TranslationProvider } from './types'

export const DEEPSEEK_MODELS: ProviderModel[] = [
  { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
]

export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'

const BASE_URL = 'https://api.deepseek.com'

export const createDeepSeekProvider = (
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): TranslationProvider => ({
  id: 'deepseek',
  displayName: 'DeepSeek',
  models: DEEPSEEK_MODELS,
  defaultModel: DEEPSEEK_DEFAULT_MODEL,

  async translateBatch(requests, apiKey, model, targetLang) {
    const prompt = buildTranslationPrompt(requests, targetLang)

    try {
      const response = await fetchFn(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        }),
      })

      if (!response.ok) {
        return allErrors(requests, `DeepSeek API error (${response.status})`)
      }

      const data: unknown = await response.json()
      const text = extractChatText(data)

      if (!text) {
        return allErrors(requests, 'Empty response from DeepSeek')
      }

      return parseTranslationResponse(text, requests)
    } catch (err) {
      return allErrors(requests, err instanceof Error ? err.message : 'Unknown DeepSeek error')
    }
  },

  async validateKey(apiKey) {
    try {
      const response = await fetchFn(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      return {
        valid: response.ok,
        error: response.ok ? undefined : `DeepSeek key validation failed (${response.status})`,
      }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
})

const extractChatText = (data: unknown): string | undefined => {
  const choices = (data as Record<string, unknown>)?.choices as Record<string, unknown>[] | undefined
  return (choices?.[0]?.message as Record<string, unknown>)?.content as string | undefined
}

const allErrors = (requests: { id: string }[], error: string) =>
  requests.map((r) => ({ id: r.id, error }))
