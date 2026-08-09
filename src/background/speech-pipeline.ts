// Service Worker speech pipeline (v0.3 speech, Spec §2/§6/§9/§10).
//
// Owns everything between the capture primitive and the provider:
//   - VAD/silence gating (silent chunks are never sent and never billed).
//   - Chunk→caption assembly: interim captions are shown untranslated (from
//     SpeechTranslationResult.text), final captions are translated
//     (translatedText). Only the final caption of an utterance is translated,
//     bounding cost to one request per utterance (Spec §10).
//   - Dedup: dirty-check (skip re-emit if the display text is unchanged) and
//     suppress a final that duplicates the previous line.
//   - Bounded window buffer with drop-oldest (Spec §9: keep ≤10 s while
//     rate-limited; never let memory grow unbounded).
//   - Budget charging (only billed, non-silent windows are charged).
//   - Provider error handling per Spec §9 (auth fatal; rate_limited/quota
//     pause with cooldown; network drops a failed window and stops after a
//     threshold of consecutive failures).
//
// The pipeline is a pure consumer of `SpeechSource` — it never imports
// offscreen/tabCapture — and exposes the state machine it drives through
// `onState`. The Service Worker only wires callbacks and owns broadcast.

import { RateLimiter } from './rate-limiter'
import { SpeechBudget, SpeechBudgetExceededError } from './speech-budget'
import type { SpeechSource } from './speech-capture'
import type { SpeechCaptureError } from '@/offscreen/protocol'
import { SPEECH_ERROR_KEYS, INITIAL_SPEECH_STATE, speechReducer } from '@/shared/speech-state'
import type { SpeechAction, SpeechErrorReason, SpeechState } from '@/shared/speech-state'
import type {
  SpeechCaptionClearedPayload,
  SpeechCaptionPayload,
  SpeechStatePayload,
} from '@/shared/messages'
import type { DiagnosticStage } from '@/shared/messages'
import type { AudioChunk, SpeechProvider, SpeechProviderId, SpeechTranslationResult } from '@/providers/speech-types'
import type { UserSettings } from '@/storage/settings'
import type { ProviderError } from '@/shared/messages'

/** RateLimiter key for speech quota/backoff (Spec §5, §9). */
export const SPEECH_RATE_LIMIT_KEY = 'gemini-speech'

/** Transcription window target (Spec §10: requests per ~5–10 s window). */
export const SPEECH_WINDOW_MS = 5_000
/** Bound on buffered audio before drop-oldest (Spec §9: ≤10 s while paused). */
export const SPEECH_MAX_BUFFER_MS = 10_000
/** Default VAD energy threshold over 16-bit PCM samples. */
export const SPEECH_SILENCE_RMS_THRESHOLD = 400
/** Stop capture after this many consecutive provider failures (Spec §9 network). */
export const SPEECH_MAX_CONSECUTIVE_FAILURES = 5

export interface SpeechPipelineDependencies {
  source: SpeechSource
  getProvider: (id: SpeechProviderId) => SpeechProvider | undefined
  getApiKey: (id: SpeechProviderId) => Promise<string | undefined>
  getSettings: () => Promise<UserSettings>
  budget: SpeechBudget
  rateLimiter: RateLimiter
  /** Emit a speech_state broadcast payload (the SW forwards it to content scripts). */
  onState: (payload: SpeechStatePayload) => void
  /** Emit a caption broadcast payload. */
  onCaption: (caption: SpeechCaptionPayload) => void
  /** Emit a caption-cleared broadcast payload. */
  onCaptionCleared: (cleared: SpeechCaptionClearedPayload) => void
  /** A terminal failure — the SW must stop capture and clean up budget/diagnostics. */
  onFatalError: (reason: SpeechErrorReason) => void
  /** Privacy-safe counter diagnostic stage (never text/audio/keys). */
  reportDiagnosticCount: (stage: DiagnosticStage) => void
  /** Bounded window to accumulate before a provider call. Default 5000 ms. */
  windowMs?: number
  /** Bound before drop-oldest. Default 10000 ms. */
  maxBufferMs?: number
  /** VAD energy threshold over 16-bit PCM. Default SPEECH_SILENCE_RMS_THRESHOLD. */
  silenceRmsThreshold?: number
  /** Consecutive-failure stop threshold. Default 5. */
  maxConsecutiveFailures?: number
  /** Overrides the default session id factory (crypto.randomUUID). */
  createSessionId?: () => string
}

interface BufferedChunk {
  data: ArrayBuffer
  startMs: number
  endMs: number
}

/** Compute the RMS energy of a 16-bit PCM buffer (VAD gate). */
export const computePcmRms = (pcm: ArrayBuffer): number => {
  const view = new Int16Array(pcm)
  if (view.length === 0) return 0
  let sum = 0
  for (let i = 0; i < view.length; i++) {
    const sample = view[i]!
    sum += sample * sample
  }
  return Math.sqrt(sum / view.length)
}

/** Map a capture primitive error onto the Spec §9 taxonomy. */
export const mapCaptureError = (error: SpeechCaptureError): SpeechErrorReason => {
  switch (error.reason) {
    case 'no_twitch_tab':
      return 'no_twitch_tab'
    case 'permission_denied':
      return 'permission_denied'
    case 'context_invalidated':
      return 'context_invalidated'
    case 'capture_failed':
    case 'unknown':
      return 'unknown'
    default:
      return 'unknown'
  }
}

export class SpeechPipeline {
  private readonly source: SpeechSource
  private readonly getProvider: SpeechPipelineDependencies['getProvider']
  private readonly getApiKey: SpeechPipelineDependencies['getApiKey']
  private readonly getSettings: SpeechPipelineDependencies['getSettings']
  private readonly budget: SpeechBudget
  private readonly rateLimiter: RateLimiter
  private readonly onState: SpeechPipelineDependencies['onState']
  private readonly onCaption: SpeechPipelineDependencies['onCaption']
  private readonly onCaptionCleared: SpeechPipelineDependencies['onCaptionCleared']
  private readonly onFatalError: SpeechPipelineDependencies['onFatalError']
  private readonly reportDiagnosticCount: SpeechPipelineDependencies['reportDiagnosticCount']
  private readonly windowMs: number
  private readonly maxBufferMs: number
  private readonly silenceRmsThreshold: number
  private readonly maxConsecutiveFailures: number
  private readonly createSessionId: () => string

  private state: SpeechState = INITIAL_SPEECH_STATE
  private running = false
  private provider: SpeechProvider | undefined
  private apiKey: string | undefined
  private model = ''
  private targetLang = ''

  private pending: BufferedChunk[] = []
  private pendingDurationMs = 0
  private windowSeq = 0
  private consecutiveFailures = 0
  private lastEmittedText: string | undefined
  private abortController: AbortController | undefined
  private resumeTimer: ReturnType<typeof setTimeout> | undefined
  private chunkSubscribed = false

  constructor(deps: SpeechPipelineDependencies) {
    this.source = deps.source
    this.getProvider = deps.getProvider
    this.getApiKey = deps.getApiKey
    this.getSettings = deps.getSettings
    this.budget = deps.budget
    this.rateLimiter = deps.rateLimiter
    this.onState = deps.onState
    this.onCaption = deps.onCaption
    this.onCaptionCleared = deps.onCaptionCleared
    this.onFatalError = deps.onFatalError
    this.reportDiagnosticCount = deps.reportDiagnosticCount
    this.windowMs = deps.windowMs ?? SPEECH_WINDOW_MS
    this.maxBufferMs = deps.maxBufferMs ?? SPEECH_MAX_BUFFER_MS
    this.silenceRmsThreshold = deps.silenceRmsThreshold ?? SPEECH_SILENCE_RMS_THRESHOLD
    this.maxConsecutiveFailures = deps.maxConsecutiveFailures ?? SPEECH_MAX_CONSECUTIVE_FAILURES
    this.createSessionId = deps.createSessionId ?? (() => {
      if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
      return `speech-${Date.now()}-${Math.random().toString(36).slice(2)}`
    })
  }

  /** Current state machine value (the SW reads it for toggle logic). */
  getState(): SpeechState {
    return this.state
  }

  /** True while capture + transcription are active (not idle, not a terminal error). */
  isCapturing(): boolean {
    return this.running && this.state.state !== 'idle' && this.state.state !== 'error'
  }

  /**
   * Start capture. Resolves once the capture primitive has been asked to start
   * (errors surface through onError/onState/onFatalError). Idempotent: a second
   * start while already capturing is a no-op.
   */
  async start(): Promise<void> {
    if (this.running) return

    this.subscribeChunks()

    const settings = await this.getSettings()
    const config = settings.speechConfig
    // The popup toggle IS the consent gesture (Spec §8.2); by the time a
    // speech_control start arrives, speechEnabled is already true. Never
    // auto-start on install/startup (Spec §2).
    if (!config.speechEnabled) return

    const provider = this.getProvider(config.speechProvider)
    if (!provider) {
      this.fail('unknown')
      return
    }
    const apiKey = await this.getApiKey(config.speechProvider)
    if (!apiKey) {
      this.fail('auth')
      return
    }

    // Resume the same session across an MV3 worker wake; a fresh id resets the
    // session counter on a new enable (Spec §7).
    const activeSessionId = await this.budget.readActiveSessionId()
    const sessionId = activeSessionId ?? this.createSessionId()
    const usage = await this.budget.beginSession(sessionId)
    if (usage.dailySeconds >= usage.dailyCapSeconds) {
      this.fail('budget_exhausted')
      return
    }

    this.provider = provider
    this.apiKey = apiKey
    this.model = config.speechModel
    this.targetLang = config.speechTargetLanguage
    this.budget.setSessionCapMinutes(config.maxSessionMinutes)
    this.running = true
    this.consecutiveFailures = 0
    this.abortController = new AbortController()

    this.dispatch({ type: 'start', consentRequired: false })
    this.reportDiagnosticCount('speech_started')

    await this.source.start()
  }

  /** Stop capture and return to idle. Clears captions and ends the session. */
  async stop(): Promise<void> {
    if (!this.running) return

    this.running = false
    this.clearResumeTimer()
    this.abortController?.abort()
    this.dispatch({ type: 'stop' })
    this.reportDiagnosticCount('speech_stopped')

    await this.source.stop()
    this.clearBuffer()
    this.onCaptionCleared({ reason: 'idle' })
    await this.budget.markSessionInactive()
    await this.budget.flush()
  }

  /**
   * Restore the reconnectable paused state after the SW woke from suspension
   * (Spec §7). The user re-enables to resume; the paused broadcast keeps the
   * overlay truthful instead of showing idle. Forced directly because the
   * reducer's `pause` only fires from a live machine and the freshly woken
   * worker starts at idle.
   */
  restorePaused(): void {
    this.state = { state: 'paused', reason: 'network' }
    this.broadcastState()
  }

  // --- internal --------------------------------------------------------------

  private subscribeChunks(): void {
    if (this.chunkSubscribed) return
    this.chunkSubscribed = true
    this.source.onChunk((chunk) => this.handleChunk(chunk))
    this.source.onError((error) => this.handleSourceError(error))
    this.source.onDisconnect((reason) => this.handleDisconnect(reason))
  }

  private handleChunk(chunk: AudioChunk): void {
    if (!this.running) return
    // While paused (rate limit / quota cooldown) keep buffering bounded audio
    // (Spec §9: keep ≤10 s) but never send or bill a window until resumed.
    if (this.state.state === 'paused') {
      this.pushBuffer(chunk)
      return
    }
    // VAD gate (Spec §2): a silent chunk is never sent and never billed.
    if (this.isSilent(chunk)) {
      // Silence ends an utterance: flush the pending speech as a FINAL window
      // (translated). Then skip the silent chunk entirely.
      if (this.pending.length > 0) {
        this.flushWindow(true)
      }
      return
    }

    if (chunk.isFinal === true && this.pending.length > 0) {
      this.flushWindow(true)
      return
    }

    this.pushBuffer(chunk)
    if (this.pendingDurationMs >= this.windowMs) {
      this.flushWindow(false)
    }
  }

  private isSilent(chunk: AudioChunk): boolean {
    if (this.silenceRmsThreshold <= 0) return false
    return computePcmRms(chunk.data) < this.silenceRmsThreshold
  }

  private pushBuffer(chunk: AudioChunk): void {
    const startMs = typeof chunk.startMs === 'number' ? chunk.startMs : 0
    const endMs = typeof chunk.endMs === 'number' ? chunk.endMs : startMs
    this.pending.push({ data: chunk.data, startMs, endMs })
    this.pendingDurationMs += Math.max(0, endMs - startMs)

    // Bounded buffer, drop-oldest (Spec §9): never let pending audio grow
    // unbounded, e.g. while paused for a rate limit.
    while (this.pending.length > 1 && this.pendingDurationMs > this.maxBufferMs) {
      const dropped = this.pending.shift()!
      this.pendingDurationMs -= Math.max(0, dropped.endMs - dropped.startMs)
    }
  }

  private clearBuffer(): void {
    this.pending = []
    this.pendingDurationMs = 0
  }

  private buildChunk(final: boolean): AudioChunk {
    const totalBytes = this.pending.reduce((sum, entry) => sum + entry.data.byteLength, 0)
    const merged = new Uint8Array(totalBytes)
    let offset = 0
    for (const entry of this.pending) {
      merged.set(new Uint8Array(entry.data), offset)
      offset += entry.data.byteLength
    }
    const first = this.pending[0]!
    const last = this.pending[this.pending.length - 1]!
    return {
      chunkId: `speech-window-${++this.windowSeq}`,
      data: merged.buffer,
      mimeType: 'audio/pcm;rate=16000',
      startMs: first.startMs,
      endMs: last.endMs,
      isFinal: final,
    }
  }

  private flushWindow(final: boolean): void {
    if (!this.running || this.pending.length === 0) return

    const chunk = this.buildChunk(final)
    const windowSeconds = this.pendingDurationMs / 1000
    this.clearBuffer()

    // Bill the provider-sent window. Throwing here means the cap is hit: stop
    // the stream and surface budget_exhausted (Spec §9/§10). The failed window
    // is never charged.
    try {
      this.budget.chargeSeconds(windowSeconds)
    } catch (error) {
      if (error instanceof SpeechBudgetExceededError) {
        this.fail('budget_exhausted')
        return
      }
      throw error
    }
    void this.budget.flush().catch(() => undefined)

    this.dispatch({ type: 'chunk_sent' })
    this.reportDiagnosticCount('speech_chunk_sent')

    const provider = this.provider!
    const apiKey = this.apiKey!
    const signal = this.abortController?.signal
    void provider
      .transcribeChunk(chunk, apiKey, this.model, this.targetLang, signal)
      .then((results) => this.handleTranscriptionResults(results))
      .catch(() => this.handleProviderError({ type: 'network', message: 'Speech transcription failed' }))
  }

  private handleTranscriptionResults(results: SpeechTranslationResult[]): void {
    if (!this.running) return

    let anyError = false
    for (const result of results) {
      if (result.error) {
        anyError = true
        this.handleProviderError(result.error)
        // A fatal error already stopped the pipeline; stop processing further.
        if (!this.running) return
        continue
      }
      this.emitCaption(result)
    }
    if (!anyError) {
      // All results succeeded: back to capturing. Recoverable errors leave the
      // machine paused (handleProviderError decides the next state).
      this.dispatch({ type: 'transcription_complete' })
      this.consecutiveFailures = 0
    }
  }

  private emitCaption(result: SpeechTranslationResult): void {
    const isFinal = result.isFinal === true
    const text = isFinal && result.translatedText !== undefined
      ? result.translatedText
      : result.text
    if (!text) {
      // Empty transcript ("no speech") produces no caption.
      return
    }

    // Dedup (dirty-check): skip re-emit if this display text was just emitted,
    // including a final that duplicates the previous line (Spec §6/§10).
    if (text === this.lastEmittedText) {
      return
    }
    this.lastEmittedText = text

    const caption: SpeechCaptionPayload = {
      id: result.id,
      text,
      interim: !isFinal,
    }
    this.onCaption(caption)
    this.reportDiagnosticCount('speech_caption_emitted')
  }

  private handleProviderError(error: ProviderError): void {
    if (!this.running) return

    if (error.type === 'auth') {
      this.fail('auth')
      return
    }
    if (error.type === 'rate_limited' || error.type === 'quota_exceeded') {
      this.pauseWithCooldown(error)
      return
    }

    // Network/bad_request/invalid_response/timeout/unknown: the in-flight
    // window is dropped (each window is sent at most once — no retransmit,
    // Spec §9). Stop after a threshold of consecutive failures.
    this.consecutiveFailures++
    this.reportDiagnosticCount('speech_error')
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.fail('network')
    }
  }

  private pauseWithCooldown(error: ProviderError): void {
    const reason: SpeechErrorReason = error.type === 'rate_limited' ? 'rate_limited' : 'quota_exceeded'
    const retryAfterMs = error.type === 'rate_limited'
      ? (typeof (error as { retryAfterMs?: unknown }).retryAfterMs === 'number'
          ? (error as { retryAfterMs: number }).retryAfterMs
          : 1_000)
      : 1_000
    this.rateLimiter.recordError(SPEECH_RATE_LIMIT_KEY, retryAfterMs)

    this.dispatch({ type: 'pause', reason })
    this.reportDiagnosticCount('speech_error')

    // Resume transcription after the cooldown (the bounded buffer keeps up to
    // maxBufferMs of audio that arrived during the pause).
    const remaining = this.rateLimiter.getRemainingCooldown(SPEECH_RATE_LIMIT_KEY)
    this.clearResumeTimer()
    this.resumeTimer = setTimeout(() => {
      if (!this.running) return
      this.dispatch({ type: 'resume' })
      if (this.pending.length > 0) {
        this.flushWindow(false)
      }
    }, remaining)
  }

  private handleSourceError(error: SpeechCaptureError): void {
    if (!this.running) return
    const reason = mapCaptureError(error)
    if (reason === 'no_twitch_tab') {
      // Spec §9: return to idle, no capture attempted, no error surfaced.
      this.dispatch({ type: 'stop' })
      this.running = false
      this.onCaptionCleared({ reason: 'idle' })
      return
    }
    this.fail(reason)
  }

  private handleDisconnect(reason: string): void {
    // 'stopped' is our own stop path (the port teardown fires the callback);
    // the machine is already idle by then.
    if (reason === 'stopped') return
    if (!this.running) return
    // SW suspension / port drop (Spec §7): the stream stops; the session
    // counter stays active so a re-enable resumes it. Surface a reconnectable
    // paused state.
    this.running = false
    this.clearBuffer()
    this.dispatch({ type: 'pause', reason: 'network' })
  }

  private fail(reason: SpeechErrorReason): void {
    this.running = false
    this.clearResumeTimer()
    this.abortController?.abort()
    this.clearBuffer()
    this.dispatch({ type: 'error', reason })
    this.reportDiagnosticCount('speech_error')
    this.onCaptionCleared({ reason: 'disabled' })
    this.onFatalError(reason)
  }

  private dispatch(action: SpeechAction): void {
    const next = speechReducer(this.state, action)
    if (next === this.state) return
    this.state = next
    this.broadcastState()
  }

  private broadcastState(): void {
    const payload: SpeechStatePayload = { state: this.state.state }
    if (this.state.reason) {
      payload.reason = this.state.reason
      payload.errorKey = SPEECH_ERROR_KEYS[this.state.reason]
    }
    this.onState(payload)
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer !== undefined) {
      clearTimeout(this.resumeTimer)
      this.resumeTimer = undefined
    }
  }
}
