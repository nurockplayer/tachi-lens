import { describe, expect, it } from 'vitest'
import {
  isBaseMessage,
  isErrorNotificationMessage,
  isTranslationRequestMessage,
  serializeMessage,
  type BaseMessage,
  type ErrorNotification,
  type TranslationRequest,
} from './messages'

describe('message protocol guards', () => {
  it('accepts a base message with a known type and object payload', () => {
    expect(isBaseMessage({ type: 'translate_request', payload: { messageId: 'm1', text: 'Hello' } })).toBe(true)
  })

  it('rejects unknown message types and missing payloads', () => {
    expect(isBaseMessage({ type: 'unknown', payload: {} })).toBe(false)
    expect(isBaseMessage({ type: 'translate_request' })).toBe(false)
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
