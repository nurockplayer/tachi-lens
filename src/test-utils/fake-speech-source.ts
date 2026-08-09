// Shared deterministic fake speech source (v0.3 speech, Spec §11).
//
// Extracted from the inline fakes in speech-pipeline.test.ts so future speech
// unit/E2E tests (and the next wave) reuse one deterministic `SpeechSource`.
// Fully deterministic: no timers, no real audio, no chrome/tabCapture/media
// dependency. `start`/`stop` are vi.fn spies so tests assert call counts like
// the pipeline tests do; chunks/errors/disconnects are pushed synchronously by
// the test, which controls timing entirely.

import { vi } from 'vitest'
import type { SpeechSource } from '@/background/speech-capture'
import type { SpeechCaptureError } from '@/offscreen/protocol'
import type { AudioChunk, SpeechTranslationResult } from '@/providers/speech-types'

/** 1 s of full-scale 16-bit PCM at 16 kHz (RMS ~32767). */
export const loudPcm = (): ArrayBuffer => {
  const samples = 16_000
  const buffer = new ArrayBuffer(samples * 2)
  const view = new Int16Array(buffer)
  for (let i = 0; i < samples; i++) view[i] = 32000
  return buffer
}

/** 1 s of silence at 16 kHz (all-zero 16-bit PCM). */
export const silentPcm = (): ArrayBuffer => {
  const buffer = new ArrayBuffer(16_000 * 2)
  new Int16Array(buffer).fill(0)
  return buffer
}

/** A loud, non-final, 1 s chunk with the standard speech MIME type. */
export const mkChunk = (overrides: Partial<AudioChunk> = {}): AudioChunk => ({
  chunkId: 'c',
  data: loudPcm(),
  mimeType: 'audio/pcm;rate=16000',
  startMs: 0,
  endMs: 1000,
  isFinal: false,
  ...overrides,
})

/** A fluent (contiguous) 1 s chunk starting at `startMs` with a stable chunkId. */
export const fluentChunk = (
  startMs: number,
  endMs: number,
  overrides: Partial<AudioChunk> = {},
): AudioChunk => mkChunk({ startMs, endMs, chunkId: `c${startMs}`, ...overrides })

/**
 * Deterministic content fingerprint for a chunk. Derived only from the PCM
 * samples and the final/interim phase, so identical scripted chunks always
 * produce identical fingerprints — used to key canned mock-provider results.
 */
export const chunkFingerprint = (chunk: AudioChunk): string => {
  const samples = new Int16Array(chunk.data)
  let hash = 0x811c9dc5 // FNV-1a offset basis
  for (let i = 0; i < samples.length; i++) {
    hash ^= samples[i]!
    hash = Math.imul(hash, 0x01000193)
  }
  const phase = chunk.isFinal === true ? 'final' : 'interim'
  return `pcm16:${hash >>> 0}:${phase}`
}

/** One deterministic transcript entry (interim source text + final translation). */
export interface MockTranscript {
  /** Interim source-language text. */
  text: string
  /** Final translated text (only used on final chunks). */
  translatedText?: string
}

/**
 * Deterministic chunk→transcript resolver, mirroring `resolveMockTranslation`
 * in deepseek-mock-text.ts. Given an AudioChunk returns a stable transcript:
 * - With a `transcripts` map: exact fingerprint match; a miss throws a
 *   descriptive error listing the accepted keys.
 * - Without a map: derives a stable transcript solely from the fingerprint so
 *   identical scripted chunks always produce identical results.
 */
export const resolveMockTranscription = (
  chunk: AudioChunk,
  transcripts?: Record<string, MockTranscript>,
): SpeechTranslationResult[] => {
  const fingerprint = chunkFingerprint(chunk)
  let transcript: MockTranscript
  if (transcripts) {
    const mapped = transcripts[fingerprint]
    if (mapped === undefined) {
      throw new Error(
        `FakeSpeechSource: unexpected chunk fingerprint "${fingerprint}". ` +
        `Expected one of: ${Object.keys(transcripts).map((k) => `"${k}"`).join(', ')}`,
      )
    }
    transcript = mapped
  } else {
    const hash = fingerprint.split(':')[1]!
    transcript = {
      text: `utterance-${hash}`,
      translatedText: `translation-${hash}`,
    }
  }
  const isFinal = chunk.isFinal === true
  return [
    {
      id: chunk.chunkId,
      text: transcript.text,
      translatedText: isFinal ? (transcript.translatedText ?? transcript.text) : undefined,
      isFinal,
    },
  ]
}

/**
 * Deterministic `SpeechSource` fake consumed by the speech pipeline tests
 * (Spec §11). Implements exactly the SpeechSource surface the pipeline sees
 * (start/stop/onChunk/onError/onDisconnect); chunks and lifecycle events are
 * pushed synchronously by the test — no timers, no real audio.
 */
export class FakeSpeechSource implements SpeechSource {
  readonly start = vi.fn(async (): Promise<void> => undefined)
  readonly stop = vi.fn(async (): Promise<void> => undefined)
  private chunkCb: ((chunk: AudioChunk) => void) | undefined
  private errorCb: ((error: SpeechCaptureError) => void) | undefined
  private disconnectCb: ((reason: string) => void) | undefined

  onChunk(callback: (chunk: AudioChunk) => void): void {
    this.chunkCb = callback
  }

  onError(callback: (error: SpeechCaptureError) => void): void {
    this.errorCb = callback
  }

  onDisconnect(callback: (reason: string) => void): void {
    this.disconnectCb = callback
  }

  /** Push one PCM chunk synchronously (the on-demand emission path). */
  emitChunk(chunk: AudioChunk): void {
    this.chunkCb?.(chunk)
  }

  /** Push a pre-scripted deterministic sequence of chunks synchronously. */
  emitScripted(chunks: AudioChunk[]): void {
    for (const chunk of chunks) this.emitChunk(chunk)
  }

  /** Push a FINAL chunk to flush the pending utterance (Spec §6). */
  emitFinalChunk(overrides: Partial<AudioChunk> = {}): void {
    this.emitChunk(mkChunk({ ...overrides, isFinal: true }))
  }

  /** Simulate a capture-primitive error (e.g. permission_denied). */
  emitError(error: SpeechCaptureError): void {
    this.errorCb?.(error)
  }

  /** Simulate a port drop / SW suspension disconnect. */
  emitDisconnect(reason: string): void {
    this.disconnectCb?.(reason)
  }
}
