// Shared Gemini error-body parsing used by both the chat adapter (gemini.ts)
// and the speech adapter (speech-gemini.ts). Extracted verbatim from gemini.ts
// so the two adapters agree on message extraction, Retry-After, and
// google.rpc.RetryInfo parsing without changing chat behavior.

import { parseRetryAfterMs } from './retry-after'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const readGeminiErrorBody = async (response: Response): Promise<Record<string, unknown> | undefined> => {
  try {
    const body: unknown = await response.json()
    return isRecord(body) ? body : undefined
  } catch {
    return undefined
  }
}

export const getGeminiErrorMessage = (body: Record<string, unknown> | undefined): string | undefined => {
  const error = body?.error
  if (!isRecord(error) || typeof error.message !== 'string') return undefined

  const message = error.message.trim()
  return message ? message.slice(0, 500) : undefined
}

/** The rpc `error.status` string ('RESOURCE_EXHAUSTED', 'RATE_LIMITED', ...), if present. */
export const getGeminiErrorStatus = (body: Record<string, unknown> | undefined): string | undefined => {
  const error = body?.error
  return isRecord(error) && typeof error.status === 'string' ? error.status : undefined
}

const parseSeconds = (value: string): number | undefined => {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)s?$/i)
  if (!match) return undefined

  const seconds = Number(match[1])
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined
}

export const getGeminiRetryAfterMs = (
  response: Response,
  body: Record<string, unknown> | undefined,
): number | undefined => {
  const headerDelay = response.headers.get('retry-after')
  if (headerDelay) {
    const parsedHeader = parseRetryAfterMs(headerDelay) ?? parseSeconds(headerDelay)
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
