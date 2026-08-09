// Offscreen document ↔ Service Worker capture protocol (v0.3 speech, Spec §7).
//
// The offscreen document can access only `chrome.runtime` (offscreen
// restriction), so all capture control flows through runtime messages and one
// long-lived Port:
//
//   SW → offscreen:     runtime message { type: 'start_capture' | 'stop_capture' }
//   offscreen → SW:     chrome.runtime.connect({ name: 'speech-capture' }) Port
//                       { type: 'capture_started' | 'capture_error' | 'audio_chunk' }
//
// The offscreen never holds API keys; it only forwards bounded PCM chunks (§3).
// Raw audio is never persisted (§8.1).

import type { AudioChunk } from '@/providers/speech-types'

/** Relative (to the extension root) URL of the bundled offscreen document. */
export const OFFSCREEN_DOCUMENT_URL = 'src/offscreen/index.html'
/** Long-lived Port name used by the offscreen document to reach the SW. */
export const OFFSCREEN_PORT_NAME = 'speech-capture'
/** USER_MEDIA justification shown to the user when the offscreen doc is created. */
export const OFFSCREEN_JUSTIFICATION = 'capture twitch audio for speech subtitles'

/**
 * Capture-level failure reasons. The pipeline (#160) maps these onto the
 * Spec §9 error table (no_twitch_tab / permission_denied / context_invalidated
 * map 1:1; capture_failed and unknown are the catch-all buckets).
 */
export type SpeechCaptureErrorReason =
  | 'no_twitch_tab'
  | 'permission_denied'
  | 'capture_failed'
  | 'context_invalidated'
  | 'unknown'

export interface SpeechCaptureError {
  reason: SpeechCaptureErrorReason
  message?: string
}

/** SW → offscreen single-shot runtime messages. */
export type SwToOffscreenMessage =
  | { type: 'start_capture'; streamId: string }
  | { type: 'stop_capture' }

/** Offscreen → SW messages delivered over the long-lived speech-capture Port. */
export type OffscreenToSwPortMessage =
  | { type: 'capture_started' }
  | { type: 'capture_error'; reason: SpeechCaptureErrorReason; message?: string }
  | { type: 'audio_chunk'; chunk: AudioChunk }

const SPEECH_CAPTURE_ERROR_REASONS: readonly SpeechCaptureErrorReason[] = [
  'no_twitch_tab',
  'permission_denied',
  'capture_failed',
  'context_invalidated',
  'unknown',
]

export const isAudioChunk = (value: unknown): value is AudioChunk => {
  if (typeof value !== 'object' || value === null) return false
  const chunk = value as Record<string, unknown>
  return (
    typeof chunk.chunkId === 'string' &&
    chunk.data instanceof ArrayBuffer &&
    typeof chunk.mimeType === 'string' &&
    (chunk.startMs === undefined || typeof chunk.startMs === 'number') &&
    (chunk.endMs === undefined || typeof chunk.endMs === 'number') &&
    (chunk.isFinal === undefined || typeof chunk.isFinal === 'boolean')
  )
}

export const isSwToOffscreenMessage = (value: unknown): value is SwToOffscreenMessage => {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  if (message.type === 'start_capture' && typeof message.streamId === 'string') return true
  // stop_capture is a bare signal: reject any extra payload fields so a
  // malformed message never slips through.
  if (message.type === 'stop_capture') {
    return Object.keys(message).length === 1
  }
  return false
}

export const isOffscreenToSwPortMessage = (
  value: unknown,
): value is OffscreenToSwPortMessage => {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  switch (message.type) {
    case 'capture_started':
      return true
    case 'capture_error':
      return (
        typeof message.reason === 'string' &&
        SPEECH_CAPTURE_ERROR_REASONS.includes(message.reason as SpeechCaptureErrorReason) &&
        (message.message === undefined || typeof message.message === 'string')
      )
    case 'audio_chunk':
      return isAudioChunk(message.chunk)
    default:
      return false
  }
}

export const toErrorMessage = (error: unknown): string | undefined => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return undefined
}
