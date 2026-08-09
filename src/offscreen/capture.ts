// Offscreen capture document orchestration (v0.3 speech, Spec §2/§3/§7).
//
// This is the only place the `tabCapture` MediaStream is consumed. It:
//   1. Reads a `start_capture` runtime message carrying a `streamId` (single-use).
//   2. Opens the long-lived `speech-capture` Port FIRST so that every failure
//      during media setup can be reported to the SW over that Port.
//   3. getUserMedia with the Chrome `tab` media source for the stream id.
//   4. Connects the stream to the AudioContext destination so the viewer keeps
//      hearing Twitch (Spec §2 hard requirement — tabCapture mutes the tab).
//   5. Routes the stream into an AudioWorklet (ScriptProcessor fallback) whose
//      mono frames are downsampled to 16 kHz mono and emitted as bounded PCM
//      chunks through the Port.
//   6. On `stop_capture` or Port `onDisconnect` (SW suspension, §7), stops all
//      tracks, closes the AudioContext, and clears buffers (§8.1).
//
// The offscreen document can access only `chrome.runtime`, so it never reads
// storage and never holds API keys (§3). Raw audio is never persisted (§8.1).

import workletUrl from './downsampler-worklet.ts?worker&url'
import { PcmChunkAccumulator } from './pcm'
import type { OffscreenToSwPortMessage, SpeechCaptureError } from './protocol'
import { OFFSCREEN_PORT_NAME, toErrorMessage } from './protocol'

/**
 * AudioWorklet processor name. Kept as a literal (rather than imported from the
 * worklet module) so the main-thread bundle never executes the worklet's
 * worker-scope code (`AudioWorkletProcessor` is not defined on the main thread).
 * Must stay identical to WORKLET_PROCESSOR_NAME in downsampler-worklet.ts.
 */
const WORKLET_PROCESSOR_NAME = 'tachi-lens-pcm-forward'

/** Chrome-specific `tab` media source constraint used by tabCapture getUserMedia. */
interface ChromeTabCaptureAudioConstraint {
  audio: {
    mandatory: {
      chromeMediaSource: 'tab'
      chromeMediaSourceId: string
    }
  }
}

/**
 * The narrow `chrome.runtime.Port` surface the capture session needs, so tests
 * can substitute a fake port. `chrome.runtime.Port` structurally satisfies it.
 */
export interface SpeechCapturePort {
  postMessage(message: OffscreenToSwPortMessage): void
  disconnect(): void
  onDisconnect: {
    addListener(callback: () => void): void
    removeListener(callback: () => void): void
  }
}

/** Browser media + runtime surfaces injected into the session (test seam). */
export interface CaptureEnvironment {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  createAudioContext(): AudioContext
  connectPort(): SpeechCapturePort
  /** URL of the bundled AudioWorklet module (Vite worker&url import). */
  workletUrl: string
}

export interface SpeechCaptureCallbacks {
  onError(error: SpeechCaptureError): void
}

/** ScriptProcessor fallback buffer size (power of two, 2..16384). */
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096

/**
 * One offscreen capture session. `start()` is called from the `start_capture`
 * runtime message; `stop()` is called from `stop_capture` or Port disconnect.
 * `stop()` is idempotent and always tears down all media + graph state.
 */
export class OffscreenSpeechCapture {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private scriptProcessor: ScriptProcessorNode | null = null
  private accumulator: PcmChunkAccumulator | null = null
  private port: SpeechCapturePort | null = null
  private portDisconnectHandler: (() => void) | null = null
  private capturing = false

  constructor(
    private readonly env: CaptureEnvironment,
    private readonly callbacks: SpeechCaptureCallbacks,
  ) {}

  get isCapturing(): boolean {
    return this.capturing
  }

  /** The open Port, when present (used by the document entry to report errors). */
  getPort(): SpeechCapturePort | null {
    return this.port
  }

  /**
   * Start capturing the tab identified by `streamId`. The Port is opened before
   * any media setup so failures are reportable to the SW. Resolves once the
   * media graph is live and `capture_started` is posted; rejects on media/graph
   * setup failure (the error is also posted over the Port).
   */
  async start(streamId: string): Promise<void> {
    if (this.capturing) return
    this.stop()

    let port: SpeechCapturePort
    try {
      port = this.env.connectPort()
    } catch (error) {
      this.reportError({ reason: 'unknown', message: toErrorMessage(error) })
      throw error
    }
    this.port = port
    this.portDisconnectHandler = (): void => this.stop()
    port.onDisconnect.addListener(this.portDisconnectHandler)

    let stream: MediaStream
    try {
      const constraints = {
        audio: {
          mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
        },
      } as ChromeTabCaptureAudioConstraint as unknown as MediaStreamConstraints
      stream = await this.env.getUserMedia(constraints)
    } catch (error) {
      // §9: tabCapture/getUserMedia failure is `permission_denied`.
      this.reportError({ reason: 'permission_denied', message: toErrorMessage(error) })
      this.stop()
      throw error
    }

    try {
      const context = this.env.createAudioContext()
      this.context = context
      this.stream = stream

      const source = context.createMediaStreamSource(stream)
      this.sourceNode = source

      // Keep the tab audible to the viewer (Spec §2 hard requirement).
      source.connect(context.destination)

      this.accumulator = new PcmChunkAccumulator((chunk) => {
        this.port?.postMessage({ type: 'audio_chunk', chunk })
      })

      await this.connectProcessingNode(source, context)
    } catch (error) {
      this.reportError({ reason: 'capture_failed', message: toErrorMessage(error) })
      this.stop()
      throw error
    }

    this.capturing = true
    port.postMessage({ type: 'capture_started' })
  }

  /**
   * Tear down capture. Idempotent; safe to call from `stop_capture`, Port
   * disconnect, tab navigation/close, or context invalidation. Stops all
   * tracks, closes the AudioContext, disconnects the Port, clears the buffer.
   */
  stop(): void {
    if (!this.capturing && !this.context && !this.stream && !this.port) return

    this.capturing = false

    if (this.portDisconnectHandler && this.port?.onDisconnect) {
      this.port.onDisconnect.removeListener(this.portDisconnectHandler)
    }
    this.portDisconnectHandler = null
    this.port?.disconnect()
    this.port = null

    if (this.workletNode) {
      try { this.workletNode.disconnect() } catch { /* already torn down */ }
      this.workletNode = null
    }
    if (this.scriptProcessor) {
      try { this.scriptProcessor.disconnect() } catch { /* already torn down */ }
      this.scriptProcessor = null
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect() } catch { /* already torn down */ }
      this.sourceNode = null
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop()
      this.stream = null
    }
    if (this.context) {
      void this.context.close().catch(() => undefined)
      this.context = null
    }

    this.accumulator = null
  }

  private connectProcessingNode(
    source: MediaStreamAudioSourceNode,
    context: AudioContext,
  ): Promise<void> {
    return this.tryAttachWorklet(source, context).then((attached) => {
      if (attached) return
      this.attachScriptProcessor(source, context)
    })
  }

  private async tryAttachWorklet(
    source: MediaStreamAudioSourceNode,
    context: AudioContext,
  ): Promise<boolean> {
    try {
      await context.audioWorklet.addModule(this.env.workletUrl)
      const node = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME)
      node.port.onmessage = (event: MessageEvent): void => {
        const payload = event.data as { type?: string; mono?: Float32Array } | undefined
        if (payload?.type === 'pcm' && payload.mono && this.accumulator) {
          this.accumulator.push(payload.mono, context.sampleRate)
        }
      }
      source.connect(node)
      this.workletNode = node
      return true
    } catch (error) {
      console.warn('[tachi-lens] AudioWorklet unavailable, falling back to ScriptProcessor', error)
      return false
    }
  }

  private attachScriptProcessor(
    source: MediaStreamAudioSourceNode,
    context: AudioContext,
  ): void {
    const processor = context.createScriptProcessor(
      SCRIPT_PROCESSOR_BUFFER_SIZE,
      1,
      1,
    )
    processor.onaudioprocess = (event: AudioProcessingEvent): void => {
      const mono = event.inputBuffer.getChannelData(0)
      if (mono.length > 0 && this.accumulator) {
        this.accumulator.push(mono, context.sampleRate)
      }
    }
    // The ScriptProcessor must sit in the audio graph to fire; routing the
    // captured tab audio through it keeps Twitch audible (Spec §2).
    source.connect(processor)
    processor.connect(context.destination)
    this.scriptProcessor = processor
  }

  private reportError(error: SpeechCaptureError): void {
    this.callbacks.onError(error)
  }
}

// --- Document entry point ---------------------------------------------------

export interface CaptureDocumentOptions {
  env: CaptureEnvironment
}

/**
 * Wire the offscreen document to `chrome.runtime`. Guarded so importing this
 * module in unit tests (no `chrome.runtime`) is a no-op.
 */
export const installOffscreenCapture = (
  options: CaptureDocumentOptions,
): OffscreenSpeechCapture => {
  const capture = new OffscreenSpeechCapture(options.env, {
    onError: (error) => {
      // Errors are surfaced over the Port so the SW can map them to the §9
      // error table. The Port is opened before media setup, so this is always
      // available; if the extension context was invalidated the post is a no-op.
      capture.getPort()?.postMessage({ type: 'capture_error', ...error })
    },
  })

  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return capture

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as { type?: unknown; streamId?: unknown }
    if (msg.type === 'start_capture' && typeof msg.streamId === 'string') {
      void capture.start(msg.streamId).catch(() => undefined)
    } else if (msg.type === 'stop_capture') {
      capture.stop()
    }
  })

  return capture
}

/**
 * Default environment used by the real offscreen document. `workletUrl` is the
 * Vite-emitted URL of the AudioWorklet module (see vite-env.d.ts).
 */
export const createDefaultCaptureEnvironment = (): CaptureEnvironment => ({
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createAudioContext: () => new AudioContext(),
  connectPort: () => chrome.runtime.connect({ name: OFFSCREEN_PORT_NAME }),
  workletUrl,
})

// Auto-boot in the real offscreen document. Guarded so unit tests can import
// the module (constructing `OffscreenSpeechCapture` directly) without a live
// chrome.runtime. The environment factory only builds lazy closures, so nothing
// touches navigator/chrome until `start()` runs.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  installOffscreenCapture({ env: createDefaultCaptureEnvironment() })
}
