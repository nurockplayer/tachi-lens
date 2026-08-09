// Pure state machine for the v0.3 speech pipeline (Spec §6/§7/§9).
//
// This module has NO chrome/DOM dependency: it is a plain reducer over the
// `speech_state` machine, plus the `SpeechErrorReason` taxonomy and the fixed
// i18n error-key mapping. The Service Worker drives it with `SpeechAction`s;
// the reducer decides the next state and the Service Worker broadcasts the
// resulting `speech_state` message (§6). Keeping it pure makes every
// transition deterministically unit-testable (Spec §11).

import type { MessageKey } from './i18n'

export type SpeechPipelineState =
  | 'idle'
  | 'consent_pending'
  | 'capturing'
  | 'transcribing'
  | 'paused'
  | 'error'

/** Error taxonomy from Spec §6. Exact set; never extends it silently. */
export type SpeechErrorReason =
  | 'auth'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'network'
  | 'no_twitch_tab'
  | 'permission_denied'
  | 'context_invalidated'
  | 'budget_exhausted'
  | 'unknown'

export const SPEECH_STATES: readonly SpeechPipelineState[] = [
  'idle',
  'consent_pending',
  'capturing',
  'transcribing',
  'paused',
  'error',
]

export const SPEECH_ERROR_REASONS: readonly SpeechErrorReason[] = [
  'auth',
  'rate_limited',
  'quota_exceeded',
  'network',
  'no_twitch_tab',
  'permission_denied',
  'context_invalidated',
  'budget_exhausted',
  'unknown',
]

export interface SpeechState {
  state: SpeechPipelineState
  /** Present only when the machine is in `error` or `paused`. */
  reason?: SpeechErrorReason
}

export const INITIAL_SPEECH_STATE: SpeechState = { state: 'idle' }

export type SpeechAction =
  | { type: 'start'; consentRequired: boolean }
  | { type: 'consent_granted' }
  | { type: 'capture_started' }
  | { type: 'chunk_sent' }
  | { type: 'transcription_complete' }
  | { type: 'pause'; reason: SpeechErrorReason }
  | { type: 'resume' }
  | { type: 'error'; reason: SpeechErrorReason }
  | { type: 'stop' }
  | { type: 'reset' }

/**
 * Fixed i18n key for every `SpeechErrorReason`. Error payloads carry ONLY this
 * key (never raw provider messages, keys, audio, or transcript — Spec §6).
 */
export const SPEECH_ERROR_KEYS: Record<SpeechErrorReason, MessageKey> = {
  auth: 'speechErrorAuth',
  rate_limited: 'speechErrorRateLimited',
  quota_exceeded: 'speechErrorQuota',
  network: 'speechErrorNetwork',
  no_twitch_tab: 'speechErrorNoTwitchTab',
  permission_denied: 'speechErrorPermissionDenied',
  context_invalidated: 'speechErrorContextInvalidated',
  budget_exhausted: 'speechErrorBudget',
  unknown: 'speechErrorUnknown',
}

/**
 * Pure reducer for the `speech_state` machine.
 *
 * Transition matrix (documented against Spec §7/§9):
 *   idle ─start(consentRequired)→ consent_pending
 *   idle ─start(no consent needed)→ capturing
 *   consent_pending ─consent_granted→ capturing
 *   capturing ─chunk_sent→ transcribing
 *   transcribing ─transcription_complete→ capturing
 *   capturing/transcribing ─pause→ paused
 *   paused ─resume→ capturing
 *   capturing/transcribing/paused/consent_pending ─error(reason)→ error
 *   any ─stop→ idle
 *   error ─reset→ idle
 *
 * Invalid transitions are no-ops (the action is ignored and the state is
 * returned unchanged). `capture_started` is idempotent in `capturing`.
 */
export const speechReducer = (state: SpeechState, action: SpeechAction): SpeechState => {
  switch (action.type) {
    case 'start':
      if (state.state === 'capturing' || state.state === 'transcribing') return state
      return { state: action.consentRequired ? 'consent_pending' : 'capturing' }
    case 'consent_granted':
      if (state.state !== 'consent_pending') return state
      return { state: 'capturing' }
    case 'capture_started':
      if (state.state === 'capturing') return state
      if (state.state === 'consent_pending') return { state: 'capturing' }
      return state
    case 'chunk_sent':
      if (state.state === 'transcribing') return state
      if (state.state === 'capturing') return { state: 'transcribing' }
      return state
    case 'transcription_complete':
      if (state.state !== 'transcribing') return state
      return { state: 'capturing' }
    case 'pause':
      if (state.state !== 'capturing' && state.state !== 'transcribing' && state.state !== 'paused') {
        return state
      }
      return { state: 'paused', reason: action.reason }
    case 'resume':
      if (state.state !== 'paused') return state
      return { state: 'capturing' }
    case 'error':
      return { state: 'error', reason: action.reason }
    case 'stop':
      if (state.state === 'idle') return state
      return { state: 'idle' }
    case 'reset':
      return { state: 'idle' }
    default:
      return state
  }
}

export const isSpeechState = (value: unknown): value is SpeechPipelineState =>
  typeof value === 'string' && SPEECH_STATES.includes(value as SpeechPipelineState)

export const isSpeechErrorReason = (value: unknown): value is SpeechErrorReason =>
  typeof value === 'string' && SPEECH_ERROR_REASONS.includes(value as SpeechErrorReason)
