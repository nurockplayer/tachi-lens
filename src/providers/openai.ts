import { buildTranslationPrompt, parseTranslationResponse } from './prompt'
import type { ProviderModel, TranslationProvider } from './types'

export const OPENAI_MODELS: ProviderModel[] = [
  { id: 'gpt-4o-mini', displayName: 'GPT-4o mini' },
  { id: 'gpt-4o', displayName: 'GPT-4o' },
]

export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini'

const BASE_URL = 'https://api.openai.com/v1'

export const createOpenAIProvider = (
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): TranslationProvider => ({
  id: 'openai',
  displayName: 'OpenAI',
  models: OPENAI_MODELS,
  defaultModel: OPENAI_DEFAULT_MODEL,

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
        return allErrors(requests, `OpenAI API error (${response.status})`)
      }

      const data: unknown = await response.json()
      const text = extractChatText(data)

      if (!text) {
        return allErrors(requests, 'Empty response from OpenAI')
      }

      return parseTranslationResponse(text, requests)
    } catch (err) {
      return allErrors(requests, err instanceof Error ? err.message : 'Unknown OpenAI error')
    }
  },

  async validateKey(apiKey) {
    try {
      const response = await fetchFn(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      return {
        valid: response.ok,
        error: response.ok ? undefined : `OpenAI key validation failed (${response.status})`,
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
