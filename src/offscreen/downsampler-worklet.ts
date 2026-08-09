// AudioWorklet processor for the offscreen capture document (v0.3 speech).
//
// This file runs in the AudioWorkletGlobalScope (a worker-like context, not the
// offscreen document's main thread). It must not import the `@/` alias modules
// — the worklet is loaded via `audioWorklet.addModule()` as a raw URL and Vite
// bundles each worklet chunk independently without applying the renderer alias.
// It therefore contains only a mono-mix + transport (the DSP lives in ./pcm on
// the main thread, where it is deterministically unit-testable).
//
// The processor mono-mixes native-rate input and posts the mono Float32 buffer
// to the main thread; capture.ts feeds those frames to PcmChunkAccumulator
// (downsample to 16 kHz + bounded chunking) using the AudioContext.sampleRate.

/** The processor class name the offscreen document registers/constructs. */
export const WORKLET_PROCESSOR_NAME = 'tachi-lens-pcm-forward'

declare const registerProcessor: (
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
) => void

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean
}

/** Mono-mix all input channels into a single Float32Array. */
const toMono = (inputChannels: Float32Array[]): Float32Array => {
  if (inputChannels.length === 0) return new Float32Array(0)
  const first = inputChannels[0]!
  if (inputChannels.length === 1) return first
  const mono = new Float32Array(first.length)
  for (const channel of inputChannels) {
    const count = Math.min(channel.length, mono.length)
    for (let i = 0; i < count; i++) mono[i]! += channel[i]!
  }
  for (let i = 0; i < mono.length; i++) mono[i] = mono[i]! / inputChannels.length
  return mono
}

class PcmForwardProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0]
    if (!channels || channels.length === 0) return true
    const mono = toMono(channels)
    if (mono.length === 0) return true

    // No transfer list: the main thread (capture.ts) reads `mono` after
    // postMessage, so the buffer must stay attached. Copying ~128 floats per
    // audio quantum is negligible for this workload.
    this.port.postMessage({ type: 'pcm', mono })
    return true
  }
}

// Guarded registration: this module runs in the AudioWorkletGlobalScope where
// `registerProcessor` is defined. The guard is defensive — if the module were
// ever evaluated in a context without the worklet globals (e.g. imported into
// the main-thread bundle), the class/registration would not throw.
if (typeof registerProcessor === 'function') {
  registerProcessor(WORKLET_PROCESSOR_NAME, PcmForwardProcessor)
}
