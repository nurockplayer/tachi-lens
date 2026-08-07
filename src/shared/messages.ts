// Shared message type definitions for SW ↔ CS ↔ Popup communication

import type { ChineseVariantMode } from './language-detection'

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
  | 'get_quota_health'
  | 'quota_health_result'
  | 'reset_quota_health'
  | 'quota_health_reset_result'

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
  'get_quota_health',
  'quota_health_result',
  'reset_quota_health',
  'quota_health_reset_result',
]

/** Payload for settings_updated: settings broadcast from Popup/SW to content scripts. */
export type SettingsUpdatePayload = Partial<{
  translationEnabled: boolean
  displayMode: 'below' | 'hover' | 'collapse'
  targetLanguage: string
  chineseVariantMode: ChineseVariantMode
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
  // Privacy-safe aggregate counters (#60): deduplication and queue-backpressure
  // drops. These stages carry only a `count` — never chat text, usernames,
  // channel names, provider request/response bodies, or translation output.
  | 'batch_dedup_removed'
  | 'in_flight_coalesced'
  | 'queue_overflow_drop'
  | 'queue_obsolete_drop'

/** A privacy-safe lifecycle event. It never includes chat text, usernames, or API keys. */
export interface DiagnosticEvent {
  id: string
  stage: DiagnosticStage
  timestamp: number
  detail?: string
  /**
   * Aggregate count for counter-style stages (batch_dedup_removed,
   * in_flight_coalesced, queue_overflow_drop, queue_obsolete_drop). Carries the
   * number of drops accumulated between reports; never message content.
   */
  count?: number
}

export interface DiagnosticsSnapshot {
  events: DiagnosticEvent[]
}

/**
 * Structured, privacy-safe view of persisted Gemini quota state. One result is
 * produced per quotaKey/model. Payloads never include API keys, request or
 * response bodies, translation text, usernames, or channel names.
 */
export type QuotaHealthStatus =
  | 'healthy'
  | 'cooldown'
  | 'clock_rollback'
  | 'untrusted_migration'
  | 'malformed_snapshot'
  | 'unsupported_version'

export type QuotaHealthDenialReason = 'rpm' | 'tpm' | 'rpd' | 'cooldown' | 'clock_rollback'

export type QuotaSnapshotStatus =
  | 'complete'
  | 'malformed'
  | 'unsupported_version'
  | 'untrusted_migration'
  | 'missing'

export interface QuotaHealthResult {
  /** Canonical quotaKey/model name (never a username or channel). */
  quotaKey: string
  status: QuotaHealthStatus
  /**
   * Present only when the status is 'cooldown' or 'clock_rollback'. When
   * omitted, the denial reason is not attributable to a single quota check.
   */
  denialReason?: QuotaHealthDenialReason
  /** Provider day id (yyyy-mm-dd, America/Los_Angeles) when trustworthy. */
  providerDay?: string
  snapshotVersion: number | null
  snapshotStatus: QuotaSnapshotStatus
  /** Rollback clock is unsafe until this wall-clock instant (ms epoch). */
  recoveryAt?: number
  /** Cooldown expires at this wall-clock instant (ms epoch). */
  cooldownUntil?: number
}

export const QUOTA_HEALTH_STATUSES: readonly QuotaHealthStatus[] = [
  'healthy',
  'cooldown',
  'clock_rollback',
  'untrusted_migration',
  'malformed_snapshot',
  'unsupported_version',
]

const QUOTA_HEALTH_DENIAL_REASONS: readonly QuotaHealthDenialReason[] = [
  'rpm',
  'tpm',
  'rpd',
  'cooldown',
  'clock_rollback',
]

const QUOTA_SNAPSHOT_STATUSES: readonly QuotaSnapshotStatus[] = [
  'complete',
  'malformed',
  'unsupported_version',
  'untrusted_migration',
  'missing',
]

const isOptionalNumber = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value))

export const isQuotaHealthResult = (value: unknown): value is QuotaHealthResult => {
  if (!isRecord(value)) return false

  const payload = value as Record<string, unknown>
  return (
    typeof payload.quotaKey === 'string' &&
    typeof payload.status === 'string' &&
    QUOTA_HEALTH_STATUSES.includes(payload.status as QuotaHealthStatus) &&
    (payload.denialReason === undefined ||
      typeof payload.denialReason === 'string' &&
      QUOTA_HEALTH_DENIAL_REASONS.includes(payload.denialReason as QuotaHealthDenialReason)) &&
    (payload.providerDay === undefined || typeof payload.providerDay === 'string') &&
    (payload.snapshotVersion === null || typeof payload.snapshotVersion === 'number') &&
    typeof payload.snapshotStatus === 'string' &&
    QUOTA_SNAPSHOT_STATUSES.includes(payload.snapshotStatus as QuotaSnapshotStatus) &&
    isOptionalNumber(payload.recoveryAt) &&
    isOptionalNumber(payload.cooldownUntil)
  )
}

export const isQuotaHealthResultMessage = (
  value: unknown,
): value is BaseMessage<'quota_health_result', QuotaHealthResult[]> => {
  if (!isBaseMessage(value) || value.type !== 'quota_health_result' || !Array.isArray(value.payload)) {
    return false
  }
  return value.payload.every(isQuotaHealthResult)
}

export const isGetQuotaHealthMessage = (
  value: unknown,
): value is BaseMessage<'get_quota_health', QuotaHealthRequest> => {
  if (!isBaseMessage(value) || value.type !== 'get_quota_health') {
    return false
  }
  if (value.payload === undefined) {
    return true
  }
  if (!isRecord(value.payload)) {
    return false
  }
  return value.payload.quotaKey === undefined || typeof value.payload.quotaKey === 'string'
}

export interface QuotaHealthRequest {
  quotaKey?: string
}

/**
 * Explicit repair request for persisted Gemini quota accounting state. Only the
 * quota accounting snapshot is affected; API keys, settings, cache, and
 * channel settings are stored under different keys and are never touched.
 */
export interface QuotaHealthResetRequest {
  quotaKey?: string
}

export interface QuotaHealthResetResult {
  ok: boolean
  /** Quota accounting entries that were reset (informational). */
  resetKeys: string[]
  error?: string
}

export const isResetQuotaHealthMessage = (
  value: unknown,
): value is BaseMessage<'reset_quota_health', QuotaHealthResetRequest> => {
  if (!isBaseMessage(value) || value.type !== 'reset_quota_health') {
    return false
  }
  if (value.payload === undefined) {
    return true
  }
  if (!isRecord(value.payload)) {
    return false
  }
  return value.payload.quotaKey === undefined || typeof value.payload.quotaKey === 'string'
}

export const isQuotaHealthResetResultMessage = (
  value: unknown,
): value is BaseMessage<'quota_health_reset_result', QuotaHealthResetResult> => {
  if (!isBaseMessage(value) || value.type !== 'quota_health_reset_result' || !isRecord(value.payload)) {
    return false
  }
  const payload = value.payload as Record<string, unknown>
  return (
    typeof payload.ok === 'boolean' &&
    Array.isArray(payload.resetKeys) &&
    payload.resetKeys.every((key) => typeof key === 'string') &&
    (payload.error === undefined || typeof payload.error === 'string')
  )
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
  'batch_dedup_removed',
  'in_flight_coalesced',
  'queue_overflow_drop',
  'queue_obsolete_drop',
]

const DIAGNOSTIC_COUNT_STAGES: readonly DiagnosticStage[] = [
  'batch_dedup_removed',
  'in_flight_coalesced',
  'queue_overflow_drop',
  'queue_obsolete_drop',
]

const isOptionalCount = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0)

export interface ContentSettingsRequest {
  channelName?: string
}

/** Error types covering both API failures and user-actionable states. */
export type ProviderError =
  | { type: 'auth'; status: number; message: string }
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
    (payload.detail === undefined || typeof payload.detail === 'string') &&
    // `count` is only valid on counter-style stages and must be a bounded
    // non-negative integer when present. Counter stages may never carry a
    // `detail` — that channel is reserved for message-bearing content, so
    // rejecting it at the protocol boundary is a privacy defense.
    (DIAGNOSTIC_COUNT_STAGES.includes(payload.stage as DiagnosticStage)
      ? payload.detail === undefined && isOptionalCount(payload.count)
      : payload.count === undefined)
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
