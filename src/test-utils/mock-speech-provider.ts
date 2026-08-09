// Shared deterministic speech provider mock (v0.3 speech, Spec §11).
//
// Extracted from the inline mock provider in speech-pipeline.test.ts. Returns a
// `SpeechProvider` whose `transcribeChunk`/`validateKey` are vi.fn spies backed
// by a deterministic canned-results map keyed by `chunkFingerprint(chunk)` — the
// same scripted chunks always resolve to the same results. Tests may override
// the spies per-test with mockImplementation, or configure canned results.

import { vi } from 'vitest'
import type { AudioChunk, SpeechProvider, SpeechTranslationResult } from '@/providers/speech-types'
import type { KeyValidationResult } from '@/providers/types'
import { chunkFingerprint, resolveMockTranscription, type MockTranscript } from './fake-speech-source'

/** Narrow surface tests drive to configure/assert the mock provider. */
export interface MockSpeechProviderHandle {
  transcribeChunk: ReturnType<typeof vi.fn>
  validateKey: ReturnType<typeof vi.fn>
  /** Canned results consulted by the default transcribeChunk implementation. */
  cannedResults: Map<string, SpeechTranslationResult[]>
  /** Replace the canned-results map (chunk fingerprint → results). */
  setCannedResults(results: Record<string, SpeechTranslationResult[]>): void
}

export interface MockSpeechProviderOptions {
  /** Optional fingerprint → transcript map resolved via resolveMockTranscription. */
  transcripts?: Record<string, MockTranscript>
}

export const createMockSpeechProvider = (
  options: MockSpeechProviderOptions = {},
): { provider: SpeechProvider; handle: MockSpeechProviderHandle } => {
  const cannedResults = new Map<string, SpeechTranslationResult[]>()

  const transcribeChunk = vi.fn(
    async (chunk: AudioChunk): Promise<SpeechTranslationResult[]> => {
      const canned = cannedResults.get(chunkFingerprint(chunk))
      if (canned) return canned
      if (options.transcripts) return resolveMockTranscription(chunk, options.transcripts)
      return []
    },
  )
  const validateKey = vi.fn(async (_apiKey: string): Promise<KeyValidationResult> => ({ valid: true }))

  const provider: SpeechProvider = {
    id: 'gemini',
    displayName: 'Gemini',
    models: [],
    defaultModel: 'gemini-2.5-flash',
    transcribeChunk,
    validateKey,
  }

  return {
    provider,
    handle: {
      transcribeChunk,
      validateKey,
      cannedResults,
      setCannedResults: (results: Record<string, SpeechTranslationResult[]>) => {
        cannedResults.clear()
        for (const [key, value] of Object.entries(results)) cannedResults.set(key, value)
      },
    },
  }
}
