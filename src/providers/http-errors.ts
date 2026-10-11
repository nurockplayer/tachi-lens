import { parseRetryAfterMs } from './retry-after'
import type { BatchItemResult } from './types'

export const classifyProviderHttpFailure = (
  status: number,
  response: Response,
): Pick<BatchItemResult, 'status' | 'errorType' | 'retryAfterMs'> => {
  if (status === 401 || status === 403) return { status, errorType: 'auth' }
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
    return { status, errorType: 'rate_limited', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
  }
  if (status === 408) return { status, errorType: 'timeout' }
  if (status >= 500) return { status, errorType: 'network' }
  return { status, errorType: 'bad_request' }
}

export const classifyProviderThrownError = (error: unknown): 'timeout' | 'network' =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    ? 'timeout'
    : 'network'
