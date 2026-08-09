// Unit tests for the offscreen capture orchestration. Uses FAKE MediaStream /
// AudioContext / getUserMedia / Port / AudioWorkletNode — no real tabCapture or
// media APIs (Spec §11 determinism rule).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OffscreenSpeechCapture } from './capture'
import type { CaptureEnvironment, SpeechCapturePort } from './capture'
import type { AudioChunk } from '@/providers/speech-types'
import type { OffscreenToSwPortMessage, SpeechCaptureError } from './protocol'

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>
}

interface FakeMediaStream {
  getTracks: () => FakeTrack[]
}

interface FakeSourceNode {
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

interface FakeWorkletNode {
  port: { onmessage: ((event: MessageEvent) => void) | null }
  disconnect: ReturnType<typeof vi.fn>
}

interface FakeScriptProcessorNode {
  onaudioprocess: ((event: unknown) => void) | null
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

interface FakeAudioContext {
  sampleRate: number
  destination: Record<string, never>
  createMediaStreamSource: ReturnType<typeof vi.fn>
  audioWorklet: { addModule: ReturnType<typeof vi.fn> }
  createScriptProcessor: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

interface EnvStubs {
  getUserMedia: ReturnType<typeof vi.fn>
  createAudioContext: ReturnType<typeof vi.fn>
  connectPort: ReturnType<typeof vi.fn>
  workletUrl: string
}

interface PortStub {
  port: SpeechCapturePort
  sent: OffscreenToSwPortMessage[]
  disconnect: ReturnType<typeof vi.fn>
  disconnectHandlers: Array<() => void>
}

const createFakeTrack = (): FakeTrack => ({ stop: vi.fn() })

const createFakeStream = (): { stream: FakeMediaStream; tracks: FakeTrack[] } => {
  const tracks = [createFakeTrack(), createFakeTrack()]
  return { stream: { getTracks: () => tracks }, tracks }
}

const createPortStub = (): PortStub => {
  const sent: OffscreenToSwPortMessage[] = []
  const disconnect = vi.fn()
  const disconnectHandlers: Array<() => void> = []
  const port: SpeechCapturePort = {
    postMessage: (message) => sent.push(message),
    disconnect,
    onDisconnect: {
      addListener: (cb) => disconnectHandlers.push(cb),
      removeListener: () => undefined,
    },
  }
  return { port, sent, disconnect, disconnectHandlers }
}

/** Global AudioWorkletNode stub so capture.ts can construct the worklet node. */
let workletNode: FakeWorkletNode

interface Harness {
  capture: OffscreenSpeechCapture
  errors: SpeechCaptureError[]
  sourceNode: FakeSourceNode
  scriptProcessor: FakeScriptProcessorNode
  stream: FakeMediaStream
  tracks: FakeTrack[]
  portStub: PortStub
  context: FakeAudioContext
  env: EnvStubs
}

const setup = async (options: {
  workletFails?: boolean
  context?: Partial<FakeAudioContext>
  port?: PortStub
  env?: Partial<EnvStubs>
} = {}): Promise<Harness> => {
  const { stream, tracks } = createFakeStream()
  const portStub = options.port ?? createPortStub()

  const sourceNode: FakeSourceNode = { connect: vi.fn(), disconnect: vi.fn() }
  const scriptProcessor: FakeScriptProcessorNode = {
    onaudioprocess: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }

  const context: FakeAudioContext = {
    sampleRate: 48_000,
    destination: {},
    createMediaStreamSource: vi.fn(() => sourceNode),
    audioWorklet: {
      addModule: options.workletFails
        ? vi.fn(async () => { throw new Error('worklet unavailable') })
        : vi.fn(async () => undefined),
    },
    createScriptProcessor: vi.fn(() => scriptProcessor),
    close: vi.fn(async () => undefined),
    ...options.context,
  }

  const env: EnvStubs = {
    getUserMedia: vi.fn(async () => stream),
    createAudioContext: vi.fn(() => context),
    connectPort: vi.fn(() => portStub.port),
    workletUrl: 'data:application/javascript,worklet',
    ...options.env,
  }

  const errors: SpeechCaptureError[] = []
  const capture = new OffscreenSpeechCapture(
    env as unknown as CaptureEnvironment,
    { onError: (e) => errors.push(e) },
  )
  await capture.start('stream-123')

  return { capture, errors, sourceNode, scriptProcessor, stream, tracks, portStub, context, env }
}

/** Inject the mono Float32 frame as a worklet node message. */
const pushWorkletFrame = (_harness: Harness, length = 4800, value = 0): void => {
  const mono = new Float32Array(length).fill(value)
  workletNode.port.onmessage?.({ data: { type: 'pcm', mono } } as unknown as MessageEvent)
}

const chunkList = (harness: Harness): AudioChunk[] =>
  harness.portStub.sent
    .filter((m): m is { type: 'audio_chunk'; chunk: AudioChunk } => m.type === 'audio_chunk')
    .map((m) => m.chunk)

beforeEach(() => {
  workletNode = { port: { onmessage: null }, disconnect: vi.fn() }
  vi.stubGlobal('AudioWorkletNode', class FakeAudioWorkletNode {
    port = workletNode.port
    disconnect = workletNode.disconnect
  })
})

describe('OffscreenSpeechCapture', () => {
  it('opens the Port, captures via getUserMedia, and posts capture_started', async () => {
    const h = await setup()
    expect(h.env.getUserMedia).toHaveBeenCalledWith({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'stream-123' } },
    })
    expect(h.env.connectPort).toHaveBeenCalled()
    expect(h.portStub.sent).toContainEqual({ type: 'capture_started' })
  })

  it('connects the captured stream to the destination (Twitch stays audible)', async () => {
    const h = await setup()
    expect(h.context.createMediaStreamSource).toHaveBeenCalledWith(h.stream)
    expect(h.sourceNode.connect).toHaveBeenCalledWith(h.context.destination)
  })

  it('routes worklet frames into bounded AudioChunks over the Port', async () => {
    const h = await setup()
    pushWorkletFrame(h) // 100 ms — not a full 300 ms chunk
    expect(chunkList(h)).toHaveLength(0)
    pushWorkletFrame(h)
    pushWorkletFrame(h)
    const chunks = chunkList(h)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.mimeType).toBe('audio/pcm;rate=16000')
    expect(chunks[0]!.data.byteLength).toBe(4800 * 2)
    expect(chunks[0]!.startMs).toBe(0)
    expect(chunks[0]!.endMs).toBe(300)
    expect(chunks[0]!.isFinal).toBe(false)
  })

  it('reports getUserMedia failures as permission_denied', async () => {
    const portStub = createPortStub()
    const errors: SpeechCaptureError[] = []
    const capture = new OffscreenSpeechCapture({
      getUserMedia: vi.fn(async () => { throw new Error('Permission denied') }),
      createAudioContext: vi.fn(),
      connectPort: vi.fn(() => portStub.port),
      workletUrl: 'x',
    }, { onError: (e) => errors.push(e) })

    await expect(capture.start('sid')).rejects.toThrow('Permission denied')
    expect(errors[0]?.reason).toBe('permission_denied')
    expect(capture.isCapturing).toBe(false)
  })

  it('reports graph setup failures as capture_failed and stops capture', async () => {
    // Make BOTH the worklet and the ScriptProcessor fallback fail.
    const { stream } = createFakeStream()
    const portStub = createPortStub()
    const errors: SpeechCaptureError[] = []
    const sourceNode = { connect: vi.fn(), disconnect: vi.fn() }
    const context: FakeAudioContext = {
      sampleRate: 48_000,
      destination: {},
      createMediaStreamSource: vi.fn(() => sourceNode),
      audioWorklet: { addModule: vi.fn(async () => { throw new Error('no worklet') }) },
      createScriptProcessor: vi.fn(() => { throw new Error('no script processor') }),
      close: vi.fn(async () => undefined),
    }
    const capture = new OffscreenSpeechCapture({
      getUserMedia: vi.fn(async () => stream) as unknown as CaptureEnvironment['getUserMedia'],
      createAudioContext: vi.fn(() => context) as unknown as CaptureEnvironment['createAudioContext'],
      connectPort: vi.fn(() => portStub.port),
      workletUrl: 'x',
    }, { onError: (e) => errors.push(e) })

    await expect(capture.start('sid')).rejects.toThrow('no script processor')
    expect(errors[0]?.reason).toBe('capture_failed')
    expect(capture.isCapturing).toBe(false)
  })

  it('falls back to ScriptProcessor when AudioWorklet is unavailable', async () => {
    const h = await setup({ workletFails: true })
    expect(h.context.createScriptProcessor).toHaveBeenCalled()
    expect(h.scriptProcessor.connect).toHaveBeenCalledWith(h.context.destination)
    expect(h.portStub.sent).toContainEqual({ type: 'capture_started' })
  })

  it('ScriptProcessor frames also produce bounded chunks', async () => {
    const h = await setup({ workletFails: true })
    // A 4096-sample native frame at 48 kHz → 1365 target samples (~85 ms).
    for (let i = 0; i < 4; i++) {
      h.scriptProcessor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(4096) },
      })
    }
    expect(chunkList(h)).toHaveLength(1)
    expect(chunkList(h)[0]!.data.byteLength).toBe(4800 * 2)
  })

  it('stops all tracks and closes the AudioContext on stop()', async () => {
    const h = await setup()
    expect(h.tracks.every((t) => t.stop.mock.calls.length === 0)).toBe(true)
    h.capture.stop()
    for (const track of h.tracks) expect(track.stop).toHaveBeenCalled()
    expect(h.context.close).toHaveBeenCalled()
    expect(h.portStub.disconnect).toHaveBeenCalled()
    expect(h.capture.isCapturing).toBe(false)
  })

  it('stop() is idempotent', async () => {
    const h = await setup()
    h.capture.stop()
    const stopCalls = h.tracks[0]!.stop.mock.calls.length
    h.capture.stop()
    expect(h.tracks[0]!.stop.mock.calls.length).toBe(stopCalls)
  })

  it('stops everything when the Port disconnects (SW suspension)', async () => {
    const h = await setup()
    expect(h.portStub.disconnectHandlers).toHaveLength(1)
    h.portStub.disconnectHandlers[0]!()
    for (const track of h.tracks) expect(track.stop).toHaveBeenCalled()
    expect(h.context.close).toHaveBeenCalled()
    expect(h.capture.isCapturing).toBe(false)
  })

  it('ignores non-pcm / malformed worklet messages', async () => {
    const h = await setup()
    workletNode.port.onmessage?.({ data: { type: 'other' } } as unknown as MessageEvent)
    workletNode.port.onmessage?.({ data: { type: 'pcm' } } as unknown as MessageEvent)
    expect(chunkList(h)).toHaveLength(0)
  })

  it('does not double-capture when start() is called while capturing', async () => {
    const h = await setup()
    await h.capture.start('second-stream')
    expect(h.env.getUserMedia).toHaveBeenCalledTimes(1)
    expect(h.capture.isCapturing).toBe(true)
  })
})
