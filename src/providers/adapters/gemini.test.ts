// Gemini Provider Adapter Tests
// Tests for translateBatch() and validateKey() with success/failure cases.

import { createGeminiProvider } from './gemini'
import type { BatchItemResult, KeyValidationResult } from '../types'

const MOCK_API_KEY = 'mock-gemini-key'
const MOCK_MODEL = 'gemini-1.5-flash'
const MOCK_TARGET_LANG = 'zh-TW'

const mockFetch = vi.fn()
const provider = createGeminiProvider(mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

describe('Gemini Provider', () => {
  describe('translateBatch()', () => {
    it('should translate a batch of messages successfully', async () => {
      const mockResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify([
                    { id: 'msg1', translated_text: '測試翻譯1' },
                    { id: 'msg2', translated_text: '測試翻譯2' },
                  ]),
                },
              ],
            },
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
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': MOCK_API_KEY,
          },
        }),
      )
    })

    it('should handle auth error (401)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { message: 'API key invalid' } }),
      })

      const requests = [{ id: 'msg1', text: 'Test message' }]
      const results = await provider.translateBatch(requests, 'invalid-key', MOCK_MODEL, MOCK_TARGET_LANG)

      expect(results).toEqual([
        { id: 'msg1', error: 'API key invalid' },
      ])
    })

    it('should handle rate limit error (429)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Map([['retry-after', '10']]),
        json: () => Promise.resolve({ error: { message: 'Rate limited' } }),
      })

      const requests = [{ id: 'msg1', text: 'Test message' }]
      const results = await provider.translateBatch(requests, MOCK_API_KEY, MOCK_MODEL, MOCK_TARGET_LANG)

      expect(results).toEqual([
        { id: 'msg1', error: expect.stringContaining('Rate limited') },
      ])
    })
  })

  describe('validateKey()', () => {
    it('should return valid=true for a working key', async () => {
      const mockResponse = {}
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result: KeyValidationResult = await provider.validateKey(MOCK_API_KEY)
      expect(result).toEqual({ valid: true })
    })

    it('should return valid=false for an invalid key', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { message: 'API key invalid' } }),
      })

      const result: KeyValidationResult = await provider.validateKey('invalid-key')
      expect(result).toEqual({ valid: false, error: 'API key invalid' })
    })
  })
})