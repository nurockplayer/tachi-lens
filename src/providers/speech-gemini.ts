// Gemini speech adapter — v0.3 speech translation wave.
//
// Implements SpeechProvider (speech-types.ts) against the frozen Gemini
// generateContent (non-live) API. It performs one bounded-window, request-per-
// chunk transcription + translation call and never holds a long-lived session.
// The Live WebSocket API is explicitly deferred (Spec §13).

import type { ProviderError } from '@/shared/messages'
import {
  getGeminiErrorMessage,
  getGeminiErrorStatus,
  getGeminiRetryAfterMs,
  isRecord,
  readGeminiErrorBody,
} from './gemini-errors'
import {
  SPEECH_GEMINI_DEFAULT_MODEL,
  SPEECH_GEMINI_MODELS,
  type AudioChunk,
  type SpeechProvider,
  type SpeechTranslationResult,
} from './speech-types'

export const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * D2 decision (verified-by-adapter, Issue #159): the frozen Gemini 2.5 audio
 * input surface is the `inlineData` audio part. The Gemini API does not accept
 * raw `audio/pcm;rate=16000` bytes as `inlineData` — inline audio parts must be
 * a recognized container such as `audio/wav` (documented; e.g. the curl
 * generateContent + `include_audio` code samples ship WAV files). Raw PCM bytes
 * would be treated as an unrecognized/invalid MIME and rejected. We therefore
 * wrap every PCM chunk in a minimal 16-bit PCM WAV header (`audio/wav`) before
 * base64-encoding; base64 is mandatory for `inlineData` (`GenerateContentRequest`
 * `Part.data`).
 */
export const SPEECH_AUDIO_MIME_TYPE = 'audio/wav'

/** Builds a minimal 16-bit mono WAV container for a PCM chunk (D2). */
export const toWav = (pcm: ArrayBuffer, sampleRate: number): ArrayBuffer => {
  const out = new ArrayBuffer(44 + pcm.byteLength)
  const view = new DataView(out)
  const bytes = new Uint8Array(out)

  const writeAscii = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeAscii(8, 'WAVE')

  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate = sampleRate * blockAlign
  view.setUint16(32, 2, true) // blockAlign = channels * bytesPerSample
  view.setUint16(34, 16, true) // bits per sample

  writeAscii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)

  bytes.set(new Uint8Array(pcm), 44)
  return out
}

const encodeBase64 = (bytes: ArrayBuffer): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const input = new Uint8Array(bytes)
  let out = ''
  for (let i = 0; i < input.length; i += 3) {
    const b0 = input[i] ?? 0
    const b1 = i + 1 < input.length ? input[i + 1] : undefined
    const b2 = i + 2 < input.length ? input[i + 2] : undefined

    out += alphabet.charAt(b0 >> 2)
    out += alphabet.charAt(((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4))

    if (b1 === undefined) {
      out += '=='
      continue
    }

    out += alphabet.charAt(((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6))

    if (b2 === undefined) {
      out += '='
      continue
    }

    out += alphabet.charAt(b2 & 63)
  }
  return out
}

const SAMPLE_RATE = 16_000

/** "Transcribe, then translate to <targetLang>." one-shot per window (D3). */
export const buildSpeechPrompt = (targetLang: string): string =>
  `Transcribe the speech in this audio into its original language and translate it to ${targetLang}. ` +
  'Return JSON only, no markdown, with this exact shape: ' +
  '{"transcript":"the verbatim source-language transcription","translation":"the translation"}. ' +
  'If there is no speech in the audio, return {"transcript":"","translation":""}.'

const isChunk = (value: unknown): value is AudioChunk =>
  isRecord(value) && typeof value.chunkId === 'string'

const resultFor = (
  chunk: AudioChunk,
  transcript: string,
  translation: string | undefined,
): SpeechTranslationResult => {
  const isFinal = chunk.isFinal === true
  // Per the Spec contract, translatedText is present only on final chunks.
  const usableTranslation =
    isFinal && translation !== undefined && translation.length > 0 ? translation : undefined

  return {
    id: chunk.chunkId,
    text: transcript,
    ...(usableTranslation !== undefined ? { translatedText: usableTranslation } : {}),
    ...(chunk.startMs !== undefined ? { startMs: chunk.startMs } : {}),
    ...(chunk.endMs !== undefined ? { endMs: chunk.endMs } : {}),
    ...(isFinal ? { isFinal: true } : {}),
  }
}

const errorResultFor = (chunk: AudioChunk, error: ProviderError): SpeechTranslationResult => ({
  id: chunk.chunkId,
  text: '',
  ...(chunk.startMs !== undefined ? { startMs: chunk.startMs } : {}),
  ...(chunk.endMs !== undefined ? { endMs: chunk.endMs } : {}),
  error,
})

/**
 * Maps a non-ok generateContent response to a ProviderError (taxonomy:
 * auth / rate_limited / quota_exceeded / bad_request / network).
 */
const mapGeminiError = (
  response: Response,
  body: Record<string, unknown> | undefined,
): ProviderError => {
  const message = getGeminiErrorMessage(body) ?? `Gemini speech API error (${response.status})`
  const status = getGeminiErrorStatus(body)
  const retryAfterMs = getGeminiRetryAfterMs(response, body)

  // Gemini RPC-style 429s (google.rpc.RetryInfo / error.status) carry an exact
  // cooldown; the strict taxonomy distinguishes rate limits from quota.
  const isRateStatus =
    response.status === 429 ||
    (status !== undefined && status.toUpperCase().includes('RATE'))
  const isQuotaStatus = status !== undefined && status.toUpperCase().includes('RESOURCE_EXHAUSTED')

  if (isRateStatus && !isQuotaStatus) {
    return { type: 'rate_limited', retryAfterMs: retryAfterMs ?? 1_000, message }
  }
  if (isQuotaStatus) {
    return { type: 'quota_exceeded', message }
  }

  if (response.status === 401 || response.status === 403) {
    return { type: 'auth', status: response.status, message }
  }
  if (response.status >= 400 && response.status < 500) {
    return { type: 'bad_request', status: response.status, message }
  }
  return { type: 'network', message }
}

export const createGeminiSpeechProvider = (
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): SpeechProvider => ({
  id: 'gemini',
  displayName: 'Gemini',
  models: SPEECH_GEMINI_MODELS,
  defaultModel: SPEECH_GEMINI_DEFAULT_MODEL,

  async transcribeChunk(chunk, apiKey, model, targetLang, signal) {
    if (!isChunk(chunk)) {
      return [errorResultFor(chunk, { type: 'bad_request', status: 400, message: 'Invalid audio chunk' })]
    }

    try {
      const audio = toWav(chunk.data, SAMPLE_RATE)
      const payload = {
        contents: [
          {
            parts: [
              { inlineData: { mimeType: SPEECH_AUDIO_MIME_TYPE, data: encodeBase64(audio) } },
              { text: buildSpeechPrompt(targetLang) },
            ],
          },
        ],
      }

      const response = await fetchFn(`${BASE_URL}/models/${model}:generateContent`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorBody = await readGeminiErrorBody(response)
        return [errorResultFor(chunk, mapGeminiError(response, errorBody))]
      }

      const data: unknown = await response.json()
      const text = extractSpeechText(data)

      // No text part at all (missing/invalid candidates) is an invalid response.
      if (text === undefined) {
        return [
          errorResultFor(chunk, {
            type: 'invalid_response',
            message: 'Gemini returned an unrecognized speech response',
          }),
        ]
      }

      // An empty transcript is a valid "no speech" result, not an error; the
      // pipeline's VAD gate already skips silent segments (Spec §2, §10).
      if (!text) {
        return [resultFor(chunk, '', undefined)]
      }

      const parsed = parseSpeechJson(text)
      if (!parsed) {
        return [
          errorResultFor(chunk, {
            type: 'invalid_response',
            message: 'Gemini returned an unrecognized speech response',
          }),
        ]
      }

      const transcript = parsed.transcript?.trim() ?? ''
      return [resultFor(chunk, transcript, parsed.translation?.trim() || undefined)]
    } catch (err) {
      // A caller-initiated abort is surfaced as-is (the pipeline owns lifecycle).
      // Real abort rejects are DOMException AbortError (name only, not instanceof Error).
      if (isAbortError(err)) {
        return [errorResultFor(chunk, { type: 'timeout', message: err instanceof Error ? err.message : 'Request aborted' })]
      }

      return [
        errorResultFor(chunk, {
          type: 'network',
          message: err instanceof Error ? err.message : 'Unknown Gemini speech error',
        }),
      ]
    }
  },

  async validateKey(apiKey) {
    try {
      const response = await fetchFn(`${BASE_URL}/models`, {
        headers: { 'x-goog-api-key': apiKey },
      })
      return {
        valid: response.ok,
        error: response.ok ? undefined : `Gemini speech key validation failed (${response.status})`,
      }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  },
})

const isAbortError = (err: unknown): boolean =>
  (err instanceof Error && err.name === 'AbortError') ||
  (isRecord(err) && err.name === 'AbortError')

/** Extracts the first text part from a generateContent response (mirrors chat). */
const extractSpeechText = (data: unknown): string | undefined => {
  const candidates = (data as Record<string, unknown>).candidates as Array<Record<string, unknown>> | undefined
  const parts = candidates?.[0]?.content as Record<string, unknown> | undefined
  const textParts = parts?.parts as Array<Record<string, unknown>> | undefined
  const textPart = textParts?.find((p) => typeof p.text === 'string')
  const text = textPart?.text
  return typeof text === 'string' ? text.trim() : undefined
}

const parseSpeechJson = (
  text: string | undefined,
): { transcript?: string; translation?: string } | undefined => {
  if (!text) return undefined
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return undefined
  }

  if (!isRecord(parsed)) return undefined
  return {
    ...(typeof parsed.transcript === 'string' ? { transcript: parsed.transcript } : {}),
    ...(typeof parsed.translation === 'string' ? { translation: parsed.translation } : {}),
  }
}
