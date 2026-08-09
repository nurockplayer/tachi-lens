import { describe, expect, it, vi } from 'vitest'
import {
  BASE_URL,
  SPEECH_AUDIO_MIME_TYPE,
  buildSpeechPrompt,
  createGeminiSpeechProvider,
  toWav,
} from './speech-gemini'
import type { AudioChunk } from './speech-types'

const mockFetch = (status: number, body: unknown, init?: ResponseInit) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, ...init }))

/** 4 bytes of 16-bit mono PCM (two samples). */
const PCM = new Uint8Array([0x10, 0x00, 0x20, 0x00]).buffer

// Precomputed by the WAV builder (16 kHz mono 16-bit): RIFF header + 4 PCM bytes.
const EXPECTED_WAV_BASE64 = 'UklGRigAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQQAAAAQACAA'

const CHUNK: AudioChunk = {
  chunkId: 'c1',
  data: PCM,
  mimeType: 'audio/pcm;rate=16000',
  startMs: 0,
  endMs: 500,
  isFinal: true,
}

const SPEECH_BODY = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] } }],
})

describe('Gemini speech provider', () => {
  describe('transcribeChunk', () => {
    it('posts generateContent with base64 audio/wav inlineData and the transcribe+translate prompt', async () => {
      const fetchFn = mockFetch(
        200,
        SPEECH_BODY(JSON.stringify({ transcript: 'hello there', translation: '你好' })),
      )
      const provider = createGeminiSpeechProvider(fetchFn)

      await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(fetchFn).toHaveBeenCalledTimes(1)
      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]

      expect(url).toBe(`${BASE_URL}/models/gemini-2.5-flash:generateContent`)
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        'x-goog-api-key': 'fake-key',
      })

      const body = JSON.parse(String(init.body)) as {
        contents: [{ parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> }]
      }
      const inlineData = body.contents?.[0]?.parts?.find((p) => p.inlineData)?.inlineData
      const textPart = body.contents?.[0]?.parts?.find((p) => p.text)?.text

      expect(inlineData).toEqual({ mimeType: SPEECH_AUDIO_MIME_TYPE, data: EXPECTED_WAV_BASE64 })
      expect(textPart).toBe(buildSpeechPrompt('zh-TW'))
      expect(textPart).toContain('zh-TW')
      expect(textPart).toContain('Transcribe')
    })

    it('wraps PCM in a minimal audio/wav container', () => {
      expect(SPEECH_AUDIO_MIME_TYPE).toBe('audio/wav')

      const wav = new Uint8Array(toWav(PCM, 16_000))
      const view = new DataView(wav.buffer)

      expect(wav.byteLength).toBe(48)
      expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
      expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
      expect(view.getUint32(24, true)).toBe(16_000) // sample rate
      expect(view.getUint16(22, true)).toBe(1) // mono
      expect(view.getUint16(34, true)).toBe(16) // bits per sample
      expect(view.getUint32(40, true)).toBe(PCM.byteLength) // data chunk size
    })

    it('returns transcript plus translatedText on the final chunk', async () => {
      const fetchFn = mockFetch(
        200,
        SPEECH_BODY(JSON.stringify({ transcript: '你好', translation: 'hello' })),
      )
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result).toEqual({
        id: 'c1',
        text: '你好',
        translatedText: 'hello',
        startMs: 0,
        endMs: 500,
        isFinal: true,
      })
    })

    it('returns transcript without translatedText when the model omits the translation', async () => {
      const fetchFn = mockFetch(
        200,
        SPEECH_BODY(JSON.stringify({ transcript: 'bonjour' })),
      )
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'fr')

      expect(result?.text).toBe('bonjour')
      expect(result?.translatedText).toBeUndefined()
    })

    it('suppresses translatedText on non-final (interim) chunks', async () => {
      const fetchFn = mockFetch(
        200,
        SPEECH_BODY(JSON.stringify({ transcript: 'partial', translation: '部分' })),
      )
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(
        { ...CHUNK, isFinal: false },
        'fake-key',
        'gemini-2.5-flash',
        'zh-TW',
      )

      expect(result).toMatchObject({ id: 'c1', text: 'partial' })
      expect(result?.isFinal).toBeUndefined()
      expect(result?.translatedText).toBeUndefined()
    })

    it('returns an empty-transcript success for no-speech audio', async () => {
      const fetchFn = mockFetch(200, SPEECH_BODY(''))
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result).toMatchObject({ id: 'c1', text: '' })
      expect(result?.translatedText).toBeUndefined()
      expect(result?.error).toBeUndefined()
    })

    it('returns invalid_response for an unparseable model response', async () => {
      const fetchFn = mockFetch(200, SPEECH_BODY('this is not json'))
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result?.error).toEqual({ type: 'invalid_response', message: 'Gemini returned an unrecognized speech response' })
    })

    it('returns invalid_response when the candidates array is missing', async () => {
      const fetchFn = mockFetch(200, {})
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result?.error?.type).toBe('invalid_response')
    })

    it('maps 401 to an auth ProviderError', async () => {
      const fetchFn = mockFetch(401, { error: { message: 'API key not valid' } })
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'bad-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result?.error).toEqual({ type: 'auth', status: 401, message: 'API key not valid' })
    })

    it('maps 429 with google.rpc.RetryInfo to a rate_limited ProviderError with retryAfterMs', async () => {
      const fetchFn = mockFetch(429, {
        error: {
          status: 'RATE_LIMITED',
          message: 'Request rate exceeded',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '44.5s' }],
        },
      })
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result?.error).toEqual({
        type: 'rate_limited',
        retryAfterMs: 44_500,
        message: 'Request rate exceeded',
      })
    })

    it('prefers the Retry-After header for the rate-limit cooldown', async () => {
      const fetchFn = mockFetch(
        429,
        { error: { message: 'Request rate exceeded' } },
        { headers: { 'Retry-After': '12.5' } },
      )
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result?.error).toMatchObject({ type: 'rate_limited', retryAfterMs: 12_500 })
    })

    it('maps RESOURCE_EXHAUSTED 429 to a quota_exceeded ProviderError', async () => {
      const fetchFn = mockFetch(429, {
        error: {
          status: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded for gemini-2.5-flash',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '15s' }],
        },
      })
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result?.error).toEqual({ type: 'quota_exceeded', message: 'Quota exceeded for gemini-2.5-flash' })
    })

    it('maps 400 to a bad_request ProviderError', async () => {
      const fetchFn = mockFetch(400, { error: { message: 'Invalid request payload' } })
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result?.error).toEqual({ type: 'bad_request', status: 400, message: 'Invalid request payload' })
    })

    it('maps a 5xx response to a network ProviderError with a safe message', async () => {
      const fetchFn = vi.fn().mockResolvedValue(new Response('not-json', { status: 503 }))
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result?.error).toEqual({ type: 'network', message: 'Gemini speech API error (503)' })
    })

    it('maps a network failure to a network ProviderError', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'))
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result?.error).toEqual({ type: 'network', message: 'Network error' })
    })

    it('maps an abort to a timeout ProviderError', async () => {
      const abortError = new Error('The operation was aborted')
      abortError.name = 'AbortError'
      const fetchFn = vi.fn().mockRejectedValue(abortError)
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW')

      expect(result?.error?.type).toBe('timeout')
    })

    it('rejects a malformed chunk without a network call', async () => {
      const fetchFn = vi.fn()
      const provider = createGeminiSpeechProvider(fetchFn)

      const [result] = await provider.transcribeChunk(
        { data: PCM } as unknown as AudioChunk,
        'fake-key',
        'gemini-2.5-flash',
        'zh-TW',
      )

      expect(fetchFn).not.toHaveBeenCalled()
      expect(result?.error).toEqual({ type: 'bad_request', status: 400, message: 'Invalid audio chunk' })
    })

    it('forwards the AbortSignal to fetch', async () => {
      const fetchFn = mockFetch(200, SPEECH_BODY('{}'))
      const provider = createGeminiSpeechProvider(fetchFn)
      const controller = new AbortController()

      await provider.transcribeChunk(CHUNK, 'fake-key', 'gemini-2.5-flash', 'zh-TW', controller.signal)

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
      expect(init.signal).toBe(controller.signal)
    })
  })

  describe('validateKey', () => {
    it('validates a correct key', async () => {
      const fetchFn = mockFetch(200, { models: [{ name: 'models/gemini-2.5-flash' }] })
      const provider = createGeminiSpeechProvider(fetchFn)

      const result = await provider.validateKey('good-key')

      expect(result.valid).toBe(true)
      expect(fetchFn).toHaveBeenCalledWith(
        `${BASE_URL}/models`,
        expect.objectContaining({ headers: { 'x-goog-api-key': 'good-key' } }),
      )
    })

    it('rejects an invalid key', async () => {
      const fetchFn = mockFetch(403, {})
      const provider = createGeminiSpeechProvider(fetchFn)

      const result = await provider.validateKey('bad-key')

      expect(result.valid).toBe(false)
      expect(result.error).toContain('403')
    })

    it('handles a network error during validation', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('Network error'))
      const provider = createGeminiSpeechProvider(fetchFn)

      const result = await provider.validateKey('key')

      expect(result.valid).toBe(false)
      expect(result.error).toBe('Network error')
    })
  })
})
