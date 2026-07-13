import { buildTranslationPrompt, parseTranslationResponse } from './prompt'
import { parseRetryAfterMs } from './retry-after'
import type { BatchItemResult, ProviderModel, TranslationProvider } from './types'

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
          thinking: { type: 'disabled' },
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        }),
      })

      if (!response.ok) {
        const body = await readErrorBody(response)
        const error = getErrorMessage(body) ?? `DeepSeek API error (${response.status})`
        const retryAfterMs = getRetryAfterMs(response)

        return allErrors(requests, error, {
          status: response.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        })
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

      if (!response.ok) {
        return { valid: false, error: `DeepSeek key validation failed (${response.status})` }
      }

      const body: unknown = await response.json()
      const models = isRecord(body) && Array.isArray(body.data) ? body.data : []
      const hasV4Flash = models.some((model) => isRecord(model) && model.id === DEEPSEEK_DEFAULT_MODEL)

      return {
        valid: hasV4Flash,
        error: hasV4Flash ? undefined : `DeepSeek model "${DEEPSEEK_DEFAULT_MODEL}" is unavailable`,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readErrorBody = async (response: Response): Promise<Record<string, unknown> | undefined> => {
  try {
    const body: unknown = await response.json()
    return isRecord(body) ? body : undefined
  } catch {
    return undefined
  }
}

const getErrorMessage = (body: Record<string, unknown> | undefined): string | undefined => {
  const error = body?.error
  if (!isRecord(error) || typeof error.message !== 'string') return undefined

  const message = error.message.trim()
  return message ? message.slice(0, 500) : undefined
}

const getRetryAfterMs = (response: Response): number | undefined => {
  return parseRetryAfterMs(response.headers.get('retry-after'))
}

const allErrors = (
  requests: { id: string }[],
  error: string,
  metadata: Partial<Pick<BatchItemResult, 'status' | 'retryAfterMs'>> = {},
) => requests.map((r) => ({ id: r.id, error, ...metadata }))
