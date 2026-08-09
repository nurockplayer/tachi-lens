// Speech provider types — v0.3 speech translation wave (Spec docs/specs/v0.3-speech-translation.md).
// Reuses ProviderModel (providers/types.ts) and ProviderError / KeyValidationResult
// (shared/messages.ts). Speech is a separate pipeline from chat translation: it has its
// own provider configuration, its own API-key namespace, and its own cost accounting.

import type { KeyValidationResult, ProviderModel } from './types'
import type { ProviderError } from '@/shared/messages'

export const SPEECH_PROVIDER_IDS = ['gemini'] as const

export type SpeechProviderId = (typeof SPEECH_PROVIDER_IDS)[number]

export const isSpeechProviderId = (value: string): value is SpeechProviderId =>
  SPEECH_PROVIDER_IDS.includes(value as SpeechProviderId)

/**
 * Config-side Gemini speech model metadata. The actual provider adapter
 * (speech-gemini.ts, owned by the adapter Issue) implements the network call;
 * this list only drives the settings default and the Popup model select.
 */
export const SPEECH_GEMINI_MODELS: readonly ProviderModel[] = [
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
]

export const SPEECH_GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash'

/** Storage-facing speech configuration. Global-only in v0.3 (no per-channel overrides). */
export interface SpeechTranslationConfig {
  /** Default false — capture is gesture-gated and never auto-starts. */
  speechEnabled: boolean
  /** Only Gemini in v0.3 (Spec §13). */
  speechProvider: SpeechProviderId
  /** Default GEMINI speech model (SPEECH_GEMINI_DEFAULT_MODEL). */
  speechModel: string
  /** Independent of chat targetLanguage. */
  speechTargetLanguage: string
  /** Subtitle overlay keeps the last N rendered cues. Default 2. */
  captionMaxLines: number
  /** Overlay opacity percent, 0..100. Default 100. */
  captionOpacity: number
  /** Hard per-session cap in minutes. Default 30. */
  maxSessionMinutes: number
}

/** One bounded ~200–500 ms PCM chunk forwarded from the offscreen capture to the SW. */
export interface AudioChunk {
  chunkId: string
  /** 16 kHz mono 16-bit little-endian PCM. */
  data: ArrayBuffer
  /** 'audio/pcm;rate=16000' per Spec §5. */
  mimeType: string
  startMs?: number
  endMs?: number
  isFinal?: boolean
}

/** Per-chunk transcription (and, on final, translation) result. */
export interface SpeechTranslationResult {
  id: string
  /** Transcribed source-language text (interim or final). */
  text: string
  /** Present only on final chunks. */
  translatedText?: string
  startMs?: number
  endMs?: number
  isFinal?: boolean
  /** Reuses the ProviderError union from shared/messages.ts. */
  error?: ProviderError
}

/**
 * Speech provider contract — deliberately NOT an overload of TranslationProvider.
 * `transcribeChunk` is a non-live, bounded-window, request-per-chunk call.
 */
export interface SpeechProvider {
  readonly id: SpeechProviderId
  readonly displayName: string
  readonly models: readonly ProviderModel[]
  readonly defaultModel: string
  transcribeChunk(
    chunk: AudioChunk,
    apiKey: string,
    model: string,
    targetLang: string,
    signal?: AbortSignal,
  ): Promise<SpeechTranslationResult[]>
  validateKey(apiKey: string): Promise<KeyValidationResult>
}
