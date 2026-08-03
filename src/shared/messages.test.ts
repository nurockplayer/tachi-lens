import { describe, expect, it } from 'vitest'
import {
  isBaseMessage,
  isContentSettingsRequestMessage,
  isErrorNotificationMessage,
  isGetQuotaHealthMessage,
  isQuotaHealthResult,
  isQuotaHealthResultMessage,
  isSettingsUpdateMessage,
  isTranslationRequestMessage,
  serializeMessage,
  type BaseMessage,
  type ErrorNotification,
  type QuotaHealthResult,
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
})
