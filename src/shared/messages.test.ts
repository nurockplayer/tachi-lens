import { describe, expect, it } from 'vitest'
import {
  isBaseMessage,
  isSettingsUpdateMessage,
  isTranslationRequestMessage,
  serializeMessage,
  type BaseMessage,
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
