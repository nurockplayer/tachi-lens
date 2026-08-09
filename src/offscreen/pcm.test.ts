// Deterministic unit tests for the offscreen PCM downsampling + chunking DSP.
// No tabCapture / getUserMedia / AudioContext is touched (Spec §11).

import { describe, expect, it } from 'vitest'
import {
  PCM_MIME_TYPE,
  PcmChunkAccumulator,
  TARGET_SAMPLE_RATE,
  downsampleMonoTo16k,
  float32To16BitPcm,
} from './pcm'
import type { AudioChunk } from '@/providers/speech-types'

describe('downsampleMonoTo16k', () => {
  it('produces the expected number of 16 kHz samples from a 48 kHz frame', () => {
    const input = new Float32Array(48_000).fill(0.5)
    const out = downsampleMonoTo16k(input, 48_000)
    expect(out.length).toBe(16_000)
  })

  it('handles non-integer rate ratios (44.1 kHz)', () => {
    const input = new Float32Array(44_100)
    const out = downsampleMonoTo16k(input, 44_100)
    // floor(44100 / 2.75625) = 16000
    expect(out.length).toBe(16_000)
  })

  it('preserves a constant amplitude across the downsample', () => {
    const input = new Float32Array(4800).fill(0.25)
    const out = downsampleMonoTo16k(input, 48_000)
    for (const sample of out) {
      expect(sample).toBeCloseTo(0.25, 5)
    }
  })

  it('returns an empty frame when the input is shorter than one output sample', () => {
    expect(downsampleMonoTo16k(new Float32Array(1), 48_000).length).toBe(0)
    expect(downsampleMonoTo16k(new Float32Array(0), 48_000).length).toBe(0)
  })

  it('throws on a non-positive or non-finite source rate', () => {
    expect(() => downsampleMonoTo16k(new Float32Array(100), 0)).toThrow()
    expect(() => downsampleMonoTo16k(new Float32Array(100), Number.NaN)).toThrow()
  })
})

describe('float32To16BitPcm', () => {
  it('encodes little-endian signed 16-bit PCM with the correct byte length', () => {
    const out = float32To16BitPcm(new Float32Array([0, 0.5, -0.5, 1, -1]))
    const view = new DataView(out)
    expect(out.byteLength).toBe(5 * 2)
    expect(view.getInt16(0, true)).toBe(0)
    expect(view.getInt16(2, true)).toBe(0x4000) // Math.round(0.5 * 0x7fff)
    expect(view.getInt16(4, true)).toBe(-0x3fff) // Math.round(-16383.5) → -16383
    expect(view.getInt16(6, true)).toBe(0x7fff) // Math.round(0x7fff)
    expect(view.getInt16(8, true)).toBe(-0x7fff) // Math.round(-0x7fff)
  })

  it('clips out-of-range samples instead of wrapping', () => {
    const out = float32To16BitPcm(new Float32Array([2, -2]))
    const view = new DataView(out)
    expect(view.getInt16(0, true)).toBe(0x7fff)
    // -1.0 * 0x7fff = -32767 (Math.round), standard signed 16-bit minimum range.
    expect(view.getInt16(2, true)).toBe(-0x7fff)
  })
})

describe('PcmChunkAccumulator', () => {
  const collect = (options: Parameters<typeof makeAccumulator>[0] = {}) => makeAccumulator(options)
  function makeAccumulator(options: { chunkDurationMs?: number } = {}) {
    const chunks: AudioChunk[] = []
    const acc = new PcmChunkAccumulator((chunk) => chunks.push(chunk), {
      chunkDurationMs: options.chunkDurationMs,
      idFactory: () => 'chunk-id',
    })
    return { chunks, acc }
  }

  it('emits bounded chunks with the required AudioChunk shape', () => {
    const { chunks, acc } = collect()
    // A full 300 ms of 48 kHz mono → 16000 target samples → 3×4800 + 1600 leftover.
    acc.push(new Float32Array(48_000), 48_000)

    expect(chunks.length).toBe(3)
    for (const chunk of chunks) {
      expect(chunk.chunkId).toBe('chunk-id')
      expect(chunk.data).toBeInstanceOf(ArrayBuffer)
      expect(chunk.mimeType).toBe(PCM_MIME_TYPE)
      expect(chunk.data.byteLength).toBe(4800 * 2)
      expect(chunk.startMs).toBeTypeOf('number')
      expect(chunk.endMs).toBeTypeOf('number')
      expect(chunk.endMs! - chunk.startMs!).toBe(300)
      expect(chunk.isFinal).toBe(false)
    }
  })

  it('marks monotonic timestamps across emitted chunks', () => {
    const { chunks, acc } = collect()
    acc.push(new Float32Array(48_000), 48_000)
    expect(chunks.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 300],
      [300, 600],
      [600, 900],
    ])
  })

  it('flushes the trailing partial chunk as a final chunk', () => {
    const { chunks, acc } = collect()
    acc.push(new Float32Array(24_000), 48_000) // 8000 target samples → 1 chunk + 3200 leftover
    expect(chunks.length).toBe(1)
    acc.flush()
    expect(chunks.length).toBe(2)
    expect(chunks[1]!.isFinal).toBe(true)
    expect(chunks[1]!.data.byteLength).toBe(3200 * 2)
  })

  it('is a no-op when flushing an empty accumulator', () => {
    const { chunks, acc } = collect()
    acc.flush()
    expect(chunks).toHaveLength(0)
  })

  it('treats a negative/full-amplitude frame without corrupting chunk size', () => {
    const { chunks, acc } = collect()
    // Each 4800-sample native frame at 48 kHz → 1600 target samples (100 ms);
    // a 300 ms chunk needs three of them.
    acc.push(new Float32Array(4800).fill(-0.9), 48_000)
    acc.push(new Float32Array(4800).fill(0.9), 48_000)
    expect(chunks).toHaveLength(0)
    acc.push(new Float32Array(4800).fill(-0.9), 48_000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.data.byteLength).toBe(4800 * 2)
  })

  it('rejects invalid chunk durations', () => {
    expect(() => new PcmChunkAccumulator(() => undefined, { chunkDurationMs: 0 })).toThrow()
  })

  it('defaults to a 300 ms target cadence and 16 kHz MIME type', () => {
    expect(PCM_MIME_TYPE).toBe('audio/pcm;rate=16000')
    expect(TARGET_SAMPLE_RATE).toBe(16_000)
  })
})
