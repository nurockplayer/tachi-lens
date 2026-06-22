// Shared message type definitions for SW ↔ CS ↔ Popup communication

export type MessageType =
  | 'translate_request'
  | 'translate_response'
  | 'validate_key'
  | 'key_validation_result'
  | 'provider_status'
  | 'error_notification'

export interface TranslationRequest {
  messageId: string
  text: string
  sourceLang?: string
}

export interface TranslationResult {
  messageId: string
  translatedText?: string
  error?: ProviderError
}

export type ProviderError =
  | { type: 'auth'; status: 401; message: string }
  | { type: 'rate_limited'; retryAfterMs: number; message: string }
  | { type: 'network'; message: string }
  | { type: 'invalid_response'; message: string }
  | { type: 'timeout'; message: string }
  | { type: 'unknown'; message: string }

export interface BaseMessage<T extends MessageType, P = unknown> {
  type: T
  payload: P
}
