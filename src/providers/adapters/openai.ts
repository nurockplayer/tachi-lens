// OpenAI Provider Adapter
// Implements TranslationProvider for OpenAI API.

import { buildTranslationPrompt, parseTranslationResponse } from '../prompt'
import type { TranslationProvider } from '../types'

const OPENAI_MODELS = [
  { id: 'gpt-4o-mini', displayName: 'GPT-4o Mini', maxTokens: 128_000 },
  { id: 'gpt-4o', displayName: 'GPT-4o', maxTokens: 128_000 },
] as const

const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini'

export { OPENAI_MODELS, OPENAI_DEFAULT_MODEL }

const OPENAI_API_BASE = 'https://api.openai.com/v1'

interface OpenAIMessage {
  role: 'system' | 'user'
  content: string
}

interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
}

interface OpenAIError {
  error?: {
    message?: string
  }
}

export const createOpenAIProvider = (fetchFn: typeof globalThis.fetch = globalThis.fetch): TranslationProvider => ({
  id: 'openai',
  displayName: 'OpenAI',
  models: OPENAI_MODELS,
  defaultModel: OPENAI_DEFAULT_MODEL,

  async translateBatch(requests, apiKey, model, targetLang) {
    const { system, user } = buildTranslationPrompt(requests, targetLang)
    const requestBody: OpenAIRequest = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }

    const url = `${OPENAI_API_BASE}/chat/completions`
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorData: OpenAIError = await response.json().catch(() => ({}))
      const errorMessage = errorData.error?.message || 'Unknown error'

      return requests.map((request) => {
        if (response.status === 401) {
          return { id: request.id, error: errorMessage }
        } else if (response.status === 429) {
          return { id: request.id, error: `Rate limited: ${errorMessage}` }
        } else {
          return { id: request.id, error: errorMessage }
        }
      })
    }

    const responseData: OpenAIResponse = await response.json()
    const responseText = responseData.choices?.[0]?.message?.content || ''

    return parseTranslationResponse(responseText, requests)
  },

  async validateKey(apiKey) {
    const url = `${OPENAI_API_BASE}/chat/completions`
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'test' }],
      }),
    })

    if (!response.ok) {
      const errorData: OpenAIError = await response.json().catch(() => ({}))
      return { valid: false, error: errorData.error?.message || 'Unknown error' }
    }

    return { valid: true }
  },
})
