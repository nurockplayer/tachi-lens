import { describe, expect, it, vi } from 'vitest'
import { createClaudeProvider } from './claude'
import { createDeepSeekProvider } from './deepseek'
import { createGeminiProvider } from './gemini'
import { createOpenAIProvider } from './openai'

const providers = [
  ['Gemini', createGeminiProvider],
  ['DeepSeek', createDeepSeekProvider],
  ['OpenAI', createOpenAIProvider],
  ['Claude', createClaudeProvider],
] as const
const request = [{ id: 'm1', text: 'synthetic test message' }]

describe('runtime provider failure classification — issue #209', () => {
  it.each(providers)('%s marks authentication/configuration and transient HTTP failures distinctly', async (_name, createProvider) => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(signal)
      return response(status, status === 429 ? { 'retry-after': '3' } : {})
    })
    const provider = createProvider(fetchFn)
    const signal = new AbortController().signal
    let status = 401
    let result = await provider.translateBatch(request, 'key', provider.defaultModel, 'ja', signal)
    expect(result[0]?.errorType).toBe('auth')

    status = 400
    result = await provider.translateBatch(request, 'key', provider.defaultModel, 'ja', signal)
    expect(result[0]?.errorType).toBe('bad_request')

    status = 408
    result = await provider.translateBatch(request, 'key', provider.defaultModel, 'ja', signal)
    expect(result[0]?.errorType).toBe('timeout')

    status = 503
    result = await provider.translateBatch(request, 'key', provider.defaultModel, 'ja', signal)
    expect(result[0]?.errorType).toBe('network')

    status = 429
    result = await provider.translateBatch(request, 'key', provider.defaultModel, 'ja', signal)
    expect(result[0]?.errorType).toBe('rate_limited')
    expect(result[0]?.retryAfterMs).toBeGreaterThan(0)
  })

  it.each(providers)('%s marks empty/malformed success bodies invalid and catches timeouts', async (_name, createProvider) => {
    const fetchFn = vi.fn().mockResolvedValue(response(200))
    const provider = createProvider(fetchFn)
    const result = await provider.translateBatch(request, 'key', provider.defaultModel, 'ja')
    expect(result[0]?.errorType).toBe('invalid_response')

    fetchFn.mockRejectedValueOnce(new DOMException('The operation timed out', 'TimeoutError'))
    const timedOut = await provider.translateBatch(request, 'key', provider.defaultModel, 'ja')
    expect(timedOut[0]?.errorType).toBe('timeout')
  })
})

const response = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({}), { status, headers })
