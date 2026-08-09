// Pure reducer tests for the v0.3 speech_state machine (Spec §6/§7/§9).
// Deterministic: no chrome/DOM/provider — every transition is a pure function.

import { describe, expect, it } from 'vitest'
import {
  INITIAL_SPEECH_STATE,
  SPEECH_ERROR_KEYS,
  SPEECH_ERROR_REASONS,
  SPEECH_STATES,
  isSpeechErrorReason,
  isSpeechState,
  speechReducer,
  type SpeechAction,
  type SpeechState,
} from './speech-state'

describe('speechReducer', () => {
  it('starts at idle', () => {
    expect(INITIAL_SPEECH_STATE).toEqual({ state: 'idle' })
  })

  describe('start', () => {
    it('idle → consent_pending when consent is required', () => {
      expect(speechReducer(INITIAL_SPEECH_STATE, { type: 'start', consentRequired: true }))
        .toEqual({ state: 'consent_pending' })
    })

    it('idle → capturing when no consent is needed', () => {
      expect(speechReducer(INITIAL_SPEECH_STATE, { type: 'start', consentRequired: false }))
        .toEqual({ state: 'capturing' })
    })

    it('error → capturing on a fresh start (recovery)', () => {
      expect(speechReducer({ state: 'error', reason: 'auth' }, { type: 'start', consentRequired: false }))
        .toEqual({ state: 'capturing' })
    })

    it('is a no-op while already capturing or transcribing', () => {
      const capturing = { state: 'capturing' as const }
      expect(speechReducer(capturing, { type: 'start', consentRequired: false })).toBe(capturing)
      const transcribing = { state: 'transcribing' as const }
      expect(speechReducer(transcribing, { type: 'start', consentRequired: false })).toBe(transcribing)
    })
  })

  describe('consent', () => {
    it('consent_pending → capturing on consent_granted', () => {
      expect(speechReducer({ state: 'consent_pending' }, { type: 'consent_granted' }))
        .toEqual({ state: 'capturing' })
    })

    it('consent_granted is a no-op outside consent_pending', () => {
      const idle = INITIAL_SPEECH_STATE
      expect(speechReducer(idle, { type: 'consent_granted' })).toBe(idle)
    })
  })

  describe('capture_started', () => {
    it('capturing stays capturing (idempotent)', () => {
      const capturing = { state: 'capturing' as const }
      expect(speechReducer(capturing, { type: 'capture_started' })).toBe(capturing)
    })
    it('is a no-op when not capturing', () => {
      expect(speechReducer(INITIAL_SPEECH_STATE, { type: 'capture_started' })).toEqual({ state: 'idle' })
    })
  })

  describe('transcribe', () => {
    it('capturing → transcribing on chunk_sent', () => {
      expect(speechReducer({ state: 'capturing' }, { type: 'chunk_sent' })).toEqual({ state: 'transcribing' })
    })
    it('transcribing stays transcribing on another chunk_sent', () => {
      const transcribing = { state: 'transcribing' as const }
      expect(speechReducer(transcribing, { type: 'chunk_sent' })).toBe(transcribing)
    })
    it('transcribing → capturing on transcription_complete', () => {
      expect(speechReducer({ state: 'transcribing' }, { type: 'transcription_complete' }))
        .toEqual({ state: 'capturing' })
    })
    it('transcription_complete is a no-op outside transcribing', () => {
      expect(speechReducer({ state: 'capturing' }, { type: 'transcription_complete' })).toEqual({ state: 'capturing' })
    })
  })

  describe('pause / resume', () => {
    it('capturing/transcribing → paused with the reason', () => {
      expect(speechReducer({ state: 'capturing' }, { type: 'pause', reason: 'rate_limited' }))
        .toEqual({ state: 'paused', reason: 'rate_limited' })
      expect(speechReducer({ state: 'transcribing' }, { type: 'pause', reason: 'quota_exceeded' }))
        .toEqual({ state: 'paused', reason: 'quota_exceeded' })
    })
    it('paused → capturing on resume', () => {
      expect(speechReducer({ state: 'paused', reason: 'rate_limited' }, { type: 'resume' }))
        .toEqual({ state: 'capturing' })
    })
    it('resume is a no-op outside paused', () => {
      expect(speechReducer({ state: 'capturing' }, { type: 'resume' })).toEqual({ state: 'capturing' })
    })
    it('pause is a no-op from idle/error/consent_pending', () => {
      expect(speechReducer(INITIAL_SPEECH_STATE, { type: 'pause', reason: 'network' })).toEqual({ state: 'idle' })
      expect(speechReducer({ state: 'error', reason: 'auth' }, { type: 'pause', reason: 'network' }))
        .toEqual({ state: 'error', reason: 'auth' })
    })
  })

  describe('error', () => {
    it('any live state → error with the reason', () => {
      for (const from of [{ state: 'capturing' as const }, { state: 'transcribing' as const }, { state: 'paused' as const, reason: 'rate_limited' as const }, { state: 'consent_pending' as const }]) {
        expect(speechReducer(from, { type: 'error', reason: 'budget_exhausted' }))
          .toEqual({ state: 'error', reason: 'budget_exhausted' })
      }
    })
    it('error → reset → idle (terminal recovery requires explicit reset)', () => {
      const errored: SpeechState = { state: 'error', reason: 'auth' }
      expect(speechReducer(errored, { type: 'reset' })).toEqual({ state: 'idle' })
    })
  })

  describe('stop', () => {
    it('any live state → idle', () => {
      for (const from of [{ state: 'capturing' as const }, { state: 'transcribing' as const }, { state: 'paused' as const, reason: 'network' as const }, { state: 'consent_pending' as const }]) {
        expect(speechReducer(from, { type: 'stop' })).toEqual({ state: 'idle' })
      }
    })
    it('idle stays idle', () => {
      expect(speechReducer(INITIAL_SPEECH_STATE, { type: 'stop' })).toEqual({ state: 'idle' })
    })
  })
})

describe('SpeechErrorReason taxonomy', () => {
  it('has the exact Spec §6 set', () => {
    expect(SPEECH_ERROR_REASONS).toEqual([
      'auth',
      'rate_limited',
      'quota_exceeded',
      'network',
      'no_twitch_tab',
      'permission_denied',
      'context_invalidated',
      'budget_exhausted',
      'unknown',
    ])
  })

  it('maps every reason to a fixed i18n error key', () => {
    for (const reason of SPEECH_ERROR_REASONS) {
      expect(SPEECH_ERROR_KEYS[reason]).toMatch(/^speechError/)
    }
  })

  it('guards reject unknown states and reasons', () => {
    expect(isSpeechState('capturing')).toBe(true)
    expect(isSpeechState('banana')).toBe(false)
    expect(isSpeechErrorReason('auth')).toBe(true)
    expect(isSpeechErrorReason('banana')).toBe(false)
    for (const state of SPEECH_STATES) expect(isSpeechState(state)).toBe(true)
  })
})

describe('invalid action no-ops', () => {
  it('returns the same state object for an inapplicable action', () => {
    const idle = INITIAL_SPEECH_STATE
    const actions: SpeechAction[] = [
      { type: 'consent_granted' },
      { type: 'capture_started' },
      { type: 'chunk_sent' },
      { type: 'transcription_complete' },
      { type: 'resume' },
      { type: 'stop' },
    ]
    for (const action of actions) {
      expect(speechReducer(idle, action)).toBe(idle)
    }
  })
})
