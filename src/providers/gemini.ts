import { buildTranslationPrompt, parseTranslationResponse } from './prompt'
import type { ProviderModel, TranslationProvider } from './types'

export const GEMINI_MODELS: ProviderModel[] = [
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
]

export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export const createGeminiProvider = (
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): TranslationProvider => ({
  id: 'gemini',
  displayName: 'Gemini',
  models: GEMINI_MODELS,
  defaultModel: GEMINI_DEFAULT_MODEL,

  async translateBatch(requests, apiKey, model, targetLang) {
    const prompt = buildTranslationPrompt(requests, targetLang)

    try {
      const response = await fetchFn(
        `${BASE_URL}/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: prompt.system }] },
            contents: [{ parts: [{ text: prompt.user }] }],
          }),
        },
      )

      if (!response.ok) {
        return allErrors(requests, `Gemini API error (${response.status})`)
      }

      const data: unknown = await response.json()
      const text = extractGeminiText(data)

      if (!text) {
        return allErrors(requests, 'Empty response from Gemini')
      }

      return parseTranslationResponse(text, requests)
    } catch (err) {
      return allErrors(requests, err instanceof Error ? err.message : 'Unknown Gemini error')
    }
  },

  async validateKey(apiKey) {
    try {
      const response = await fetchFn(`${BASE_URL}/models`, {
        headers: { 'x-goog-api-key': apiKey },
      })
      return {
        valid: response.ok,
        error: response.ok ? undefined : `Gemini key validation failed (${response.status})`,
      }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
})

const extractGeminiText = (data: unknown): string | undefined => {
  const candidates = (data as Record<string, unknown>).candidates as Array<Record<string, unknown>> | undefined
  const parts = candidates?.[0]?.content as Record<string, unknown> | undefined
  const textParts = parts?.parts as Array<Record<string, unknown>> | undefined
  const textPart = textParts?.find((p) => typeof p.text === 'string')
  return textPart?.text as string | undefined
}

const allErrors = (requests: { id: string }[], error: string) =>
  requests.map((r) => ({ id: r.id, error }))
