// Shared message type definitions for SW ↔ CS ↔ Popup communication

export type MessageType =
  | 'translate_request'
  | 'translate_response'
  | 'validate_key'
  | 'key_validation_result'
  | 'provider_status'
  | 'error_notification'
  | 'settings_updated'

export const MESSAGE_TYPES: readonly MessageType[] = [
  'translate_request',
  'translate_response',
  'validate_key',
  'key_validation_result',
  'provider_status',
  'error_notification',
  'settings_updated',
]

/** Payload for settings_updated: partial settings sent from SW to content scripts. */
export type SettingsUpdatePayload = Partial<{
  translationEnabled: boolean
  displayMode: 'below' | 'hover' | 'collapse'
}>

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

/** Error types covering both API failures and user-actionable states. */
export type ProviderError =
  | { type: 'auth'; status: 401; message: string }
  | { type: 'rate_limited'; retryAfterMs: number; message: string }
  | { type: 'quota_exceeded'; message: string }
  | { type: 'bad_request'; status: number; message: string }
  | { type: 'unsupported_model'; message: string }
  | { type: 'network'; message: string }
  | { type: 'invalid_response'; message: string }
  | { type: 'timeout'; message: string }
  | { type: 'unknown'; message: string }

export interface BaseMessage<T extends MessageType, P = unknown> {
  type: T
  payload: P
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isMessageType = (value: unknown): value is MessageType =>
  typeof value === 'string' && MESSAGE_TYPES.includes(value as MessageType)

export const isBaseMessage = (value: unknown): value is BaseMessage<MessageType, unknown> =>
  isRecord(value) && isMessageType(value.type) && Object.hasOwn(value, 'payload')

export const isTranslationRequestMessage = (
  value: unknown,
): value is BaseMessage<'translate_request', TranslationRequest> => {
  if (!isBaseMessage(value) || value.type !== 'translate_request' || !isRecord(value.payload)) {
    return false
  }

  return (
    typeof value.payload.messageId === 'string' &&
    typeof value.payload.text === 'string' &&
    (value.payload.sourceLang === undefined || typeof value.payload.sourceLang === 'string')
  )
}

export interface ErrorNotification {
  id: string
  type: string
  message: string
  timestamp: number
}

export const isErrorNotificationMessage = (
  value: unknown,
): value is BaseMessage<'error_notification', ErrorNotification> => {
  if (!isBaseMessage(value) || value.type !== 'error_notification' || !isRecord(value.payload)) {
    return false
  }

  const p = value.payload as Record<string, unknown>

  return (
    typeof p.id === 'string' &&
    typeof p.type === 'string' &&
    typeof p.message === 'string' &&
    typeof p.timestamp === 'number'
  )
}

export const isSettingsUpdateMessage = (
  value: unknown,
): value is BaseMessage<'settings_updated', SettingsUpdatePayload> => {
  if (!isBaseMessage(value) || value.type !== 'settings_updated') {
    return false
  }

  return typeof value.payload === 'object' && value.payload !== null && !Array.isArray(value.payload)
}

export const serializeMessage = <T extends MessageType, P>(message: BaseMessage<T, P>): string => JSON.stringify(message)
