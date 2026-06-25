// DeepSeek Provider Adapter
// Implements TranslationProvider for DeepSeek API.

import { buildTranslationPrompt, parseTranslationResponse } from '../prompt'
import type { BatchItemResult, KeyValidationResult, TranslationProvider } from '../types'

const DEEPSEEK_MODELS = [
  { id: 'deepseek-chat', displayName: 'DeepSeek Chat', maxTokens: 32_768 },
] as const

const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat'

export { DEEPSEEK_MODELS, DEEPSEEK_DEFAULT_MODEL }

const DEEPSEEK_API_BASE = 'https://api.deepseek.com'

interface DeepSeekMessage {
  role: 'system' | 'user'
  content: string
}

interface DeepSeekRequest {
  model: string
  messages: DeepSeekMessage[]
}

interface DeepSeekResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
}

interface DeepSeekError {
  error?: {
    message?: string
  }
}

export const createDeepSeekProvider = (fetchFn: typeof globalThis.fetch = globalThis.fetch): TranslationProvider => ({
  id: 'deepseek',
  displayName: 'DeepSeek',
  models: DEEPSEEK_MODELS,
  defaultModel: DEEPSEEK_DEFAULT_MODEL,

  async translateBatch(requests, apiKey, model, targetLang) {
    const { system, user } = buildTranslationPrompt(requests, targetLang)
    const requestBody: DeepSeekRequest = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }

    const url = `${DEEPSEEK_API_BASE}/chat/completions`
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorData: DeepSeekError = await response.json().catch(() => ({}))
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

    const responseData: DeepSeekResponse = await response.json()
    const responseText = responseData.choices?.[0]?.message?.content || ''

    return parseTranslationResponse(responseText, requests)
  },

  async validateKey(apiKey) {
    const url = `${DEEPSEEK_API_BASE}/chat/completions`
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'test' }],
      }),
    })

    if (!response.ok) {
      const errorData: DeepSeekError = await response.json().catch(() => ({}))
      return { valid: false, error: errorData.error?.message || 'Unknown error' }
    }

    return { valid: true }
  },
})
