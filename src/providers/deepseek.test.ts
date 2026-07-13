import { describe, expect, it, vi } from 'vitest'
import { createDeepSeekProvider } from './deepseek'

const mockFetch = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))

const REQS = [
  { id: 'm1', text: 'Hello' },
  { id: 'm2', text: 'World' },
]

const CHAT_BODY = (text: string) => ({
  choices: [{ message: { content: text } }],
})

describe('DeepSeek provider', () => {
  describe('translateBatch', () => {
    it('parses a future HTTP-date Retry-After header', async () => {
      const future = new Date(Date.now() + 60_000).toUTCString()
      const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: { message: 'DeepSeek rate limit reached' },
      }), { status: 429, headers: { 'Retry-After': future } }))
      const provider = createDeepSeekProvider(fetchFn)

      const [result] = await provider.translateBatch(REQS, 'fake-key', 'deepseek-v4-flash', 'zh-TW')

      expect(result?.retryAfterMs).toBeGreaterThan(0)
      expect(result?.retryAfterMs).toBeLessThanOrEqual(60_000)
    })
    it('translates a batch of messages', async () => {
      const fetchFn = mockFetch(200, CHAT_BODY('[{"id":"m1","translated_text":"你好"},{"id":"m2","translated_text":"世界"}]'))
      const provider = createDeepSeekProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'fake-key', 'deepseek-v4-flash', 'zh-TW')

      expect(results).toEqual([
        { id: 'm1', translatedText: '你好' },
        { id: 'm2', translatedText: '世界' },
      ])
      const request = vi.mocked(fetchFn).mock.calls[0]![1] as RequestInit
      expect(JSON.parse(request.body as string)).toMatchObject({
        model: 'deepseek-v4-flash',
        thinking: { type: 'disabled' },
      })
    })

    it('returns error for non-ok response', async () => {
      const fetchFn = mockFetch(401, { error: { message: 'Invalid API Key' } })
      const provider = createDeepSeekProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'bad-key', 'deepseek-v4-flash', 'zh-TW')

      expect(results[0]).toEqual({
        id: 'm1',
        error: 'Invalid API Key',
        status: 401,
      })
    })

    it('preserves structured error status and Retry-After metadata', async () => {
      const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: { message: 'DeepSeek rate limit reached' },
      }), {
        status: 429,
        headers: { 'Retry-After': '12.5' },
      }))
      const provider = createDeepSeekProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'fake-key', 'deepseek-v4-flash', 'zh-TW')

      expect(results[0]).toEqual({
        id: 'm1',
        error: 'DeepSeek rate limit reached',
        status: 429,
        retryAfterMs: 12_500,
      })
    })

    it('returns error when choices are missing', async () => {
      const fetchFn = mockFetch(200, {})
      const provider = createDeepSeekProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'fake-key', 'deepseek-v4-flash', 'zh-TW')

      expect(results[0]!.error).toBe('Empty response from DeepSeek')
    })

    it('returns error on network failure', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'))
      const provider = createDeepSeekProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'fake-key', 'deepseek-v4-flash', 'zh-TW')

      expect(results[0]!.error).toBe('Network error')
    })
  })

  describe('validateKey', () => {
    it('validates a correct key', async () => {
      const fetchFn = mockFetch(200, { data: [{ id: 'deepseek-v4-flash' }] })
      const provider = createDeepSeekProvider(fetchFn)

      const result = await provider.validateKey('good-key')

      expect(result.valid).toBe(true)
    })

    it('rejects a key whose model list does not include DeepSeek V4 Flash', async () => {
      const fetchFn = mockFetch(200, { data: [{ id: 'another-model' }] })
      const provider = createDeepSeekProvider(fetchFn)

      const result = await provider.validateKey('valid-key-without-v4-flash')

      expect(result.valid).toBe(false)
      expect(result.error).toContain('deepseek-v4-flash')
    })

    it('rejects an invalid key', async () => {
      const fetchFn = mockFetch(401, {})
      const provider = createDeepSeekProvider(fetchFn)

      const result = await provider.validateKey('bad-key')

      expect(result.valid).toBe(false)
      expect(result.error).toContain('401')
    })

    it('handles network error', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'))
      const provider = createDeepSeekProvider(fetchFn)

      const result = await provider.validateKey('key')

      expect(result.valid).toBe(false)
      expect(result.error).toBe('Network error')
    })
  })
})
