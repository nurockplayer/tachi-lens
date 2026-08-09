// Speech budget accounting (v0.3 speech, Spec §10 / §7).
//
// Two caps, both counting AUDIO SECONDS BILLED TO THE PROVIDER (non-silent
// windows actually sent — VAD-skipped silence never consumes budget, Spec §2):
//
//   1. Session cap  — `maxSessionMinutes` (default 30), a hard stop per session.
//   2. Daily cap    — persisted audio-minute cap per provider day, default 180
//      minutes (3 h/day). Rolls over on the Gemini provider day
//      (America/Los_Angeles, matching the chat quota's day boundary).
//
// D4 decision (recorded, Spec §14): the daily audio-minute cap persists under a
// NEW storage key (`speechAudioUsage` in chrome.storage.local, mirrored to
// `speechAudioUsageSession` in chrome.storage.session) rather than riding the
// existing `geminiQuotaUsage` machinery. Rationale: Spec §1/§10 require speech
// cost/quota accounting to be SEPARATE from the chat quota buckets ("it never
// consumes chat Gemini RPM/TPM/RPD"), and `geminiQuotaUsage`'s schema is
// request-count-shaped (reservations, requestsToday) with a fail-closed
// migration story that speech has no need for. A dedicated key keeps speech
// accounting independent, versioned, and trivially resettable. The provider-day
// boundary function `getGeminiProviderDayId` is reused (a pure helper with no
// chat quota state) so the rollover day matches what Gemini actually enforces.
//
// Billing model: `chargeSeconds()` is SYNCHRONOUS and in-memory (the pipeline
// bills every non-silent window as it arrives so the caps bite exactly; a
// drop-oldest refund is unnecessary because a chunk dropped during buffering
// is never part of a sent window and is never charged). `flush()` is the async
// persistence point — the pipeline calls it on window flush, stop, and fatal
// error so at most one window (~5 s) of charges is ever at risk of loss on an
// MV3 worker kill.
//
// Session restore across SW suspension (Spec §7): the session counter and the
// active-session marker live in chrome.storage.session. When the worker is
// terminated the Port drops; on the next wake `readActiveSessionId()` returns
// the still-active session id, so the user's re-enable resumes the same session
// counter instead of restarting it. An explicit stop (`markSessionInactive`)
// ends the session so the next enable starts a fresh session counter.

import { getGeminiProviderDayId } from './gemini-quota'

/** Default daily audio-minute cap (D4). Popup surfacing is deferred. */
export const DEFAULT_DAILY_AUDIO_MINUTE_CAP = 180

export const SPEECH_AUDIO_USAGE_LOCAL_KEY = 'speechAudioUsage'
export const SPEECH_AUDIO_USAGE_SESSION_KEY = 'speechAudioUsageSession'
export const SPEECH_SESSION_STATE_KEY = 'speechSessionState'

const LOCAL_USAGE_VERSION = 1

/** Thrown when a charge would exceed a cap. `kind` is 'session' | 'daily'. */
export class SpeechBudgetExceededError extends Error {
  constructor(readonly kind: 'session' | 'daily') {
    super(`speech budget exhausted: ${kind}`)
  }
}

export interface SpeechBudgetStorage {
  getLocal(): Promise<Record<string, unknown>>
  setLocal(value: Record<string, unknown>): Promise<void>
  getSession(): Promise<Record<string, unknown>>
  setSession(value: Record<string, unknown>): Promise<void>
}

export interface SpeechBudgetUsage {
  /** Captured-and-billed seconds in the current session. */
  sessionSeconds: number
  /** Captured-and-billed seconds on the current provider day. */
  dailySeconds: number
  /** Provider day id (yyyy-mm-dd, America/Los_Angeles) for the daily counter. */
  providerDay: string
  /** Session cap in seconds (from maxSessionMinutes). */
  sessionCapSeconds: number
  /** Daily cap in seconds. */
  dailyCapSeconds: number
}

interface SessionState {
  sessionId: string
  audioSeconds: number
  /** True while a session is live; cleared by an explicit stop. */
  active: boolean
}

const toNonNegativeNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

const toSeconds = (minutes: number): number =>
  Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : 0

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asSessionState = (value: unknown): SessionState | undefined => {
  if (!isRecord(value)) return undefined
  if (typeof value.sessionId !== 'string') return undefined
  if (typeof value.audioSeconds !== 'number' || !Number.isFinite(value.audioSeconds)) return undefined
  if (typeof value.active !== 'boolean') return undefined
  return {
    sessionId: value.sessionId,
    audioSeconds: value.audioSeconds,
    active: value.active,
  }
}

export class SpeechBudget {
  private readonly storage: SpeechBudgetStorage
  private readonly dailyCapSeconds: number
  private readonly optionSessionCapSeconds: number
  private readonly now: () => number
  private sessionSeconds = 0
  private sessionId: string | undefined
  private active = false
  private dailySeconds = 0
  private providerDay: string | undefined
  /** Runtime session cap (seconds) from settings; undefined until set. */
  private sessionCapOverrideSeconds: number | undefined

  constructor(options: SpeechBudgetOptions) {
    this.storage = options.storage
    const dailyCapMinutes = options.dailyCapMinutes ?? DEFAULT_DAILY_AUDIO_MINUTE_CAP
    this.dailyCapSeconds = toSeconds(dailyCapMinutes)
    const sessionCapMinutes = options.getSessionCapMinutes?.() ?? 30
    this.optionSessionCapSeconds = toSeconds(sessionCapMinutes)
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Set the session cap from the (async-read) settings before beginSession().
   * The pipeline reads maxSessionMinutes from speechConfig and calls this; the
   * option-based value is only a fallback for direct construction/tests.
   */
  setSessionCapMinutes(minutes: number): void {
    const seconds = toSeconds(minutes)
    if (seconds > 0) {
      this.sessionCapOverrideSeconds = seconds
    }
  }

  private getSessionCapSeconds(): number {
    return this.sessionCapOverrideSeconds ?? this.optionSessionCapSeconds
  }

  /**
   * Begin (or resume) a session. When `sessionId` matches the persisted active
   * session (an SW wake inside a live session), the session counter resumes;
   * a fresh id resets it. Always restores the persisted daily counter with
   * provider-day rollover. Call before any `chargeSeconds()`.
   */
  async beginSession(sessionId: string): Promise<SpeechBudgetUsage> {
    await this.load(sessionId)
    this.active = true
    await this.persistSession()
    return this.getUsage()
  }

  /**
   * Charge `seconds` of billed audio. Synchronous in-memory; `flush()` persists.
   * Throws `SpeechBudgetExceededError` when the charge would exceed either cap
   * (nothing is charged for the rejected window). Requires a prior
   * `beginSession()`.
   */
  chargeSeconds(seconds: number): SpeechBudgetUsage {
    const amount = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
    this.rolloverDaily()

    const sessionCapSeconds = this.getSessionCapSeconds()
    if (this.sessionSeconds + amount > sessionCapSeconds) {
      throw new SpeechBudgetExceededError('session')
    }
    if (this.dailySeconds + amount > this.dailyCapSeconds) {
      throw new SpeechBudgetExceededError('daily')
    }

    this.sessionSeconds += amount
    this.dailySeconds += amount
    return this.getUsage()
  }

  /** Persist the current session + daily counters (local authoritative). */
  async flush(): Promise<void> {
    await this.persistSession()
    await this.persistDaily()
  }

  /** Sync read of the in-memory usage (popup/diagnostics). */
  getUsage(): SpeechBudgetUsage {
    return {
      sessionSeconds: this.sessionSeconds,
      dailySeconds: this.dailySeconds,
      providerDay: this.currentProviderDay(),
      sessionCapSeconds: this.getSessionCapSeconds(),
      dailyCapSeconds: this.dailyCapSeconds,
    }
  }

  /** True when the session counter is at/over its cap. */
  isSessionExhausted(): boolean {
    return this.sessionSeconds >= this.getSessionCapSeconds()
  }

  /** True when the daily counter is at/over its cap. */
  isDailyExhausted(): boolean {
    return this.dailySeconds >= this.dailyCapSeconds
  }

  /**
   * Return the persisted active session id, or undefined when no session is
   * live (fresh enable / after an explicit stop). Used to resume the session
   * counter across an MV3 worker wake (Spec §7).
   */
  async readActiveSessionId(): Promise<string | undefined> {
    const sessionValue = await this.storage.getSession()
    const state = asSessionState(sessionValue[SPEECH_SESSION_STATE_KEY])
    return state?.active && state.sessionId ? state.sessionId : undefined
  }

  /** End the current session so the next enable starts a fresh session counter. */
  async markSessionInactive(): Promise<void> {
    this.active = false
    await this.persistSession()
  }

  private async load(sessionId: string): Promise<void> {
    const [localValue, sessionValue] = await Promise.all([
      this.storage.getLocal(),
      this.storage.getSession(),
    ])

    // --- Daily usage (local = durable commit point) --------------------------
    const storedLocal = isRecord(localValue[SPEECH_AUDIO_USAGE_LOCAL_KEY])
      ? localValue[SPEECH_AUDIO_USAGE_LOCAL_KEY] as Record<string, unknown>
      : {}
    const storedDay = typeof storedLocal.providerDay === 'string' ? storedLocal.providerDay : undefined
    const currentDay = this.currentProviderDay()

    // Clock-rollback / future-day guard: a persisted day in the future means the
    // wall clock moved backwards since the last write; retain the stored day and
    // count (fail-safe) rather than zeroing an ambiguous counter.
    const dayIsFuture = storedDay !== undefined && storedDay > currentDay
    this.providerDay = dayIsFuture ? storedDay : currentDay
    this.dailySeconds = dayIsFuture
      ? toNonNegativeNumber(storedLocal.audioSeconds)
      : storedDay === currentDay
        ? toNonNegativeNumber(storedLocal.audioSeconds)
        : 0

    // --- Session usage (session mirror, resumed across SW wakes) -------------
    const storedSessionState = asSessionState(sessionValue[SPEECH_SESSION_STATE_KEY])
    this.sessionId = sessionId
    this.sessionSeconds =
      sessionId && storedSessionState?.sessionId === sessionId && storedSessionState.active
        ? toNonNegativeNumber(storedSessionState.audioSeconds)
        : 0
  }

  private rolloverDaily(): void {
    const currentDay = this.currentProviderDay()
    // Only roll over when strictly ahead; a backwards or equal day keeps the
    // current counter (future-day retention handled in load()).
    if (this.providerDay !== undefined && currentDay > this.providerDay) {
      this.providerDay = currentDay
      this.dailySeconds = 0
    }
  }

  private currentProviderDay(): string {
    return getGeminiProviderDayId(this.now())
  }

  private async persistSession(): Promise<void> {
    const state: SessionState = {
      sessionId: this.sessionId ?? '',
      audioSeconds: this.sessionSeconds,
      active: this.active,
    }
    await this.storage.setSession({ [SPEECH_SESSION_STATE_KEY]: state })
  }

  private async persistDaily(): Promise<void> {
    const usage = {
      version: LOCAL_USAGE_VERSION,
      providerDay: this.providerDay ?? this.currentProviderDay(),
      audioSeconds: this.dailySeconds,
    }
    // Local is the durable commit point; the session mirror is best-effort
    // (a failing mirror write must never lose the authoritative counter).
    await this.storage.setLocal({ [SPEECH_AUDIO_USAGE_LOCAL_KEY]: usage })
    try {
      await this.storage.setSession({ [SPEECH_AUDIO_USAGE_SESSION_KEY]: usage })
    } catch {
      // Best-effort mirror; the local write already committed.
    }
  }
}

export interface SpeechBudgetOptions {
  storage: SpeechBudgetStorage
  /** Overrides DEFAULT_DAILY_AUDIO_MINUTE_CAP. Injected for deterministic tests. */
  dailyCapMinutes?: number
  /** Resolves maxSessionMinutes from settings (clamped >= 1 min by normalizeSpeechConfig). */
  getSessionCapMinutes?: () => number
  /** Wall-clock now (ms epoch). Defaults to Date.now(). */
  now?: () => number
}

/**
 * chrome.storage-backed `SpeechBudgetStorage` for the Service Worker.
 * Kept separate so `SpeechBudget` stays pure and unit-testable with fakes.
 */
export const createSpeechBudgetChromeStorage = (): SpeechBudgetStorage => ({
  getLocal: async () => {
    const items = await chrome.storage.local.get(SPEECH_AUDIO_USAGE_LOCAL_KEY)
    return items as Record<string, unknown>
  },
  setLocal: async (value) => chrome.storage.local.set(value),
  getSession: async () => {
    const items = await chrome.storage.session.get([
      SPEECH_SESSION_STATE_KEY,
      SPEECH_AUDIO_USAGE_SESSION_KEY,
    ])
    return items as Record<string, unknown>
  },
  setSession: async (value) => chrome.storage.session.set(value),
})
