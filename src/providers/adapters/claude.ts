// Claude Provider Adapter
// Implements TranslationProvider for Anthropic's Claude API.

import { buildTranslationPrompt, parseTranslationResponse } from '../prompt'
import type { BatchItemResult, KeyValidationResult, TranslationProvider } from '../types'

const CLAUDE_MODELS = [
  { id: 'claude-3-5-sonnet-20240620', displayName: 'Claude 3.5 Sonnet', maxTokens: 200_000 },
  { id: 'claude-3-opus-20240229', displayName: 'Claude 3 Opus', maxTokens: 200_000 },
] as const

const CLAUDE_DEFAULT_MODEL = 'claude-3-5-sonnet-20240620'

export { CLAUDE_MODELS, CLAUDE_DEFAULT_MODEL }

const CLAUDE_API_BASE = 'https://api.anthropic.com/v1'

interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ClaudeRequest {
  model: string
  messages: ClaudeMessage[]
  system: string
  max_tokens: number
}

interface ClaudeResponse {
  content?: Array<{
    text?: string
  }>
}

interface ClaudeError {
  error?: {
    message?: string
  }
}

export const createClaudeProvider = (fetchFn: typeof globalThis.fetch = globalThis.fetch): TranslationProvider => ({
  id: 'claude',
  displayName: 'Claude',
  models: CLAUDE_MODELS,
  defaultModel: CLAUDE_DEFAULT_MODEL,

  async translateBatch(requests, apiKey, model, targetLang) {
    const { system, user } = buildTranslationPrompt(requests, targetLang)
    const requestBody: ClaudeRequest = {
      model,
      messages: [{ role: 'user', content: user }],
      system,
      max_tokens: 4096,
    }

    const url = `${CLAUDE_API_BASE}/messages`
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorData: ClaudeError = await response.json().catch(() => ({}))
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

    const responseData: ClaudeResponse = await response.json()
    const responseText = responseData.content?.[0]?.text || ''

    return parseTranslationResponse(responseText, requests)
  },

  async validateKey(apiKey) {
    const url = `${CLAUDE_API_BASE}/messages`
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1,
      }),
    })

    if (!response.ok) {
      const errorData: ClaudeError = await response.json().catch(() => ({}))
      return { valid: false, error: errorData.error?.message || 'Unknown error' }
    }

    return { valid: true }
  },
})
