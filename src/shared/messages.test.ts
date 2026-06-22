import { describe, expect, it } from 'vitest'
import {
  isBaseMessage,
  isTranslationRequestMessage,
  serializeMessage,
  type BaseMessage,
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
})
