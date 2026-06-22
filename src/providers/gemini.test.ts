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
      expect(results[0]!.error).toContain('403')
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
