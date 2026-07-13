// Shared message type definitions for SW ↔ CS ↔ Popup communication

export type MessageType =
  | 'translate_request'
  | 'translate_response'
  | 'get_content_settings'
  | 'content_settings'
  | 'validate_key'
  | 'key_validation_result'
  | 'provider_status'
  | 'error_notification'
  | 'settings_updated'
  | 'save_api_key'
  | 'save_api_key_result'
  | 'delete_api_key'
  | 'delete_api_key_result'
  | 'get_api_key_preview'
  | 'api_key_preview'
  | 'diagnostic_event'
  | 'get_diagnostics'
  | 'diagnostics_snapshot'

export const MESSAGE_TYPES: readonly MessageType[] = [
  'translate_request',
  'translate_response',
  'get_content_settings',
  'content_settings',
  'validate_key',
  'key_validation_result',
  'provider_status',
  'error_notification',
  'settings_updated',
  'save_api_key',
  'save_api_key_result',
  'delete_api_key',
  'delete_api_key_result',
  'get_api_key_preview',
  'api_key_preview',
  'diagnostic_event',
  'get_diagnostics',
  'diagnostics_snapshot',
]

/** Payload for settings_updated: settings broadcast from Popup/SW to content scripts. */
export type SettingsUpdatePayload = Partial<{
  translationEnabled: boolean
  displayMode: 'below' | 'hover' | 'collapse'
  targetLanguage: string
  minTextLength: number
  botNameBlacklist: string[]
  skipEmotesOnly: boolean
  skipCheermotes: boolean
  skipSlashMe: boolean
  skipWhispers: boolean
  skipReplies: boolean
  skipLinksOnly: boolean
  skipNumbersOnly: boolean
  skipSystemMessages: boolean
}>

export interface TranslationRequest {
  messageId: string
  text: string
  sourceLang?: string
  priority?: 'live' | 'backlog'
}

export interface TranslationResult {
  messageId: string
  translatedText?: string
  error?: ProviderError
}

export type DiagnosticStage =
  | 'chat_container_ready'
  | 'chat_container_missing'
  | 'message_detected'
  | 'message_not_ready'
  | 'message_skipped'
  | 'translation_requested'
  | 'translation_received'
  | 'translation_failed'
  | 'translation_injected'

/** A privacy-safe lifecycle event. It never includes chat text, usernames, or API keys. */
export interface DiagnosticEvent {
  id: string
  stage: DiagnosticStage
  timestamp: number
  detail?: string
}

export interface DiagnosticsSnapshot {
  events: DiagnosticEvent[]
}

const DIAGNOSTIC_STAGES: readonly DiagnosticStage[] = [
  'chat_container_ready',
  'chat_container_missing',
  'message_detected',
  'message_not_ready',
  'message_skipped',
  'translation_requested',
  'translation_received',
  'translation_failed',
  'translation_injected',
]

export interface ContentSettingsRequest {
  channelName?: string
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
    (value.payload.sourceLang === undefined || typeof value.payload.sourceLang === 'string') &&
    (value.payload.priority === undefined || value.payload.priority === 'live' || value.payload.priority === 'backlog')
  )
}

export const isContentSettingsRequestMessage = (
  value: unknown,
): value is BaseMessage<'get_content_settings', ContentSettingsRequest> => {
  if (!isBaseMessage(value) || value.type !== 'get_content_settings') {
    return false
  }

  if (value.payload === undefined) {
    return true
  }

  if (!isRecord(value.payload)) {
    return false
  }

  return value.payload.channelName === undefined || typeof value.payload.channelName === 'string'
}

export const isDiagnosticEventMessage = (
  value: unknown,
): value is BaseMessage<'diagnostic_event', DiagnosticEvent> => {
  if (!isBaseMessage(value) || value.type !== 'diagnostic_event' || !isRecord(value.payload)) {
    return false
  }

  const payload = value.payload as Record<string, unknown>
  return (
    typeof payload.id === 'string' &&
    typeof payload.stage === 'string' &&
    DIAGNOSTIC_STAGES.includes(payload.stage as DiagnosticStage) &&
    typeof payload.timestamp === 'number' &&
    (payload.detail === undefined || typeof payload.detail === 'string')
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
