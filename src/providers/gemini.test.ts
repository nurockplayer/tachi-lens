import { describe, expect, it, vi } from 'vitest'
import { createGeminiProvider } from './gemini'

const mockFetch = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))

const REQS = [
  { id: 'm1', text: 'Hello chat' },
  { id: 'm2', text: 'How are you?' },
]

const GEMINI_BODY = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] } }],
})

describe('Gemini provider', () => {
  describe('translateBatch', () => {
    it('uses a future HTTP-date Retry-After header before Gemini body retry metadata', async () => {
      const now = Date.now()
      const future = new Date(now + 60_000).toUTCString()
      const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: {
          message: 'Gemini quota exhausted',
          details: [{
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '5s',
          }],
        },
      }), { status: 429, headers: { 'Retry-After': future } }))
      const provider = createGeminiProvider(fetchFn)

      const [result] = await provider.translateBatch(REQS, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result?.retryAfterMs).toBeGreaterThan(50_000)
      expect(result?.retryAfterMs).toBeLessThanOrEqual(60_000)
    })
    it('translates a batch of messages', async () => {
      const fetchFn = mockFetch(200, GEMINI_BODY('[{"id":"m1","translated_text":"你好"},{"id":"m2","translated_text":"你好嗎"}]'))
      const provider = createGeminiProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(results).toEqual([
        { id: 'm1', translatedText: '你好' },
        { id: 'm2', translatedText: '你好嗎' },
      ])
    })

    it('returns error for non-ok response', async () => {
      const fetchFn = mockFetch(403, { error: { message: 'API key not valid' } })
      const provider = createGeminiProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'bad-key', 'gemini-2.5-flash', 'zh-TW')

      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({
        id: 'm1',
        error: 'API key not valid',
        status: 403,
      })
    })

    it('preserves Gemini 429 details and retry delay', async () => {
      const fetchFn = mockFetch(429, {
        error: {
          message: 'Quota exceeded for gemini-2.5-flash',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: '44.5s',
            },
          ],
        },
      })
      const provider = createGeminiProvider(fetchFn)

      const results = await provider.translateBatch(
        REQS,
        'fake-key',
        'gemini-2.5-flash',
        'zh-TW',
      )

      expect(results[0]).toEqual({
        id: 'm1',
        error: 'Quota exceeded for gemini-2.5-flash',
        status: 429,
        retryAfterMs: 44_500,
      })
      expect(results[1]).toEqual({
        id: 'm2',
        error: 'Quota exceeded for gemini-2.5-flash',
        status: 429,
        retryAfterMs: 44_500,
      })
    })

    it('prefers the Retry-After header for Gemini 429 cooldown', async () => {
      const fetchFn = vi.fn().mockResolvedValue(new Response(
        JSON.stringify({
          error: {
            message: 'Request rate exceeded',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                retryDelay: '44s',
              },
            ],
          },
        }),
        { status: 429, headers: { 'Retry-After': '12.5' } },
      ))
      const provider = createGeminiProvider(fetchFn)

      const results = await provider.translateBatch(
        REQS,
        'fake-key',
        'gemini-2.5-flash',
        'zh-TW',
      )

      expect(results[0]!.retryAfterMs).toBe(12_500)
    })

    it('returns safe metadata when the Gemini error body is malformed', async () => {
      const fetchFn = vi.fn().mockResolvedValue(new Response('not-json', { status: 503 }))
      const provider = createGeminiProvider(fetchFn)

      const results = await provider.translateBatch(
        REQS,
        'fake-key',
        'gemini-2.5-flash',
        'zh-TW',
      )

      expect(results[0]).toEqual({
        id: 'm1',
        error: 'Gemini API error (503)',
        status: 503,
      })
    })

    it('returns error when candidates array is missing', async () => {
      const fetchFn = mockFetch(200, {})
      const provider = createGeminiProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(results[0]!.error).toBe('Empty response from Gemini')
    })

    it('returns error on network failure', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'))
      const provider = createGeminiProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(results[0]!.error).toBe('Network error')
    })
  })

  describe('validateKey', () => {
    it('validates a correct key', async () => {
      const fetchFn = mockFetch(200, { models: [{ name: 'models/gemini-2.5-flash' }] })
      const provider = createGeminiProvider(fetchFn)

      const result = await provider.validateKey('good-key')

      expect(result.valid).toBe(true)
    })

    it('rejects an invalid key', async () => {
      const fetchFn = mockFetch(403, {})
      const provider = createGeminiProvider(fetchFn)

      const result = await provider.validateKey('bad-key')

      expect(result.valid).toBe(false)
      expect(result.error).toContain('403')
    })

    it('handles network error during validation', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'))
      const provider = createGeminiProvider(fetchFn)

      const result = await provider.validateKey('key')

      expect(result.valid).toBe(false)
      expect(result.error).toBe('Network error')
    })
  })
})
