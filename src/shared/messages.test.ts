import { describe, expect, it } from 'vitest'
import {
  isBaseMessage,
  isContentSettingsRequestMessage,
  isDiagnosticEventMessage,
  isErrorNotificationMessage,
  isGetQuotaHealthMessage,
  isQuotaHealthResetResultMessage,
  isQuotaHealthResult,
  isQuotaHealthResultMessage,
  isResetQuotaHealthMessage,
  isSettingsUpdateMessage,
  isSpeechCaptionClearedMessage,
  isSpeechCaptionMessage,
  isSpeechControlMessage,
  isSpeechSettingsUpdateMessage,
  isSpeechStateMessage,
  isTranslationRequestMessage,
  serializeMessage,
  type BaseMessage,
  type ErrorNotification,
  type QuotaHealthResult,
  type SpeechSettingsUpdatePayload,
  type TranslationRequest,
  type SettingsUpdatePayload,
} from './messages'

describe('message protocol guards', () => {
  it('accepts a base message with a known type and object payload', () => {
    expect(isBaseMessage({ type: 'translate_request', payload: { messageId: 'm1', text: 'Hello' } })).toBe(true)
  })

  it('rejects unknown message types and missing payloads', () => {
    expect(isBaseMessage({ type: 'unknown', payload: {} })).toBe(false)
    expect(isBaseMessage({ type: 'translate_request' })).toBe(false)
  })

  it('accepts diagnostic events and snapshot requests', () => {
    expect(isBaseMessage({
      type: 'diagnostic_event',
      payload: { id: 'd1', stage: 'message_detected', timestamp: 1000 },
    })).toBe(true)
    expect(isBaseMessage({ type: 'get_diagnostics', payload: {} })).toBe(true)
  })

  describe('privacy-safe counter diagnostic stages (#60)', () => {
    it('accepts a counter event with a bounded non-negative count', () => {
      for (const stage of ['batch_dedup_removed', 'in_flight_coalesced', 'queue_overflow_drop', 'queue_obsolete_drop', 'l2_cache_hit', 'speech_started', 'speech_stopped', 'speech_caption_emitted', 'speech_chunk_sent', 'speech_error']) {
        expect(isDiagnosticEventMessage({
          type: 'diagnostic_event',
          payload: { id: 'd1', stage, timestamp: 1000, count: 3 },
        })).toBe(true)
      }
    })

    it('accepts a counter event with no count (aggregated in the Service Worker)', () => {
      expect(isDiagnosticEventMessage({
        type: 'diagnostic_event',
        payload: { id: 'd1', stage: 'queue_overflow_drop', timestamp: 1000 },
      })).toBe(true)
    })

    it('rejects counter events that carry a detail string', () => {
      // `detail` is reserved for message-bearing content; counter stages must
      // never carry it, otherwise chat text could slip through as a detail.
      expect(isDiagnosticEventMessage({
        type: 'diagnostic_event',
        payload: { id: 'd1', stage: 'queue_overflow_drop', timestamp: 1000, detail: 'Private chat text' },
      })).toBe(false)
    })

    it('rejects counter events with a negative or fractional count', () => {
      expect(isDiagnosticEventMessage({
        type: 'diagnostic_event',
        payload: { id: 'd1', stage: 'batch_dedup_removed', timestamp: 1000, count: -1 },
      })).toBe(false)
      expect(isDiagnosticEventMessage({
        type: 'diagnostic_event',
        payload: { id: 'd1', stage: 'in_flight_coalesced', timestamp: 1000, count: 1.5 },
      })).toBe(false)
    })

    it('rejects count on non-counter stages and unknown stages', () => {
      expect(isDiagnosticEventMessage({
        type: 'diagnostic_event',
        payload: { id: 'd1', stage: 'message_detected', timestamp: 1000, count: 3 },
      })).toBe(false)
      expect(isDiagnosticEventMessage({
        type: 'diagnostic_event',
        payload: { id: 'd1', stage: 'not_a_stage', timestamp: 1000 },
      })).toBe(false)
    })
  })

  it('narrows translate_request messages to serializable text payloads', () => {
    const message = {
      type: 'translate_request',
      payload: { messageId: 'm1', text: 'Hello', sourceLang: 'en' },
    }

    expect(isTranslationRequestMessage(message)).toBe(true)
  })

  it('rejects translate_request payloads without string ids or text', () => {
    expect(isTranslationRequestMessage({ type: 'translate_request', payload: { messageId: 'm1' } })).toBe(false)
    expect(isTranslationRequestMessage({ type: 'translate_request', payload: { messageId: 1, text: 'Hello' } })).toBe(false)
  })

  it('serializes messages without changing the payload contract', () => {
    const message: BaseMessage<'translate_request', TranslationRequest> = {
      type: 'translate_request',
      payload: { messageId: 'm1', text: 'Hello' },
    }

    expect(serializeMessage(message)).toBe('{"type":"translate_request","payload":{"messageId":"m1","text":"Hello"}}')
  })

  it('narrows content settings requests with an optional channel name', () => {
    expect(isContentSettingsRequestMessage({
      type: 'get_content_settings',
      payload: { channelName: 'somechannel' },
    })).toBe(true)
    expect(isContentSettingsRequestMessage({
      type: 'get_content_settings',
      payload: {},
    })).toBe(true)
    expect(isContentSettingsRequestMessage({
      type: 'get_content_settings',
      payload: { channelName: 123 },
    })).toBe(false)
  })

  describe('error_notification messages', () => {
    it('accepts a valid error_notification message', () => {
      const msg = {
        type: 'error_notification',
        payload: { id: 'e1', type: 'auth', message: 'Invalid API Key', timestamp: 1000 },
      }
      expect(isBaseMessage(msg)).toBe(true)
    })

    it('narrows valid error_notification payload', () => {
      const msg = {
        type: 'error_notification' as const,
        payload: { id: 'e1', type: 'auth', message: 'Invalid API Key', timestamp: 1000 },
      }
      expect(isErrorNotificationMessage(msg)).toBe(true)
    })

    it('rejects error_notification with non-object payload', () => {
      const msg = { type: 'error_notification', payload: 'invalid' }
      expect(isErrorNotificationMessage(msg)).toBe(false)
    })

    it('rejects error_notification with missing required fields', () => {
      const msg = { type: 'error_notification', payload: { id: 'e1' } }
      expect(isErrorNotificationMessage(msg)).toBe(false)
    })

    it('serializes an error_notification message', () => {
      const notification: ErrorNotification = {
        id: 'e1', type: 'auth', message: 'Invalid API Key', timestamp: 1000,
      }
      const msg: BaseMessage<'error_notification', ErrorNotification> = {
        type: 'error_notification',
        payload: notification,
      }
      const serialized = serializeMessage(msg)
      const parsed = JSON.parse(serialized)
      expect(parsed.type).toBe('error_notification')
      expect(parsed.payload.id).toBe('e1')
      expect(parsed.payload.type).toBe('auth')
    })
  })

  it('types a settings_updated payload with the Chinese variant mode', () => {
    const payload: SettingsUpdatePayload = {
      translationEnabled: true,
      targetLanguage: 'zh-TW',
      chineseVariantMode: 'translate_other_script',
    }

    expect(isSettingsUpdateMessage({ type: 'settings_updated', payload })).toBe(true)
    expect(payload.chineseVariantMode).toBe('translate_other_script')
  })
})

describe('speech_settings_updated message', () => {
  it('accepts a full speech settings payload', () => {
    const payload: SpeechSettingsUpdatePayload = {
      speechEnabled: true,
      speechProvider: 'gemini',
      speechModel: 'gemini-2.5-flash',
      speechTargetLanguage: 'en',
      captionMaxLines: 3,
      captionOpacity: 80,
      maxSessionMinutes: 45,
    }

    expect(isSpeechSettingsUpdateMessage({ type: 'speech_settings_updated', payload })).toBe(true)
  })

  it('accepts a partial payload', () => {
    expect(isSpeechSettingsUpdateMessage({
      type: 'speech_settings_updated',
      payload: { speechEnabled: false },
    })).toBe(true)
    expect(isSpeechSettingsUpdateMessage({
      type: 'speech_settings_updated',
      payload: { captionMaxLines: 2 },
    })).toBe(true)
    expect(isSpeechSettingsUpdateMessage({
      type: 'speech_settings_updated',
      payload: {},
    })).toBe(true)
  })

  it('rejects an unknown speech provider', () => {
    expect(isSpeechSettingsUpdateMessage({
      type: 'speech_settings_updated',
      payload: { speechProvider: 'deepseek' },
    })).toBe(false)
  })

  it('rejects wrong-typed fields that are present', () => {
    expect(isSpeechSettingsUpdateMessage({
      type: 'speech_settings_updated',
      payload: { speechEnabled: 'yes' },
    })).toBe(false)
    expect(isSpeechSettingsUpdateMessage({
      type: 'speech_settings_updated',
      payload: { captionMaxLines: '3' },
    })).toBe(false)
    expect(isSpeechSettingsUpdateMessage({
      type: 'speech_settings_updated',
      payload: { speechTargetLanguage: 42 },
    })).toBe(false)
  })

  it('rejects a non-object payload and wrong message types', () => {
    expect(isSpeechSettingsUpdateMessage({ type: 'speech_settings_updated' })).toBe(false)
    expect(isSpeechSettingsUpdateMessage({ type: 'speech_settings_updated', payload: 'nope' })).toBe(false)
    expect(isSpeechSettingsUpdateMessage({ type: 'settings_updated', payload: {} })).toBe(false)
  })
})

describe('settings_updated message', () => {
  it('accepts a valid settings_updated message with a partial settings payload', () => {
    const payload: SettingsUpdatePayload = { translationEnabled: false }

    expect(
      isSettingsUpdateMessage({
        type: 'settings_updated',
        payload,
      }),
    ).toBe(true)
  })

  it('rejects settings_updated messages without a valid payload', () => {
    expect(isSettingsUpdateMessage({ type: 'settings_updated' })).toBe(false)
    expect(isSettingsUpdateMessage({ type: 'settings_updated', payload: 'not-an-object' })).toBe(false)
  })

  it('rejects non-settings_updated messages', () => {
    expect(isSettingsUpdateMessage({ type: 'translate_request', payload: {} })).toBe(false)
  })
})

describe('quota_health messages', () => {
  it('accepts a healthy quota-health result and preserves the fields', () => {
    const result: QuotaHealthResult = {
      quotaKey: 'gemini-2.5-flash',
      status: 'healthy',
      providerDay: '2026-07-13',
      snapshotVersion: 3,
      snapshotStatus: 'complete',
    }

    expect(isQuotaHealthResult(result)).toBe(true)
    const serialized = serializeMessage({ type: 'quota_health_result', payload: [result] } as const)
    const parsed = JSON.parse(serialized)
    expect(isQuotaHealthResultMessage(parsed)).toBe(true)
    expect(parsed.payload[0]).toEqual(result)
  })

  it('accepts a cooldown result with denialReason and cooldownUntil', () => {
    const result = {
      quotaKey: 'gemini-2.5-flash',
      status: 'cooldown',
      denialReason: 'cooldown',
      providerDay: '2026-07-13',
      snapshotVersion: 3,
      snapshotStatus: 'complete',
      cooldownUntil: 1_234_567_890,
    }

    expect(isQuotaHealthResult(result)).toBe(true)
  })

  it('accepts a clock-rollback result with recoveryAt', () => {
    const result = {
      quotaKey: 'default',
      status: 'clock_rollback',
      denialReason: 'clock_rollback',
      providerDay: '2026-07-13',
      snapshotVersion: 3,
      snapshotStatus: 'complete',
      recoveryAt: 1_234_567_890,
    }

    expect(isQuotaHealthResult(result)).toBe(true)
  })

  it('accepts the integrity statuses and rejects unknown statuses', () => {
    for (const status of ['untrusted_migration', 'malformed_snapshot', 'unsupported_version']) {
      expect(isQuotaHealthResult({
        quotaKey: 'default',
        status,
        snapshotVersion: 3,
        snapshotStatus: status === 'unsupported_version' ? 'unsupported_version' : 'complete',
      })).toBe(true)
    }

    expect(isQuotaHealthResult({
      quotaKey: 'default',
      status: 'not_a_status',
      snapshotVersion: 3,
      snapshotStatus: 'complete',
    })).toBe(false)
  })

  it('rejects quota-health results with unknown denial reasons or malformed snapshot statuses', () => {
    expect(isQuotaHealthResult({
      quotaKey: 'default',
      status: 'cooldown',
      denialReason: 'banana',
      snapshotVersion: 3,
      snapshotStatus: 'complete',
    })).toBe(false)

    expect(isQuotaHealthResult({
      quotaKey: 'default',
      status: 'healthy',
      snapshotVersion: 3,
      snapshotStatus: 'banana',
    })).toBe(false)
  })

  it('rejects quota-health results with non-numeric recovery or cooldown timestamps', () => {
    expect(isQuotaHealthResult({
      quotaKey: 'default',
      status: 'clock_rollback',
      snapshotVersion: 3,
      snapshotStatus: 'complete',
      recoveryAt: 'banana',
    })).toBe(false)

    expect(isQuotaHealthResult({
      quotaKey: 'default',
      status: 'cooldown',
      snapshotVersion: 3,
      snapshotStatus: 'complete',
      cooldownUntil: Number.NaN,
    })).toBe(false)
  })

  it('narrows get_quota_health requests with and without a quotaKey', () => {
    expect(isGetQuotaHealthMessage({ type: 'get_quota_health', payload: {} })).toBe(true)
    expect(isGetQuotaHealthMessage({
      type: 'get_quota_health',
      payload: { quotaKey: 'gemini-2.5-flash' },
    })).toBe(true)
    expect(isGetQuotaHealthMessage({ type: 'get_quota_health', payload: { quotaKey: 123 } })).toBe(false)
    expect(isGetQuotaHealthMessage({ type: 'get_diagnostics', payload: {} })).toBe(false)
  })

  it('serializes a full quota_health_result through the message boundary', () => {
    const result: QuotaHealthResult = {
      quotaKey: 'gemini-2.5-flash',
      status: 'clock_rollback',
      denialReason: 'clock_rollback',
      providerDay: '2026-07-13',
      snapshotVersion: 3,
      snapshotStatus: 'complete',
      recoveryAt: 1_234_567_890,
    }
    const msg: BaseMessage<'quota_health_result', QuotaHealthResult[]> = {
      type: 'quota_health_result',
      payload: [result],
    }
    const serialized = serializeMessage(msg)
    const parsed: unknown = JSON.parse(serialized)
    if (!isQuotaHealthResultMessage(parsed)) {
      throw new Error('Expected a valid quota_health_result message')
    }
    expect(parsed.payload).toHaveLength(1)
    expect(parsed.payload[0]!.status).toBe('clock_rollback')
    expect(JSON.stringify(parsed)).not.toContain('secret')
  })

  it('narrows reset_quota_health requests with and without a quotaKey', () => {
    expect(isResetQuotaHealthMessage({ type: 'reset_quota_health', payload: {} })).toBe(true)
    expect(isResetQuotaHealthMessage({
      type: 'reset_quota_health',
      payload: { quotaKey: 'gemini-2.5-flash' },
    })).toBe(true)
    expect(isResetQuotaHealthMessage({ type: 'reset_quota_health', payload: { quotaKey: 123 } })).toBe(false)
    expect(isResetQuotaHealthMessage({ type: 'get_quota_health', payload: {} })).toBe(false)
  })

  it('accepts a successful quota-health reset result and preserves the fields', () => {
    const result = { ok: true, resetKeys: ['gemini-2.5-flash'] }
    expect(isQuotaHealthResetResultMessage({
      type: 'quota_health_reset_result',
      payload: result,
    })).toBe(true)
    expect(isQuotaHealthResetResultMessage({
      type: 'quota_health_reset_result',
      payload: { ok: false, resetKeys: [], error: 'reset failed' },
    })).toBe(true)
  })

  it('rejects malformed quota-health reset results', () => {
    expect(isQuotaHealthResetResultMessage({
      type: 'quota_health_reset_result',
      payload: { ok: 'yes', resetKeys: [] },
    })).toBe(false)
    expect(isQuotaHealthResetResultMessage({
      type: 'quota_health_reset_result',
      payload: { ok: true, resetKeys: 'default' },
    })).toBe(false)
    expect(isQuotaHealthResetResultMessage({
      type: 'quota_health_reset_result',
      payload: { ok: true, resetKeys: [123] },
    })).toBe(false)
  })
})

describe('speech pipeline messages (Spec §6)', () => {
  describe('speech_control (CS → SW)', () => {
    it('accepts start/stop/toggle with an optional channel name', () => {
      expect(isSpeechControlMessage({ type: 'speech_control', payload: { action: 'start' } })).toBe(true)
      expect(isSpeechControlMessage({ type: 'speech_control', payload: { action: 'stop' } })).toBe(true)
      expect(isSpeechControlMessage({ type: 'speech_control', payload: { action: 'toggle' } })).toBe(true)
      expect(isSpeechControlMessage({ type: 'speech_control', payload: { action: 'start', channelName: 'somechannel' } })).toBe(true)
    })

    it('rejects unknown actions, wrong-typed channel names, and non-object payloads', () => {
      expect(isSpeechControlMessage({ type: 'speech_control', payload: { action: 'banana' } })).toBe(false)
      expect(isSpeechControlMessage({ type: 'speech_control', payload: { action: 'start', channelName: 42 } })).toBe(false)
      expect(isSpeechControlMessage({ type: 'speech_control', payload: 'start' })).toBe(false)
      expect(isSpeechControlMessage({ type: 'speech_control' })).toBe(false)
      expect(isSpeechControlMessage({ type: 'settings_updated', payload: { action: 'start' } })).toBe(false)
    })
  })

  describe('speech_state (SW → CS)', () => {
    it('accepts every valid state and reason', () => {
      for (const state of ['idle', 'consent_pending', 'capturing', 'transcribing', 'paused', 'error']) {
        expect(isSpeechStateMessage({ type: 'speech_state', payload: { state } })).toBe(true)
      }
      for (const reason of ['auth', 'rate_limited', 'quota_exceeded', 'network', 'no_twitch_tab', 'permission_denied', 'context_invalidated', 'budget_exhausted', 'unknown']) {
        expect(isSpeechStateMessage({ type: 'speech_state', payload: { state: 'error', reason, errorKey: 'speechErrorAuth' } })).toBe(true)
      }
    })

    it('accepts a paused state with a reason and no errorKey', () => {
      expect(isSpeechStateMessage({ type: 'speech_state', payload: { state: 'paused', reason: 'rate_limited' } })).toBe(true)
    })

    it('rejects unknown states, unknown reasons, and wrong-typed errorKey', () => {
      expect(isSpeechStateMessage({ type: 'speech_state', payload: { state: 'banana' } })).toBe(false)
      expect(isSpeechStateMessage({ type: 'speech_state', payload: { state: 'error', reason: 'banana' } })).toBe(false)
      expect(isSpeechStateMessage({ type: 'speech_state', payload: { state: 'error', errorKey: 42 } })).toBe(false)
      expect(isSpeechStateMessage({ type: 'speech_state', payload: 'error' })).toBe(false)
    })

    it('privacy: a speech_state payload never carries keys, raw audio, transcript, or channel names', () => {
      const payload = { state: 'error', reason: 'auth', errorKey: 'speechErrorAuth' }
      const serialized = JSON.stringify({ type: 'speech_state', payload })
      expect(serialized).not.toMatch(/sk-[a-z0-9_-]+/)
      expect(serialized).not.toMatch(/ArrayBuffer|audio|channelName|transcript/i)
    })
  })

  describe('speech_caption (SW → CS)', () => {
    it('accepts an interim caption (untranslated) and a final caption (translated)', () => {
      expect(isSpeechCaptionMessage({ type: 'speech_caption', payload: { id: 'c1', text: '你好世界', interim: true, lang: 'zh' } })).toBe(true)
      expect(isSpeechCaptionMessage({ type: 'speech_caption', payload: { id: 'c2', text: 'Hello world', interim: false } })).toBe(true)
    })

    it('rejects missing id/text, wrong-typed interim, and non-object payloads', () => {
      expect(isSpeechCaptionMessage({ type: 'speech_caption', payload: { text: 'hi', interim: true } })).toBe(false)
      expect(isSpeechCaptionMessage({ type: 'speech_caption', payload: { id: 'c1', interim: true } })).toBe(false)
      expect(isSpeechCaptionMessage({ type: 'speech_caption', payload: { id: 'c1', text: 'hi', interim: 'yes' } })).toBe(false)
      expect(isSpeechCaptionMessage({ type: 'speech_caption', payload: { id: 'c1', text: 'hi', interim: true, lang: 42 } })).toBe(false)
      expect(isSpeechCaptionMessage({ type: 'speech_caption', payload: 'caption' })).toBe(false)
    })
  })

  describe('speech_caption_cleared (SW → CS)', () => {
    it('accepts idle/silence/disabled', () => {
      for (const reason of ['idle', 'silence', 'disabled']) {
        expect(isSpeechCaptionClearedMessage({ type: 'speech_caption_cleared', payload: { reason } })).toBe(true)
      }
    })
    it('rejects unknown reasons and non-object payloads', () => {
      expect(isSpeechCaptionClearedMessage({ type: 'speech_caption_cleared', payload: { reason: 'banana' } })).toBe(false)
      expect(isSpeechCaptionClearedMessage({ type: 'speech_caption_cleared', payload: 'idle' })).toBe(false)
    })
  })

  describe('speech diagnostic counters (#160)', () => {
    it('accepts count-only events for the speech counter stages', () => {
      for (const stage of ['speech_started', 'speech_stopped', 'speech_caption_emitted', 'speech_chunk_sent', 'speech_error']) {
        expect(isDiagnosticEventMessage({
          type: 'diagnostic_event',
          payload: { id: 's1', stage, timestamp: 1000, count: 2 },
        })).toBe(true)
      }
    })

    it('rejects speech counter events carrying a detail string or a count on non-count stages', () => {
      expect(isDiagnosticEventMessage({
        type: 'diagnostic_event',
        payload: { id: 's1', stage: 'speech_caption_emitted', timestamp: 1000, detail: 'secret transcript' },
      })).toBe(false)
      expect(isDiagnosticEventMessage({
        type: 'diagnostic_event',
        payload: { id: 's1', stage: 'chat_container_ready', timestamp: 1000, count: 1 },
      })).toBe(false)
    })

    it('privacy: speech counters carry only stage/count/id/timestamp, never transcript text', () => {
      const serialized = JSON.stringify({
        type: 'diagnostic_event',
        payload: { id: 's1', stage: 'speech_caption_emitted', timestamp: 1000, count: 5 },
      })
      expect(serialized).not.toMatch(/secret|你好|channel|audio|sk-[a-z0-9_-]+/i)
    })
  })
})
