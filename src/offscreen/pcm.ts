// PCM downsample + chunking for the offscreen capture document (v0.3 speech).
//
// Spec §2: capture produces 16 kHz mono 16-bit little-endian PCM in bounded
// chunks (~200–500 ms). 500 ms of 16 kHz mono is ~16 KB, well under the MV3
// message-size limit. Chunks are forwarded to the SW and dropped immediately
// (§8.1 — raw audio is never persisted).
//
// All DSP lives here (main thread) so it is deterministically unit-testable;
// the AudioWorklet / ScriptProcessor adapters in capture.ts only forward
// native-rate mono Float32 input frames into `PcmChunkAccumulator`.

import type { AudioChunk } from '@/providers/speech-types'

/** Target sample rate for the speech pipeline (Hz). Frozen by Spec §2. */
export const TARGET_SAMPLE_RATE = 16_000
/** PCM MIME type used on every AudioChunk (Spec §5). */
export const PCM_MIME_TYPE = 'audio/pcm;rate=16000'

/**
 * Downsample a mono Float32Array from `sourceSampleRate` to TARGET_SAMPLE_RATE
 * using windowed linear interpolation. Deterministic and allocation-free per
 * call. Throws on a non-positive/non-finite source rate so a misconfigured
 * AudioContext never silently produces garbage chunks.
 */
export const downsampleMonoTo16k = (
  input: Float32Array,
  sourceSampleRate: number,
): Float32Array => {
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
    throw new Error('downsampleMonoTo16k: invalid source sample rate')
  }

  const ratio = sourceSampleRate / TARGET_SAMPLE_RATE
  const outputLength = Math.floor(input.length / ratio)
  if (outputLength <= 0) return new Float32Array(0)

  const output = new Float32Array(outputLength)
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio
    const lower = Math.floor(sourceIndex)
    const upper = Math.min(lower + 1, input.length - 1)
    const fraction = sourceIndex - lower
    output[i] = input[lower]! * (1 - fraction) + input[upper]! * fraction
  }
  return output
}

/** Convert a mono Float32Array (-1..1) to signed 16-bit little-endian PCM. */
export const float32To16BitPcm = (input: Float32Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(input.length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]!))
    view.setInt16(i * 2, Math.round(sample * 0x7fff), true)
  }
  return buffer
}

export interface PcmChunkAccumulatorOptions {
  /** Bounded target chunk duration in ms (Spec §2: ~200–500). Default 300. */
  chunkDurationMs?: number
  /** Upper bound for `chunkDurationMs` validation. Default 500. */
  maxChunkDurationMs?: number
  /** Factory for chunk ids. Defaults to crypto.randomUUID(). */
  idFactory?: () => string
}

/**
 * Buffers downsampled mono samples and emits bounded `AudioChunk`s. A chunk is
 * emitted as soon as `chunkSamples` accumulate; oversized input frames are
 * split across chunks so every non-final chunk is exactly `chunkSamples` long.
 * `flush()` converts the trailing partial chunk to PCM and marks it final
 * (Spec §7 stop path / §9 error path).
 */
export class PcmChunkAccumulator {
  private readonly chunkSamples: number
  private readonly buffer: Float32Array
  private writeIndex = 0
  /** Total target-rate samples emitted so far (drives startMs/endMs). */
  private emittedSamples = 0
  private readonly idFactory: () => string

  constructor(
    private readonly onChunk: (chunk: AudioChunk) => void,
    options: PcmChunkAccumulatorOptions = {},
  ) {
    const chunkDurationMs = options.chunkDurationMs ?? 300
    const maxChunkDurationMs = options.maxChunkDurationMs ?? 500
    if (chunkDurationMs <= 0 || chunkDurationMs > maxChunkDurationMs) {
      throw new Error('PcmChunkAccumulator: invalid chunk durations')
    }
    this.chunkSamples = Math.round((TARGET_SAMPLE_RATE * chunkDurationMs) / 1000)
    this.buffer = new Float32Array(this.chunkSamples)
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID())
  }

  /** Push a native-rate mono frame into the accumulator. */
  push(frame: Float32Array, sourceSampleRate: number): void {
    const mono = downsampleMonoTo16k(frame, sourceSampleRate)
    if (mono.length === 0) return

    let offset = 0
    while (offset < mono.length) {
      const needed = this.chunkSamples - this.writeIndex
      const take = Math.min(needed, mono.length - offset)
      this.buffer.set(mono.subarray(offset, offset + take), this.writeIndex)
      this.writeIndex += take
      offset += take
      if (this.writeIndex === this.chunkSamples) {
        this.emitChunk(false)
      }
    }
  }

  /** Flush the trailing partial chunk as a final chunk (or no-op if empty). */
  flush(): void {
    if (this.writeIndex === 0) return
    this.emitChunk(true)
  }

  /** Number of buffered (target-rate) samples awaiting a chunk. */
  get pendingSamples(): number {
    return this.writeIndex
  }

  private emitChunk(isFinal: boolean): void {
    const data = float32To16BitPcm(this.buffer.subarray(0, this.writeIndex))
    const startMs = Math.round((this.emittedSamples / TARGET_SAMPLE_RATE) * 1000)
    this.emittedSamples += this.writeIndex
    const endMs = Math.round((this.emittedSamples / TARGET_SAMPLE_RATE) * 1000)
    this.writeIndex = 0
    this.onChunk({
      chunkId: this.idFactory(),
      data,
      mimeType: PCM_MIME_TYPE,
      startMs,
      endMs,
      isFinal,
    })
  }
}
