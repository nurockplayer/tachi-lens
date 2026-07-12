import { buildTranslationPrompt, parseTranslationResponse } from './prompt'
import type { BatchItemResult, ProviderModel, TranslationProvider } from './types'

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
        const errorBody = await readGeminiErrorBody(response)
        const error = getGeminiErrorMessage(errorBody) ?? `Gemini API error (${response.status})`
        const retryAfterMs = getRetryAfterMs(response, errorBody)

        return allErrors(requests, error, {
          status: response.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        })
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readGeminiErrorBody = async (response: Response): Promise<Record<string, unknown> | undefined> => {
  try {
    const body: unknown = await response.json()
    return isRecord(body) ? body : undefined
  } catch {
    return undefined
  }
}

const getGeminiErrorMessage = (body: Record<string, unknown> | undefined): string | undefined => {
  const error = body?.error
  if (!isRecord(error) || typeof error.message !== 'string') return undefined

  const message = error.message.trim()
  return message ? message.slice(0, 500) : undefined
}

const parseSeconds = (value: string): number | undefined => {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)s?$/i)
  if (!match) return undefined

  const seconds = Number(match[1])
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined
}

const getRetryAfterMs = (
  response: Response,
  body: Record<string, unknown> | undefined,
): number | undefined => {
  const headerDelay = response.headers.get('retry-after')
  if (headerDelay) {
    const parsedHeader = parseSeconds(headerDelay)
    if (parsedHeader !== undefined) return parsedHeader
  }

  const error = body?.error
  if (!isRecord(error) || !Array.isArray(error.details)) return undefined

  for (const detail of error.details) {
    if (!isRecord(detail)) continue
    if (detail['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo') continue
    if (typeof detail.retryDelay !== 'string') continue

    const parsedDetail = parseSeconds(detail.retryDelay)
    if (parsedDetail !== undefined) return parsedDetail
  }

  return undefined
}

const allErrors = (
  requests: { id: string }[],
  error: string,
  metadata: Partial<Pick<BatchItemResult, 'status' | 'retryAfterMs'>> = {},
) => requests.map((r) => ({ id: r.id, error, ...metadata }))
