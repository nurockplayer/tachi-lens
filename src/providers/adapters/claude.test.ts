// Claude Provider Adapter Tests
// Tests for translateBatch() and validateKey() with success/failure cases.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClaudeProvider } from './claude'

const MOCK_API_KEY = 'mock-claude-key'
const MOCK_MODEL = 'claude-3-5-sonnet-20240620'
const MOCK_TARGET_LANG = 'zh-TW'

const mockFetch = vi.fn()
const provider = createClaudeProvider(mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

describe('Claude Provider', () => {
  describe('translateBatch()', () => {
    it('should translate a batch of messages successfully', async () => {
      const mockResponse = {
        content: [
          {
            text: JSON.stringify([
              { id: 'msg1', translated_text: '測試翻譯1' },
              { id: 'msg2', translated_text: '測試翻譯2' },
            ]),
          },
        ],
      }
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const requests = [
        { id: 'msg1', text: 'Test message 1' },
        { id: 'msg2', text: 'Test message 2' },
      ]
      const results = await provider.translateBatch(requests, MOCK_API_KEY, MOCK_MODEL, MOCK_TARGET_LANG)

      expect(results).toEqual([
        { id: 'msg1', translatedText: '測試翻譯1' },
        { id: 'msg2', translatedText: '測試翻譯2' },
      ])
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': MOCK_API_KEY,
            'anthropic-version': '2023-06-01',
          },
        }),
      )
    })

    it('should handle auth error (401)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
      })

      const requests = [{ id: 'msg1', text: 'Test message' }]
      const results = await provider.translateBatch(requests, 'invalid-key', MOCK_MODEL, MOCK_TARGET_LANG)

      expect(results).toEqual([
        { id: 'msg1', error: 'Invalid API key' },
      ])
    })

    it('should handle rate limit error (429)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Map([['retry-after', '10']]),
        json: () => Promise.resolve({ error: { message: 'Rate limit exceeded' } }),
      })

      const requests = [{ id: 'msg1', text: 'Test message' }]
      const results = await provider.translateBatch(requests, MOCK_API_KEY, MOCK_MODEL, MOCK_TARGET_LANG)

      expect(results).toEqual([
        { id: 'msg1', error: expect.stringContaining('Rate limit exceeded') },
      ])
    })
  })

  describe('validateKey()', () => {
    it('should return valid=true for a working key', async () => {
      const mockResponse = { content: [{ text: 'test' }] }
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await provider.validateKey(MOCK_API_KEY)
      expect(result).toEqual({ valid: true })
    })

    it('should return valid=false for an invalid key', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
      })

      const result = await provider.validateKey('invalid-key')
      expect(result).toEqual({ valid: false, error: 'Invalid API key' })
    })
  })
})