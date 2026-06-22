import { describe, expect, it, vi } from 'vitest'
import { createClaudeProvider } from './claude'

const mockFetch = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))

const REQS = [
  { id: 'm1', text: 'Hello' },
  { id: 'm2', text: 'World' },
]

const CLAUDE_BODY = (text: string) => ({
  content: [{ type: 'text', text }],
})

describe('Claude provider', () => {
  describe('translateBatch', () => {
    it('translates a batch of messages', async () => {
      const fetchFn = mockFetch(200, CLAUDE_BODY('[{"id":"m1","translated_text":"你好"},{"id":"m2","translated_text":"世界"}]'))
      const provider = createClaudeProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'fake-key', 'claude-3-5-haiku-latest', 'zh-TW')

      expect(results).toEqual([
        { id: 'm1', translatedText: '你好' },
        { id: 'm2', translatedText: '世界' },
      ])
    })

    it('returns error for non-ok response', async () => {
      const fetchFn = mockFetch(401, { error: { message: 'Invalid API key' } })
      const provider = createClaudeProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'bad-key', 'claude-3-5-haiku-latest', 'zh-TW')

      expect(results[0]!.error).toContain('401')
    })

    it('returns error when content is missing', async () => {
      const fetchFn = mockFetch(200, {})
      const provider = createClaudeProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'fake-key', 'claude-3-5-haiku-latest', 'zh-TW')

      expect(results[0]!.error).toBe('Empty response from Claude')
    })

    it('returns error on network failure', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'))
      const provider = createClaudeProvider(fetchFn)

      const results = await provider.translateBatch(REQS, 'fake-key', 'claude-3-5-haiku-latest', 'zh-TW')

      expect(results[0]!.error).toBe('Network error')
    })
  })

  describe('validateKey', () => {
    it('validates a correct key', async () => {
      const fetchFn = mockFetch(200, { data: [{ id: 'claude-3-5-haiku-latest' }] })
      const provider = createClaudeProvider(fetchFn)

      const result = await provider.validateKey('good-key')

      expect(result.valid).toBe(true)
    })

    it('rejects an invalid key', async () => {
      const fetchFn = mockFetch(401, {})
      const provider = createClaudeProvider(fetchFn)

      const result = await provider.validateKey('bad-key')

      expect(result.valid).toBe(false)
      expect(result.error).toContain('401')
    })

    it('handles network error', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'))
      const provider = createClaudeProvider(fetchFn)

      const result = await provider.validateKey('key')

      expect(result.valid).toBe(false)
      expect(result.error).toBe('Network error')
    })
  })
})
