// Unit tests for the offscreen ⇄ SW capture protocol types/guards.

import { describe, expect, it } from 'vitest'
import {
  OFFSCREEN_DOCUMENT_URL,
  OFFSCREEN_JUSTIFICATION,
  OFFSCREEN_PORT_NAME,
  isAudioChunk,
  isOffscreenToSwPortMessage,
  isSwToOffscreenMessage,
} from './protocol'

describe('protocol constants', () => {
  it('freezes the offscreen URL, port name, and justification', () => {
    expect(OFFSCREEN_DOCUMENT_URL).toBe('src/offscreen/index.html')
    expect(OFFSCREEN_PORT_NAME).toBe('speech-capture')
    expect(OFFSCREEN_JUSTIFICATION).toContain('capture twitch audio')
  })
})

describe('isAudioChunk', () => {
  const valid = {
    chunkId: 'c1',
    data: new ArrayBuffer(2),
    mimeType: 'audio/pcm;rate=16000',
    startMs: 0,
    endMs: 300,
    isFinal: false,
  }

  it('accepts a well-formed AudioChunk', () => {
    expect(isAudioChunk(valid)).toBe(true)
  })

  it('accepts an AudioChunk with optional fields omitted', () => {
    const { startMs: _s, endMs: _e, isFinal: _f, ...minimal } = valid
    expect(isAudioChunk(minimal)).toBe(true)
  })

  it('rejects non-objects and missing required fields', () => {
    expect(isAudioChunk(null)).toBe(false)
    expect(isAudioChunk('x')).toBe(false)
    const { chunkId: _c, ...noId } = valid
    expect(isAudioChunk(noId)).toBe(false)
    expect(isAudioChunk({ ...valid, data: new Uint8Array(2) })).toBe(false)
  })

  it('rejects malformed optional fields', () => {
    expect(isAudioChunk({ ...valid, isFinal: 'yes' })).toBe(false)
    expect(isAudioChunk({ ...valid, startMs: '0' })).toBe(false)
  })
})

describe('isSwToOffscreenMessage', () => {
  it('accepts start_capture and stop_capture', () => {
    expect(isSwToOffscreenMessage({ type: 'start_capture', streamId: 's1' })).toBe(true)
    expect(isSwToOffscreenMessage({ type: 'stop_capture' })).toBe(true)
  })

  it('rejects start_capture without a streamId or unknown types', () => {
    expect(isSwToOffscreenMessage({ type: 'start_capture' })).toBe(false)
    expect(isSwToOffscreenMessage({ type: 'stop_capture', streamId: 's1' })).toBe(false)
    expect(isSwToOffscreenMessage({ type: 'nonsense' })).toBe(false)
  })
})

describe('isOffscreenToSwPortMessage', () => {
  it('accepts capture_started and capture_error', () => {
    expect(isOffscreenToSwPortMessage({ type: 'capture_started' })).toBe(true)
    expect(isOffscreenToSwPortMessage({ type: 'capture_error', reason: 'permission_denied' })).toBe(true)
  })

  it('rejects unknown error reasons or unknown types', () => {
    expect(isOffscreenToSwPortMessage({ type: 'capture_error', reason: 'nope' })).toBe(false)
    expect(isOffscreenToSwPortMessage({ type: 'other' })).toBe(false)
  })

  it('accepts a valid audio_chunk payload', () => {
    expect(isOffscreenToSwPortMessage({
      type: 'audio_chunk',
      chunk: { chunkId: 'c1', data: new ArrayBuffer(2), mimeType: 'audio/pcm;rate=16000' },
    })).toBe(true)
  })

  it('rejects audio_chunk with a malformed chunk', () => {
    expect(isOffscreenToSwPortMessage({
      type: 'audio_chunk',
      chunk: { chunkId: 42 },
    })).toBe(false)
  })
})
