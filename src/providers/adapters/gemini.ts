// Gemini Provider Adapter
// Implements TranslationProvider for Google's Gemini API.

import { buildTranslationPrompt, parseTranslationResponse } from '../prompt'
import type { BatchItemResult, KeyValidationResult, TranslationProvider } from '../types'

const GEMINI_MODELS = [
  { id: 'gemini-1.5-flash', displayName: 'Gemini 1.5 Flash', maxTokens: 1_048_576 },
  { id: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro', maxTokens: 2_097_152 },
] as const

const GEMINI_DEFAULT_MODEL = 'gemini-1.5-flash'

export { GEMINI_MODELS, GEMINI_DEFAULT_MODEL }

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

interface GeminiContentPart {
  text: string
}

interface GeminiContent {
  parts: GeminiContentPart[]
}

interface GeminiRequest {
  contents: GeminiContent[]
}

interface GeminiResponse {
  candidates?: Array<{
    content?: GeminiContent
  }>
}

interface GeminiError {
  error: {
    message: string
  }
}

export const createGeminiProvider = (fetchFn: typeof globalThis.fetch = globalThis.fetch): TranslationProvider => ({
  id: 'gemini',
  displayName: 'Gemini',
  models: GEMINI_MODELS,
  defaultModel: GEMINI_DEFAULT_MODEL,

  async translateBatch(requests, apiKey, model, targetLang) {
    const { system, user } = buildTranslationPrompt(requests, targetLang)
    const requestBody: GeminiRequest = {
      contents: [
        { parts: [{ text: system }] },
        { parts: [{ text: user }] },
      ],
    }

    const url = `${GEMINI_API_BASE}/models/${model}:generateContent`
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorData: GeminiError = await response.json().catch(() => ({ error: { message: 'Unknown error' } }))
      const errorMessage = errorData.error?.message || 'Unknown error'

      return requests.map((request) => {
        if (response.status === 401) {
          return { id: request.id, error: errorMessage }
        } else if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after')
          const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 0
          return { id: request.id, error: `Rate limited: ${errorMessage}` }
        } else {
          return { id: request.id, error: errorMessage }
        }
      })
    }

    const responseData: GeminiResponse = await response.json()
    const responseText = responseData.candidates?.[0]?.content?.parts?.[0]?.text || ''

    return parseTranslationResponse(responseText, requests)
  },

  async validateKey(apiKey) {
    const url = `${GEMINI_API_BASE}/models/gemini-1.5-flash:generateContent`
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'test' }] }] }),
    })

    if (!response.ok) {
      const errorData: GeminiError = await response.json().catch(() => ({ error: { message: 'Unknown error' } }))
      return { valid: false, error: errorData.error?.message || 'Unknown error' }
    }

    return { valid: true }
  },
})
