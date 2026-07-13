import { describe, expect, it } from 'vitest'
import {
  isBaseMessage,
  isContentSettingsRequestMessage,
  isErrorNotificationMessage,
  isSettingsUpdateMessage,
  isTranslationRequestMessage,
  serializeMessage,
  type BaseMessage,
  type ErrorNotification,
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
