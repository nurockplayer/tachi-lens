import { AUTO_MODEL, BUNDLED_MODEL_POLICY, resolvePolicyModel } from '@/providers/model-policy'
import { isModelPolicySnapshotMessage, type ModelPolicySnapshotPayload } from '@/shared/model-policy-messages'
import { useCallback, useEffect, useRef, useState } from 'react'
import { listProviderMetadata } from '@/providers/registry'
import type { ProviderId } from '@/providers/types'
import { SPEECH_GEMINI_MODELS, SPEECH_PROVIDER_IDS } from '@/providers/speech-types'
import type { SpeechProviderId, SpeechTranslationConfig } from '@/providers/speech-types'
import {
  getChannelSettings,
  getUserSettings,
  mergeSettings,
  saveChannelSettings,
  saveUserSettings,
} from '@/storage/settings'
import type { UserSettings } from '@/storage/settings'
import type { GeminiQuotaSettings } from '@/background/gemini-quota'
import { t } from '@/shared/i18n'
import { normalizeLocale } from '@/shared/language-detection'
import type { ChineseVariantMode } from '@/shared/language-detection'
import { isDiagnosticEventMessage, isQuotaHealthResetResultMessage, isQuotaHealthResultMessage, isSpeechStateMessage } from '@/shared/messages'
import type {
  DiagnosticEvent,
  DiagnosticStage,
  ErrorNotification,
  QuotaHealthDenialReason,
  QuotaHealthResult,
  QuotaHealthStatus,
  SettingsUpdatePayload,
  SpeechSettingsUpdatePayload,
  SpeechStatePayload,
} from '@/shared/messages'
import type { SpeechPipelineState } from '@/shared/speech-state'
import type { FilterConfig } from '@/content/message-filter'
import {
  Accordion,
  Button,
  Card,
  CloseIcon,
  EmptyState,
  IconButton,
  InlineNotice,
  NumberField,
  SectionHeader,
  SecretInput,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TextInput,
  ToggleRow,
} from './primitives'
import type { Tone } from './primitives'
import './tokens.css'
import './popup.css'

const SPEECH_LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'zh-CN', label: '簡體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'th', label: 'ภาษาไทย' },
]

/** Chat target-language options shared by the quick-control select and the header status summary. */
const TARGET_LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'zh-CN', label: '簡體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'th', label: 'ภาษาไทย' },
]

const getTargetLanguageLabel = (value: string): string =>
  TARGET_LANGUAGE_OPTIONS.find((option) => option.value === value)?.label ?? value

const FILTER_TOGGLES: { key: keyof FilterConfig; labelKey: Parameters<typeof t>[0] }[] = [
  { key: 'skipEmotesOnly', labelKey: 'skipEmotesOnly' },
  { key: 'skipCheermotes', labelKey: 'skipCheermotes' },
  { key: 'skipSlashMe', labelKey: 'skipSlashMe' },
  { key: 'skipWhispers', labelKey: 'skipWhispers' },
  { key: 'skipReplies', labelKey: 'skipReplies' },
  { key: 'skipLinksOnly', labelKey: 'skipLinksOnly' },
  { key: 'skipNumbersOnly', labelKey: 'skipNumbersOnly' },
  { key: 'skipSystemMessages', labelKey: 'skipSystemMessages' },
]

const CHINESE_VARIANT_OPTIONS: Array<{
  value: ChineseVariantMode
  labelKey: Parameters<typeof t>[0]
}> = [
  { value: 'skip_all_chinese', labelKey: 'chineseVariantSkipAllChinese' },
  { value: 'translate_other_script', labelKey: 'chineseVariantTranslateOtherScript' },
]

const isChineseTarget = (targetLanguage: string): boolean => normalizeLocale(targetLanguage) === 'zh'

type LiveChatSettingKey = 'translationEnabled' | 'targetLanguage' | 'displayMode'
type LiveSpeechSettingKey = 'speechEnabled' | 'speechTargetLanguage' | 'captionMaxLines' | 'captionOpacity'
type LiveSpeechSettings = Partial<Pick<SpeechTranslationConfig, LiveSpeechSettingKey | 'speechConsentGranted'>>

const GEMINI_QUOTA_FIELDS: Array<{
  key: keyof GeminiQuotaSettings
  labelKey: Parameters<typeof t>[0]
  min: number
  max?: number
}> = [
  { key: 'requestsPerMinute', labelKey: 'geminiQuotaRpm', min: 1 },
  { key: 'inputTokensPerMinute', labelKey: 'geminiQuotaTpm', min: 1 },
  { key: 'requestsPerDay', labelKey: 'geminiQuotaRpd', min: 1 },
  { key: 'rpmSafetyPercent', labelKey: 'geminiQuotaRpmSafety', min: 1, max: 100 },
  { key: 'tpmSafetyPercent', labelKey: 'geminiQuotaTpmSafety', min: 1, max: 100 },
  { key: 'rpdSafetyPercent', labelKey: 'geminiQuotaRpdSafety', min: 1, max: 100 },
  { key: 'liveMaxWaitMs', labelKey: 'geminiQuotaLiveWait', min: 1, max: 60_000 },
  { key: 'maxConcurrency', labelKey: 'geminiQuotaConcurrency', min: 1, max: 10 },
]

/**
 * Read-only presentation metadata for each Gemini quota health status. Only
 * integrity failures expose an explicit, confirmed repair action; healthy and
 * ordinary cooldown states are never presented as requiring repair.
 */
const QUOTA_HEALTH_STATUS_META: Record<QuotaHealthStatus, {
  labelKey: Parameters<typeof t>[0]
  descKey: Parameters<typeof t>[0]
  tone: Tone
}> = {
  healthy: {
    labelKey: 'quotaHealthStatusHealthy',
    descKey: 'quotaHealthDescHealthy',
    tone: 'success',
  },
  cooldown: {
    labelKey: 'quotaHealthStatusCooldown',
    descKey: 'quotaHealthDescCooldown',
    tone: 'warning',
  },
  clock_rollback: {
    labelKey: 'quotaHealthStatusClockRollback',
    descKey: 'quotaHealthDescClockRollback',
    tone: 'danger',
  },
  untrusted_migration: {
    labelKey: 'quotaHealthStatusUntrustedMigration',
    descKey: 'quotaHealthDescUntrustedMigration',
    tone: 'danger',
  },
  malformed_snapshot: {
    labelKey: 'quotaHealthStatusMalformedSnapshot',
    descKey: 'quotaHealthDescMalformedSnapshot',
    tone: 'danger',
  },
  unsupported_version: {
    labelKey: 'quotaHealthStatusUnsupportedVersion',
    descKey: 'quotaHealthDescUnsupportedVersion',
    tone: 'danger',
  },
}

const QUOTA_HEALTH_DENIAL_LABELS: Record<QuotaHealthDenialReason, Parameters<typeof t>[0]> = {
  rpm: 'quotaHealthDenialRpm',
  tpm: 'quotaHealthDenialTpm',
  rpd: 'quotaHealthDenialRpd',
  cooldown: 'quotaHealthDenialCooldown',
  clock_rollback: 'quotaHealthDenialClockRollback',
}

/** Which statuses represent an integrity failure that fail-closes Gemini. */
const INTEGRITY_STATUSES: ReadonlySet<QuotaHealthStatus> = new Set([
  'clock_rollback',
  'untrusted_migration',
  'malformed_snapshot',
  'unsupported_version',
])

/** Integrity statuses that offer an explicit, confirmed repair action. */
const REPAIRABLE_STATUSES: ReadonlySet<QuotaHealthStatus> = INTEGRITY_STATUSES

/** Formats an epoch-ms timestamp into a localized wall-clock string. */
const formatInstant = (epochMs: number): string => new Date(epochMs).toLocaleString()

/** Returns a safe machine-readable timestamp for the accessible `<time>` value. */
const formatTimestampAttribute = (epochMs: number): string => {
  const date = new Date(epochMs)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

export const extractChannelFromUrl = (url: string): string | undefined => {
  try {
    const { hostname, pathname } = new URL(url)

    if (!hostname.endsWith('twitch.tv')) return undefined
    if (hostname !== 'twitch.tv' && hostname !== 'www.twitch.tv') return undefined

    const match = pathname.match(/^\/popout\/([^/]+)(?:\/chat)?(?:\/|$)/i) ??
      pathname.match(/^\/([^/]+)/)

    return match?.[1]?.toLowerCase()
  } catch {
    return undefined
  }
}

type ValidationStatus = 'valid' | 'invalid' | 'checking' | null

const loadSettings = async (): Promise<UserSettings> => {
  return getUserSettings()
}

const readApiKeyPreview = async (providerId: string, scope?: 'speech'): Promise<string | undefined> => {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'get_api_key_preview',
      payload: scope ? { providerId, scope } : { providerId },
    }) as unknown
    if (typeof response !== 'object' || response === null || Array.isArray(response)) return undefined
    const candidate = response as { type?: unknown; payload?: unknown }
    if (candidate.type !== 'api_key_preview' || typeof candidate.payload !== 'object' || candidate.payload === null || Array.isArray(candidate.payload)) return undefined
    const payload = candidate.payload as { preview?: unknown; success?: unknown }
    if (typeof payload.preview !== 'string' || payload.success === false ||
      (payload.success !== undefined && typeof payload.success !== 'boolean')) return undefined

    return payload.preview
  } catch {
    return undefined
  }
}

const loadApiKeyPreview = async (providerId: string, scope?: 'speech'): Promise<string> =>
  await readApiKeyPreview(providerId, scope) ?? ''

interface ErrorNotificationItem {
  id: string
  type: string
  message: string
  timestamp: number
}

const DIAGNOSTIC_LABEL_KEYS: Record<DiagnosticStage, Parameters<typeof t>[0]> = {
  chat_container_ready: 'diagnosticStageChatContainerReady',
  chat_container_missing: 'diagnosticStageChatContainerMissing',
  message_detected: 'diagnosticStageMessageDetected',
  message_not_ready: 'diagnosticStageMessageNotReady',
  message_skipped: 'diagnosticStageMessageSkipped',
  translation_requested: 'diagnosticStageTranslationRequested',
  translation_received: 'diagnosticStageTranslationReceived',
  translation_failed: 'diagnosticStageTranslationFailed',
  translation_injected: 'diagnosticStageTranslationInjected',
  batch_dedup_removed: 'diagnosticStageBatchDedupRemoved',
  in_flight_coalesced: 'diagnosticStageInFlightCoalesced',
  queue_overflow_drop: 'diagnosticStageQueueOverflowDrop',
  queue_obsolete_drop: 'diagnosticStageQueueObsoleteDrop',
  l2_cache_hit: 'diagnosticStageL2CacheHit',
  speech_started: 'diagnosticStageSpeechStarted',
  speech_stopped: 'diagnosticStageSpeechStopped',
  speech_caption_emitted: 'diagnosticStageSpeechCaptionEmitted',
  speech_chunk_sent: 'diagnosticStageSpeechChunkSent',
  speech_error: 'diagnosticStageSpeechError',
}

/** Only exceptional diagnostic stages receive semantic color treatment. */
const DIAGNOSTIC_TONES: Partial<Record<DiagnosticStage, Extract<Tone, 'warning' | 'danger'>>> = {
  chat_container_missing: 'danger',
  translation_failed: 'danger',
  speech_error: 'danger',
  message_not_ready: 'warning',
  queue_overflow_drop: 'warning',
  queue_obsolete_drop: 'warning',
}

/** i18n labels for each speech_state machine value (Spec §6, live-status readout). */
const SPEECH_STATE_LABELS: Record<SpeechPipelineState, Parameters<typeof t>[0]> = {
  idle: 'speechStateIdle',
  consent_pending: 'speechStateIdle',
  capturing: 'speechStateCapturing',
  transcribing: 'speechStateTranscribing',
  paused: 'speechStatePaused',
  error: 'speechErrorUnknown',
}

const isCountStage = (stage: DiagnosticStage): boolean =>
  stage === 'batch_dedup_removed'
  || stage === 'in_flight_coalesced'
  || stage === 'queue_overflow_drop'
  || stage === 'queue_obsolete_drop'
  || stage === 'l2_cache_hit'
  || stage === 'speech_started'
  || stage === 'speech_stopped'
  || stage === 'speech_caption_emitted'
  || stage === 'speech_chunk_sent'
  || stage === 'speech_error'

const mergeDiagnostics = (current: DiagnosticEvent[], incoming: DiagnosticEvent[]): DiagnosticEvent[] => {
  const byId = new Map(current.map((event) => [event.id, event]))
  for (const event of incoming) byId.set(event.id, event)
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 20)
}

export function App() {
  const [modelPolicy, setModelPolicy] = useState<ModelPolicySnapshotPayload>({ manifest: BUNDLED_MODEL_POLICY, source: 'bundled', resolutions: [] })
  const [settings, setSettings] = useState<UserSettings | null>(null)
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({})
  const [apiKeyConfigured, setApiKeyConfigured] = useState<Record<string, boolean>>({})
  const [apiKeyPreviewActive, setApiKeyPreviewActive] = useState<Record<string, boolean>>({})
  const [speechApiKeyInputs, setSpeechApiKeyInputs] = useState<Record<string, string>>({})
  const [speechCredentialConfigured, setSpeechCredentialConfigured] = useState<Record<string, boolean>>({})
  const speechCredentialConfiguredRef = useRef<Record<string, boolean>>({})
  const [speechApiKeyPreviewActive, setSpeechApiKeyPreviewActive] = useState<Record<string, boolean>>({})
  const [speechOverrideEnabled, setSpeechOverrideEnabled] = useState<Record<string, boolean>>({})
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({})
  const [validationStatus, setValidationStatus] = useState<Record<string, ValidationStatus>>({})
  const [speechCredentialMutationFailed, setSpeechCredentialMutationFailed] = useState<Record<string, boolean>>({})
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [blacklistInput, setBlacklistInput] = useState('')
  const [channelName, setChannelName] = useState<string | undefined>(undefined)
  const [useChannelSettings, setUseChannelSettings] = useState(false)
  const [errorNotifications, setErrorNotifications] = useState<ErrorNotificationItem[]>([])
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>([])
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(true)
  const [quotaHealth, setQuotaHealth] = useState<QuotaHealthResult[]>([])
  const [quotaHealthLoading, setQuotaHealthLoading] = useState(true)
  const [quotaRepairErrors, setQuotaRepairErrors] = useState<Record<string, boolean>>({})
  // Consent modal + live speech_state readout (#162). `speechConsentOpen` is a
  // transient UI flag (never persisted); the persisted grant is
  // `speechConfig.speechConsentGranted`. `speechState` mirrors the SW's
  // `speech_state` broadcast so the popup reflects capturing/paused/error live.
  const [speechConsentOpen, setSpeechConsentOpen] = useState(false)
  const [speechState, setSpeechState] = useState<SpeechStatePayload | null>(null)
  const [liveControlError, setLiveControlError] = useState(false)
  const errorListenerRef = useRef<((message: unknown) => void) | null>(null)
  const liveUpdateQueueRef = useRef<Promise<void>>(Promise.resolve())
  const credentialRequestVersionRef = useRef<Record<string, number>>({})
  const credentialAcknowledgedVersionRef = useRef<Record<string, number>>({})
  const credentialEditingRef = useRef<Record<string, boolean>>({})
  const credentialPreviewRef = useRef<Record<string, string>>({})
  const credentialDirtyRef = useRef<Record<string, boolean>>({})
  const credentialDraftGenerationRef = useRef<Record<string, number>>({})
  const credentialCommitPromiseRef = useRef<Record<string, { generation: number; promise: Promise<boolean> }>>({})

  const providers = listProviderMetadata()

  /** Refreshes the quota-health panel from the Service Worker. */
  const refreshQuotaHealth = useCallback(async (): Promise<void> => {
    setQuotaHealthLoading(true)
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'get_quota_health',
        payload: {},
      })) as unknown
      if (isQuotaHealthResultMessage(response)) {
        setQuotaHealth(response.payload)
      }
    } catch {
      // The service worker may be starting. The Popup shows nothing until data arrives.
    } finally {
      setQuotaHealthLoading(false)
    }
  }, [])

  /** Two-step confirmed repair: first click arms, second click executes. */
  const [confirmingReset, setConfirmingReset] = useState<Record<string, boolean>>({})

  const handleResetQuota = useCallback(async (quotaKey: string): Promise<void> => {
    if (!confirmingReset[quotaKey]) {
      setConfirmingReset((previous) => ({ ...previous, [quotaKey]: true }))
      return
    }
    setConfirmingReset((previous) => ({ ...previous, [quotaKey]: false }))
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'reset_quota_health',
        payload: { quotaKey },
      })) as unknown
      if (isQuotaHealthResetResultMessage(response) && response.payload.ok) {
        setQuotaRepairErrors((previous) => {
          const next = { ...previous }
          delete next[quotaKey]
          return next
        })
        await refreshQuotaHealth()
      } else {
        setQuotaRepairErrors((previous) => ({ ...previous, [quotaKey]: true }))
      }
    } catch {
      setQuotaRepairErrors((previous) => ({ ...previous, [quotaKey]: true }))
    }
  }, [confirmingReset, refreshQuotaHealth])

  useEffect(() => {
    let cancelled = false

    const load = async (): Promise<void> => {
      const s = await loadSettings()
      if (cancelled) return
      setSettings(s)
      setBlacklistInput(s.botNameBlacklist.join(', '))
    }
    load()

    const loadDiagnostics = async (): Promise<void> => {
      try {
        const response = (await chrome.runtime.sendMessage({
          type: 'get_diagnostics',
          payload: {},
        })) as { type?: string; payload?: { events?: DiagnosticEvent[] } } | undefined
        if (!cancelled && response?.type === 'diagnostics_snapshot' && Array.isArray(response.payload?.events)) {
          setDiagnostics((prev) => mergeDiagnostics(prev, response.payload!.events!))
        }
      } catch {
        // The service worker may be starting. The Popup still receives live events when available.
      } finally {
        if (!cancelled) setDiagnosticsLoading(false)
      }
    }
    void chrome.runtime.sendMessage({ type: 'get_model_policy', payload: {} }).then((response: unknown) => {
      if (!cancelled && isModelPolicySnapshotMessage(response)) setModelPolicy(response.payload)
    }).catch(() => undefined)
    void loadDiagnostics()
    void refreshQuotaHealth()

    // Load API key previews for all providers
    for (const p of providers) {
      const credentialKey = `chat:${p.id}`
      const previewVersion = credentialRequestVersionRef.current[credentialKey] ?? 0
      const previewDraftGeneration = credentialDraftGenerationRef.current[credentialKey] ?? 0
      loadApiKeyPreview(p.id).then((preview) => {
        if (cancelled || (credentialRequestVersionRef.current[credentialKey] ?? 0) !== previewVersion ||
          (credentialDraftGenerationRef.current[credentialKey] ?? 0) !== previewDraftGeneration) return
        credentialPreviewRef.current[credentialKey] = preview
        if ((credentialRequestVersionRef.current[credentialKey] ?? 0) === 0 && !credentialEditingRef.current[credentialKey]) {
          credentialAcknowledgedVersionRef.current[credentialKey] = 0
          setApiKeyInputs((prev) => ({ ...prev, [p.id]: preview }))
          setApiKeyPreviewActive((prev) => ({ ...prev, [p.id]: Boolean(preview) }))
        }
        setApiKeyConfigured((prev) => ({ ...prev, [p.id]: Boolean(preview) }))
      })
    }

    for (const providerId of SPEECH_PROVIDER_IDS) {
      const credentialKey = `speech:${providerId}`
      const previewVersion = credentialRequestVersionRef.current[credentialKey] ?? 0
      const previewDraftGeneration = credentialDraftGenerationRef.current[credentialKey] ?? 0
      loadApiKeyPreview(providerId, 'speech').then((preview) => {
        if (cancelled || (credentialRequestVersionRef.current[credentialKey] ?? 0) !== previewVersion ||
          (credentialDraftGenerationRef.current[credentialKey] ?? 0) !== previewDraftGeneration) return
        credentialPreviewRef.current[credentialKey] = preview
        if ((credentialRequestVersionRef.current[credentialKey] ?? 0) === 0 && !credentialEditingRef.current[credentialKey]) {
          credentialAcknowledgedVersionRef.current[credentialKey] = 0
          setSpeechApiKeyInputs((previous) => ({ ...previous, [providerId]: preview }))
          setSpeechApiKeyPreviewActive((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
        }
        setSpeechCredentialConfigured((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
        speechCredentialConfiguredRef.current[providerId] = Boolean(preview)
        setSpeechOverrideEnabled((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
      })
    }

    // Detect current channel from active tab
    chrome.tabs?.query({ active: true, currentWindow: true }).then((tabs) => {
      if (cancelled) return
      const tab = tabs[0]

      if (!tab?.url) return

      const name = extractChannelFromUrl(tab.url)

      setChannelName(name)

      if (name) {
        // Check if there are per-channel settings for this channel
        getChannelSettings(name).then((channel) => {
          if (cancelled) return
          if (channel && Object.keys(channel).length > 0) {
            setUseChannelSettings(true)
            setSettings((prev) =>
              prev ? mergeSettings(prev, channel) : prev,
            )
          }
        })
      }
    })

    // Listen for error notifications
    const handleErrorNotification = (message: unknown) => {
      const msg = message as { type?: string; payload?: ErrorNotification } | undefined
      if (msg?.type === 'error_notification' && msg.payload) {
        const { id, type, message: errMsg, timestamp } = msg.payload
        setErrorNotifications((prev) => [
          { id, type, message: errMsg, timestamp },
          ...prev.slice(0, 19), // keep max 20 notifications
        ])
      }

      if (isDiagnosticEventMessage(message)) {
        setDiagnostics((prev) => mergeDiagnostics(prev, [message.payload]))
      }
      if (isSpeechStateMessage(message)) {
        setSpeechState(message.payload)
      }
      const diagnosticSnapshot = message as { type?: string; payload?: { events?: DiagnosticEvent[] } } | undefined
      const diagnosticEvents = diagnosticSnapshot?.payload?.events
      if (diagnosticSnapshot?.type === 'diagnostics_snapshot' && Array.isArray(diagnosticEvents)) {
        setDiagnostics((prev) => mergeDiagnostics(prev, diagnosticEvents))
      }
    }

    chrome.runtime.onMessage.addListener(handleErrorNotification)
    errorListenerRef.current = handleErrorNotification

    return () => {
      cancelled = true
      if (errorListenerRef.current) {
        chrome.runtime.onMessage.removeListener(errorListenerRef.current)
      }
    }
  }, [])

  const dismissError = useCallback((id: string) => {
    setErrorNotifications((prev) => prev.filter((n) => n.id !== id))
  }, [])

  const updateSetting = useCallback(
    <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
      setSettings((prev) => (prev ? { ...prev, [key]: value } : prev))
    },
    [],
  )

  const updateGeminiQuota = useCallback(
    (key: keyof GeminiQuotaSettings, value: number) => {
      setSettings((previous) => {
        if (!previous) return previous
        const quotaModel = previous.selectedModel === AUTO_MODEL
          ? resolvePolicyModel(modelPolicy, 'gemini', 'chat', AUTO_MODEL).model
          : previous.selectedModel
        const current = previous.geminiQuotaProfiles[quotaModel] ?? previous.geminiQuota
        const nextProfile = { ...current, [key]: value }
        return {
          ...previous,
          geminiQuota: nextProfile,
          geminiQuotaProfiles: {
            ...previous.geminiQuotaProfiles,
            [quotaModel]: nextProfile,
          },
        }
      })
    },
    [modelPolicy],
  )

  const updateSpeechConfig = useCallback(
    <K extends keyof SpeechTranslationConfig>(key: K, value: SpeechTranslationConfig[K]) => {
      setSettings((previous) => {
        if (!previous) return previous
        return {
          ...previous,
          speechConfig: {
            ...previous.speechConfig,
            [key]: value,
          },
        }
      })
    },
    [],
  )

  /**
   * Serializes live writes so quick successive changes cannot read the same
   * persisted snapshot and overwrite one another. Each operation persists
   * before changing Popup state or notifying another extension context.
   */
  const enqueueLiveUpdate = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const queued = liveUpdateQueueRef.current.then(operation, operation)
    liveUpdateQueueRef.current = queued.then(() => undefined, () => undefined)
    return queued
  }, [])

  const persistLiveChatSetting = useCallback(
    <K extends LiveChatSettingKey>(key: K, value: UserSettings[K]): void => {
      void enqueueLiveUpdate(async () => {
        try {
          if (useChannelSettings && channelName) {
            const currentChannelSettings = await getChannelSettings(channelName)
            await saveChannelSettings(channelName, {
              ...(currentChannelSettings ?? {}),
              [key]: value,
            })
          } else {
            await saveUserSettings({ [key]: value } as Partial<UserSettings>)
          }
        } catch {
          setLiveControlError(true)
          return
        }

        setSettings((previous) => previous ? { ...previous, [key]: value } : previous)
        setLiveControlError(false)

        try {
          const payload: SettingsUpdatePayload = {
            ...(useChannelSettings && channelName ? { channelName } : {}),
            [key]: value,
          } as SettingsUpdatePayload
          await chrome.runtime.sendMessage({
            type: 'settings_updated',
            payload,
          })
        } catch {
          // Storage is authoritative even if a tab or the Service Worker is
          // unavailable. Keep the persisted UI value and expose a retryable
          // bounded notice rather than surfacing a raw runtime error.
          setLiveControlError(true)
        }
      })
    },
    [channelName, enqueueLiveUpdate, useChannelSettings],
  )

  const persistLiveSpeechSettings = useCallback(
    async (updates: LiveSpeechSettings, controlAction?: 'start' | 'stop'): Promise<boolean> =>
      enqueueLiveUpdate(async () => {
        try {
          const persistedSettings = await getUserSettings()
          await saveUserSettings({
            speechConfig: {
              ...persistedSettings.speechConfig,
              ...updates,
            },
          })
        } catch {
          setLiveControlError(true)
          return false
        }

        setSettings((previous) => previous
          ? {
              ...previous,
              speechConfig: {
                ...previous.speechConfig,
                ...updates,
              },
            }
          : previous)
        setLiveControlError(false)

        try {
          await chrome.runtime.sendMessage({
            type: 'speech_settings_updated',
            payload: updates,
          })
        } catch {
          setLiveControlError(true)
        }

        if (controlAction) {
          try {
            await chrome.runtime.sendMessage({
              type: 'speech_control',
              payload: { action: controlAction },
            })
          } catch {
            setLiveControlError(true)
          }
        }

        return true
      }),
    [enqueueLiveUpdate],
  )

  /**
   * Toggle change for the "語音字幕" switch (#162). First enable shows the
   * consent panel (Spec §8.2) and does NOT start capture; capture starts only
   * on the "啟用並開始" confirm gesture (speech_control start). The checkbox
   * stays visually OFF until consent is granted, so turning it back off at any
   * point before confirming is a no-op.
   *
   * Once consent is granted the switch is a direct capture control: toggling on
   * persists speechEnabled then sends `speech_control start`, toggling off
   * persists false then sends `speech_control stop`. Persistence happens before
   * the control message because the SW pipeline's start() gates on
   * speechEnabled being already stored.
   */
  const handleSpeechEnabledToggle = useCallback((checked: boolean) => {
    void (async () => {
      if (!checked) {
        // Turning the switch off: close any open consent panel, and when consent
        // was previously granted persist the off state and stop capture. If the
        // panel is open nothing was started yet, so no control message is sent.
        setSpeechConsentOpen(false)
        if (settings?.speechConfig.speechConsentGranted) {
          await persistLiveSpeechSettings({ speechEnabled: false }, 'stop')
        }
        return
      }
      if (settings?.speechConfig.speechConsentGranted) {
        // Consent was granted previously: persist first (the SW pipeline's
        // start() reads speechEnabled from storage), then start capture.
        await persistLiveSpeechSettings({ speechEnabled: true }, 'start')
        return
      }
      // First enable: show the consent panel; nothing is started or persisted
      // until the confirm gesture (Spec §8.2).
      setSpeechConsentOpen(true)
    })().catch(() => undefined)
  }, [persistLiveSpeechSettings, settings])

  /**
   * The "啟用並開始" confirm click IS the gesture that authorizes capture
   * (Spec §8.2): it persists consent + speechEnabled and then sends
   * `speech_control start` to the SW. Persistence happens first because the SW
   * pipeline's start() gates on speechEnabled being already stored.
   */
  const handleSpeechConsentConfirm = useCallback(async () => {
    if (!settings) return
    const persisted = await persistLiveSpeechSettings({
      speechEnabled: true,
      speechConsentGranted: true,
    }, 'start')
    if (persisted) setSpeechConsentOpen(false)
  }, [persistLiveSpeechSettings, settings])

  const handleSpeechConsentCancel = useCallback(() => {
    setSpeechConsentOpen(false)
  }, [])

  const handleProviderChange = useCallback(
    (providerId: string) => {
      const meta = providers.find((p) => p.id === providerId)
      updateSetting('selectedProvider', providerId as ProviderId)
      if (meta) {
        updateSetting('selectedModel', providerId === 'gemini' || providerId === 'deepseek' ? AUTO_MODEL : meta.defaultModel)
      }
    },
    [providers, updateSetting],
  )

  const getModelsForProvider = useCallback(
    (providerId: string) => {
      return providers.find((p) => p.id === providerId)?.models ?? []
    },
    [providers],
  )

  const handleSave = useCallback(async () => {
    if (!settings) return

    await enqueueLiveUpdate(async () => {
      const persistedGlobalSettings = await getUserSettings()
      const persistedChannelSettings = useChannelSettings && channelName
        ? await getChannelSettings(channelName)
        : undefined
      const persistedEffectiveSettings = persistedChannelSettings
        ? mergeSettings(persistedGlobalSettings, persistedChannelSettings)
        : persistedGlobalSettings

      const parsedBlacklist = blacklistInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      const quotaModel = settings.selectedProvider === 'gemini' && settings.selectedModel === AUTO_MODEL
        ? resolvePolicyModel(modelPolicy, 'gemini', 'chat', AUTO_MODEL).model : settings.selectedModel
      const selectedGeminiQuota = settings.geminiQuotaProfiles[quotaModel] ?? settings.geminiQuota
      const updatedSettings = {
        ...settings,
        // Live controls are authoritative in storage. Re-read them after all
        // earlier live writes so the retained Save action cannot overwrite a
        // newer value with its render-time snapshot.
        translationEnabled: persistedEffectiveSettings.translationEnabled,
        targetLanguage: persistedEffectiveSettings.targetLanguage,
        displayMode: persistedEffectiveSettings.displayMode,
        speechConfig: {
          ...settings.speechConfig,
          speechEnabled: persistedGlobalSettings.speechConfig.speechEnabled,
          speechConsentGranted: persistedGlobalSettings.speechConfig.speechConsentGranted,
          speechTargetLanguage: persistedGlobalSettings.speechConfig.speechTargetLanguage,
          captionMaxLines: persistedGlobalSettings.speechConfig.captionMaxLines,
          captionOpacity: persistedGlobalSettings.speechConfig.captionOpacity,
        },
        botNameBlacklist: parsedBlacklist,
        geminiQuota: selectedGeminiQuota,
      }

      if (useChannelSettings && channelName) {
        const {
          geminiQuota,
          geminiQuotaProfiles,
          // Speech config is global-only in v0.3: it is persisted globally
          // (like geminiQuota) and never enters the per-channel override.
          speechConfig,
          ...channelSettings
        } = updatedSettings
        await saveUserSettings({ geminiQuota, geminiQuotaProfiles, speechConfig })
        await saveChannelSettings(channelName, channelSettings)
      } else {
        await saveUserSettings(updatedSettings)
      }
      setSettings(updatedSettings)
      setSaveMessage(t('settingsSaved'))
      setTimeout(() => setSaveMessage(null), 2000)

      // Notify content script of settings change via SW broadcast
      const payload: SettingsUpdatePayload = {
        ...(useChannelSettings && channelName ? { channelName } : {}),
        translationEnabled: updatedSettings.translationEnabled,
        displayMode: updatedSettings.displayMode,
        targetLanguage: updatedSettings.targetLanguage,
        chineseVariantMode: updatedSettings.chineseVariantMode,
        minTextLength: updatedSettings.minTextLength,
        botNameBlacklist: updatedSettings.botNameBlacklist,
        skipEmotesOnly: updatedSettings.skipEmotesOnly,
        skipCheermotes: updatedSettings.skipCheermotes,
        skipSlashMe: updatedSettings.skipSlashMe,
        skipWhispers: updatedSettings.skipWhispers,
        skipReplies: updatedSettings.skipReplies,
        skipLinksOnly: updatedSettings.skipLinksOnly,
        skipNumbersOnly: updatedSettings.skipNumbersOnly,
        skipSystemMessages: updatedSettings.skipSystemMessages,
      }
      await chrome.runtime.sendMessage({
        type: 'settings_updated',
        payload,
      })

      // Speech settings are broadcast on their own channel (Spec §6). The payload
      // is Partial<SpeechTranslationConfig>-compatible.
      const speechPayload: SpeechSettingsUpdatePayload = { ...updatedSettings.speechConfig }
      await chrome.runtime.sendMessage({
        type: 'speech_settings_updated',
        payload: speechPayload,
      })
    })
  }, [settings, blacklistInput, useChannelSettings, channelName, enqueueLiveUpdate, modelPolicy])

  const handleApiKeyChange = useCallback((providerId: string, value: string): void => {
    const credentialKey = `chat:${providerId}`
    if (apiKeyPreviewActive[providerId] && !credentialEditingRef.current[credentialKey]) return
    credentialDraftGenerationRef.current[credentialKey] = (credentialDraftGenerationRef.current[credentialKey] ?? 0) + 1
    credentialDirtyRef.current[credentialKey] = true
    setApiKeyInputs((previous) => ({ ...previous, [providerId]: value }))
    setValidationStatus((previous) => ({ ...previous, [providerId]: null }))
  }, [apiKeyPreviewActive])

  const commitApiKeyDraft = useCallback((providerId: string): Promise<boolean> => {
    const credentialKey = `chat:${providerId}`
    if (!credentialDirtyRef.current[credentialKey]) return Promise.resolve(true)
    const generation = credentialDraftGenerationRef.current[credentialKey] ?? 0
    const existing = credentialCommitPromiseRef.current[credentialKey]
    if (existing?.generation === generation) return existing.promise

    const draft = apiKeyInputs[providerId] ?? ''
    const normalized = draft.trim()
    const version = (credentialRequestVersionRef.current[credentialKey] ?? 0) + 1
    credentialRequestVersionRef.current[credentialKey] = version
    const promise = (async (): Promise<boolean> => {
      let response: { payload?: { success?: boolean; preview?: string } } | undefined
      try {
        response = normalized
          ? await chrome.runtime.sendMessage({ type: 'save_api_key', payload: { providerId, apiKey: normalized } }) as typeof response
          : await chrome.runtime.sendMessage({ type: 'delete_api_key', payload: { providerId } }) as typeof response
      } catch {
        response = undefined
      }

      if (credentialRequestVersionRef.current[credentialKey] !== version) return false
      if (response?.payload?.success) {
        const preview = normalized ? response.payload.preview ?? '' : ''
        credentialPreviewRef.current[credentialKey] = preview
        credentialAcknowledgedVersionRef.current[credentialKey] = version
        setApiKeyConfigured((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
        if (generation === credentialDraftGenerationRef.current[credentialKey]) {
          credentialDirtyRef.current[credentialKey] = false
          if (!credentialEditingRef.current[credentialKey]) {
            setApiKeyInputs((previous) => ({ ...previous, [providerId]: preview }))
            setApiKeyPreviewActive((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
          }
        }
        return true
      }

      setValidationStatus((previous) => ({ ...previous, [providerId]: 'invalid' }))
      const preview = await readApiKeyPreview(providerId)
      if (preview !== undefined && credentialRequestVersionRef.current[credentialKey] === version) {
        credentialPreviewRef.current[credentialKey] = preview
        credentialAcknowledgedVersionRef.current[credentialKey] = version
        setApiKeyConfigured((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
        if (generation === credentialDraftGenerationRef.current[credentialKey] &&
          !credentialDirtyRef.current[credentialKey] && !credentialEditingRef.current[credentialKey]) {
          setApiKeyInputs((previous) => ({ ...previous, [providerId]: preview }))
          setApiKeyPreviewActive((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
        }
      }
      return false
    })()
    credentialCommitPromiseRef.current[credentialKey] = { generation, promise }
    void promise.finally(() => {
      if (credentialCommitPromiseRef.current[credentialKey]?.promise === promise) {
        delete credentialCommitPromiseRef.current[credentialKey]
      }
    }).catch(() => undefined)
    return promise
  }, [apiKeyInputs])

  const handleValidateKey = useCallback(async (providerId: string) => {
    setValidationStatus((previous) => ({ ...previous, [providerId]: 'checking' }))
    if (!await commitApiKeyDraft(providerId)) return

    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'validate_key',
        payload: { providerId },
      })) as { type: string; payload: { valid: boolean } }

      setValidationStatus((previous) => ({
        ...previous,
        [providerId]: response.payload.valid ? 'valid' : 'invalid',
      }))
    } catch {
      setValidationStatus((previous) => ({ ...previous, [providerId]: 'invalid' }))
    }
  }, [commitApiKeyDraft])

  const handleApiKeyPreviewFocus = useCallback((providerId: string): void => {
    const credentialKey = `chat:${providerId}`
    credentialEditingRef.current[credentialKey] = true
    if (!apiKeyPreviewActive[providerId]) return
    setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }))
    setApiKeyPreviewActive((prev) => ({ ...prev, [providerId]: false }))
  }, [apiKeyPreviewActive])

  const handleApiKeyPreviewBlur = useCallback((providerId: string): void => {
    const credentialKey = `chat:${providerId}`
    credentialEditingRef.current[credentialKey] = false
    if (credentialDirtyRef.current[credentialKey]) {
      void commitApiKeyDraft(providerId)
      return
    }
    const version = credentialRequestVersionRef.current[credentialKey] ?? 0
    const preview = credentialPreviewRef.current[credentialKey]
    if (credentialAcknowledgedVersionRef.current[credentialKey] !== version || preview === undefined) return
    setApiKeyInputs((previous) => ({ ...previous, [providerId]: preview }))
    setApiKeyPreviewActive((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
  }, [commitApiKeyDraft])

  const handleSpeechApiKeyChange = useCallback((providerId: SpeechProviderId, value: string): void => {
    const credentialKey = `speech:${providerId}`
    if (speechApiKeyPreviewActive[providerId] && !credentialEditingRef.current[credentialKey]) return
    credentialDraftGenerationRef.current[credentialKey] = (credentialDraftGenerationRef.current[credentialKey] ?? 0) + 1
    credentialDirtyRef.current[credentialKey] = true
    setSpeechApiKeyInputs((previous) => ({ ...previous, [providerId]: value }))
    setSpeechCredentialMutationFailed((previous) => ({ ...previous, [providerId]: false }))
  }, [speechApiKeyPreviewActive])

  const commitSpeechApiKeyDraft = useCallback((providerId: SpeechProviderId): Promise<boolean> => {
    const credentialKey = `speech:${providerId}`
    if (!credentialDirtyRef.current[credentialKey]) return Promise.resolve(true)
    const generation = credentialDraftGenerationRef.current[credentialKey] ?? 0
    const existing = credentialCommitPromiseRef.current[credentialKey]
    if (existing?.generation === generation) return existing.promise

    const draft = speechApiKeyInputs[providerId] ?? ''
    const normalized = draft.trim()
    const version = (credentialRequestVersionRef.current[credentialKey] ?? 0) + 1
    credentialRequestVersionRef.current[credentialKey] = version
    const promise = (async (): Promise<boolean> => {
      let response: { payload?: { success?: boolean; preview?: string } } | undefined
      try {
        response = normalized
          ? await chrome.runtime.sendMessage({
            type: 'save_api_key', payload: { providerId, apiKey: normalized, scope: 'speech' },
          }) as typeof response
          : await chrome.runtime.sendMessage({
            type: 'delete_api_key', payload: { providerId, scope: 'speech' },
          }) as typeof response
      } catch {
        response = undefined
      }

      if (credentialRequestVersionRef.current[credentialKey] !== version) return false
      if (response?.payload?.success) {
        const preview = normalized ? response.payload.preview ?? '' : ''
        credentialPreviewRef.current[credentialKey] = preview
        credentialAcknowledgedVersionRef.current[credentialKey] = version
        setSpeechCredentialConfigured((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
        speechCredentialConfiguredRef.current[providerId] = Boolean(preview)
        if (generation === credentialDraftGenerationRef.current[credentialKey]) {
          credentialDirtyRef.current[credentialKey] = false
          if (!credentialEditingRef.current[credentialKey]) {
            setSpeechApiKeyInputs((previous) => ({ ...previous, [providerId]: preview }))
            setSpeechApiKeyPreviewActive((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
          }
          setSpeechOverrideEnabled((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
        }
        setSpeechCredentialMutationFailed((previous) => ({ ...previous, [providerId]: false }))
        return true
      }

      setSpeechCredentialMutationFailed((previous) => ({ ...previous, [providerId]: true }))
      const preview = await readApiKeyPreview(providerId, 'speech')
      if (preview !== undefined && credentialRequestVersionRef.current[credentialKey] === version) {
        credentialPreviewRef.current[credentialKey] = preview
        credentialAcknowledgedVersionRef.current[credentialKey] = version
        setSpeechCredentialConfigured((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
        speechCredentialConfiguredRef.current[providerId] = Boolean(preview)
        if (generation === credentialDraftGenerationRef.current[credentialKey] &&
          !credentialDirtyRef.current[credentialKey] && !credentialEditingRef.current[credentialKey]) {
          setSpeechApiKeyInputs((previous) => ({ ...previous, [providerId]: preview }))
          setSpeechApiKeyPreviewActive((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
        }
      }
      return false
    })()
    credentialCommitPromiseRef.current[credentialKey] = { generation, promise }
    void promise.finally(() => {
      if (credentialCommitPromiseRef.current[credentialKey]?.promise === promise) {
        delete credentialCommitPromiseRef.current[credentialKey]
      }
    }).catch(() => undefined)
    return promise
  }, [speechApiKeyInputs])

  const handleSpeechApiKeyPreviewFocus = useCallback((providerId: SpeechProviderId): void => {
    const credentialKey = `speech:${providerId}`
    credentialEditingRef.current[credentialKey] = true
    if (!speechApiKeyPreviewActive[providerId]) return
    setSpeechApiKeyInputs((previous) => ({ ...previous, [providerId]: '' }))
    setSpeechApiKeyPreviewActive((previous) => ({ ...previous, [providerId]: false }))
  }, [speechApiKeyPreviewActive])

  const handleSpeechApiKeyPreviewBlur = useCallback((providerId: SpeechProviderId): void => {
    const credentialKey = `speech:${providerId}`
    credentialEditingRef.current[credentialKey] = false
    if (credentialDirtyRef.current[credentialKey]) {
      void commitSpeechApiKeyDraft(providerId)
      return
    }
    const version = credentialRequestVersionRef.current[credentialKey] ?? 0
    const preview = credentialPreviewRef.current[credentialKey]
    if (credentialAcknowledgedVersionRef.current[credentialKey] !== version || preview === undefined) return
    setSpeechApiKeyInputs((previous) => ({ ...previous, [providerId]: preview }))
    setSpeechApiKeyPreviewActive((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
  }, [commitSpeechApiKeyDraft])

  const handleSpeechOverrideToggle = useCallback(async (providerId: SpeechProviderId, enabled: boolean): Promise<void> => {
    if (enabled) {
      setSpeechOverrideEnabled((previous) => ({ ...previous, [providerId]: true }))
      if (!speechCredentialConfigured[providerId]) setSpeechApiKeyInputs((previous) => ({ ...previous, [providerId]: '' }))
      return
    }
    const credentialKey = `speech:${providerId}`
    credentialDraftGenerationRef.current[credentialKey] = (credentialDraftGenerationRef.current[credentialKey] ?? 0) + 1
    const draftGeneration = credentialDraftGenerationRef.current[credentialKey] ?? 0
    credentialDirtyRef.current[credentialKey] = false
    const version = (credentialRequestVersionRef.current[credentialKey] ?? 0) + 1
    credentialRequestVersionRef.current[credentialKey] = version
    let response: { payload?: { success?: boolean } } | undefined
    try {
      response = await chrome.runtime.sendMessage({
        type: 'delete_api_key', payload: { providerId, scope: 'speech' },
      }) as typeof response
    } catch {
      response = undefined
    }

    if (credentialRequestVersionRef.current[credentialKey] === version && response?.payload?.success) {
      credentialPreviewRef.current[credentialKey] = ''
      credentialAcknowledgedVersionRef.current[credentialKey] = version
      setSpeechCredentialConfigured((previous) => ({ ...previous, [providerId]: false }))
      speechCredentialConfiguredRef.current[providerId] = false
      if (draftGeneration === credentialDraftGenerationRef.current[credentialKey] &&
        !credentialDirtyRef.current[credentialKey] && !credentialEditingRef.current[credentialKey]) {
        setSpeechApiKeyInputs((previous) => ({ ...previous, [providerId]: '' }))
        setSpeechApiKeyPreviewActive((previous) => ({ ...previous, [providerId]: false }))
        setSpeechOverrideEnabled((previous) => ({ ...previous, [providerId]: false }))
      }
      setSpeechCredentialMutationFailed((previous) => ({ ...previous, [providerId]: false }))
      return
    }

    if (credentialRequestVersionRef.current[credentialKey] !== version) return
    setSpeechCredentialMutationFailed((previous) => ({ ...previous, [providerId]: true }))
    const preview = await readApiKeyPreview(providerId, 'speech')
    if (preview === undefined || credentialRequestVersionRef.current[credentialKey] !== version) return
    credentialPreviewRef.current[credentialKey] = preview
    credentialAcknowledgedVersionRef.current[credentialKey] = version
    setSpeechCredentialConfigured((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
    speechCredentialConfiguredRef.current[providerId] = Boolean(preview)
    if (draftGeneration === credentialDraftGenerationRef.current[credentialKey] &&
      !credentialDirtyRef.current[credentialKey] && !credentialEditingRef.current[credentialKey]) {
      setSpeechApiKeyInputs((previous) => ({ ...previous, [providerId]: preview }))
      setSpeechApiKeyPreviewActive((previous) => ({ ...previous, [providerId]: Boolean(preview) }))
    }
  }, [speechCredentialConfigured])

  const toggleKeyVisibility = useCallback((providerId: string) => {
    setVisibleKeys((prev) => ({ ...prev, [providerId]: !prev[providerId] }))
  }, [])

  if (!settings) {
    return <div className="app__loading">{t('loading')}</div>
  }

  const selectedPolicy = modelPolicy.manifest.policies.find(entry => entry.provider === settings.selectedProvider && entry.workload === 'chat')
  const currentModels = [...getModelsForProvider(settings.selectedProvider)]
  for (const entry of selectedPolicy?.models ?? []) {
    if (!currentModels.some(model => model.id === entry.id)) currentModels.push({ id: entry.id, displayName: entry.id })
  }
  if (settings.selectedModel !== AUTO_MODEL && !currentModels.some(model => model.id === settings.selectedModel)) {
    currentModels.push({ id: settings.selectedModel, displayName: settings.selectedModel })
  }
  const resolvedChatModel = selectedPolicy ? resolvePolicyModel(modelPolicy, selectedPolicy.provider, 'chat', settings.selectedModel).model : settings.selectedModel
  const speechModels = [...SPEECH_GEMINI_MODELS]
  for (const entry of modelPolicy.manifest.policies.find(policy => policy.provider === 'gemini' && policy.workload === 'speech')?.models ?? []) {
    if (!speechModels.some(model => model.id === entry.id)) speechModels.push({ id: entry.id, displayName: entry.id })
  }
  if (settings.speechConfig.speechModel !== AUTO_MODEL && !speechModels.some(model => model.id === settings.speechConfig.speechModel)) {
    speechModels.push({ id: settings.speechConfig.speechModel, displayName: settings.speechConfig.speechModel })
  }
  const currentModel = currentModels.find((model) => model.id === resolvedChatModel)
  const currentGeminiQuota = settings.geminiQuotaProfiles[resolvedChatModel] ?? settings.geminiQuota

  return (
    <div className="app">
      {/* Header: identity, active channel, concise live status (#173). */}
      <header className="app__header">
        <h1 className="app__title">tachi-lens</h1>
        {channelName && (
          <div className="app__channel">
            <span className="card__channel-label">頻道：</span>
            <span className="card__channel-value">{channelName}</span>
          </div>
        )}
        <div className="app__status" role="status">
          <StatusBadge tone={settings.translationEnabled ? 'success' : 'neutral'}>
            {settings.translationEnabled ? t('statusEnabled') : t('statusDisabled')}
          </StatusBadge>
          <span className="app__status-summary">
            {providers.find((p) => p.id === settings.selectedProvider)?.displayName ?? settings.selectedProvider}
            {' → '}
            {getTargetLanguageLabel(settings.targetLanguage)}
          </span>
        </div>
      </header>

      {/* Error notification area — anything needing attention is surfaced first. */}
      {errorNotifications.length > 0 && (
        <section className="app__section">
          <SectionHeader level={2}>{t('errorNotificationTitle')}</SectionHeader>
          <div className="error-list">
            {errorNotifications.map((n) => (
              <div key={n.id} className="error-item">
                <span className="error-item__text">{n.message}</span>
                <IconButton
                  bare
                  ariaLabel={t('dismiss')}
                  title={t('dismiss')}
                  onClick={() => dismissError(n.id)}
                >
                  <CloseIcon />
                </IconButton>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Quick controls: the primary control-center surface (#173). */}
      <div className="app__quick-controls">
        <ToggleRow
          label={t('enableTranslation')}
          checked={settings.translationEnabled}
          onChange={(checked) => persistLiveChatSetting('translationEnabled', checked)}
        />

        <div className="field-grid">
          <SelectField
            id="language-select"
            label={t('targetLanguage')}
            value={settings.targetLanguage}
            onChange={(value) => persistLiveChatSetting('targetLanguage', value)}
          >
            {TARGET_LANGUAGE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="display-mode-select"
            label={t('displayMode')}
            value={settings.displayMode}
            onChange={(value) => persistLiveChatSetting('displayMode', value as UserSettings['displayMode'])}
          >
            <option value='below'>{t('displayBelow')}</option>
            <option value='hover'>{t('displayHover')}</option>
            <option value='collapse'>{t('displayCollapse')}</option>
          </SelectField>
        </div>

        {/* Speech quick controls (subtitles toggle + target language). */}
        <ToggleRow
          label={t('speechEnabled')}
          checked={speechConsentOpen || settings.speechConfig.speechEnabled}
          onChange={handleSpeechEnabledToggle}
        />
        {speechState && (
          <div className="speech-status">
            <span className="speech-status__label">{t('speechStatus')}：</span>
            <span>
              {speechState.errorKey
                ? `${settings.speechConfig.speechProvider}: ${t(speechState.errorKey as Parameters<typeof t>[0])}`
                : t(SPEECH_STATE_LABELS[speechState.state])}
            </span>
          </div>
        )}
        <SelectField
          id="speech-language-select"
          label={t('speechTargetLanguage')}
          value={settings.speechConfig.speechTargetLanguage}
          onChange={(value) => void persistLiveSpeechSettings({ speechTargetLanguage: value })}
        >
          {SPEECH_LANGUAGE_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>

        {/* First-enable consent panel (Spec §8.2 / #162). Capture is NOT started
            until the "啟用並開始" confirm click. */}
        {speechConsentOpen && (
          <div
            className="consent-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('speechConsentTitle')}
          >
            <div className="consent-dialog__title">
              {t('speechConsentTitle')}
            </div>
            <div className="consent-dialog__body">
              {t('speechConsentIntro')}
              <ul className="consent-dialog__list">
                <li>{t('speechConsentCaptureTabAudio')}</li>
                <li>{t('speechConsentSendProvider')}</li>
                <li>{t('speechConsentNeverStored')}</li>
                <li>{t('speechConsentBilledPerKey')}</li>
                <li>{t('speechConsentActiveVisible')}</li>
              </ul>
            </div>
            <div className="consent-dialog__actions">
              <Button variant="primary" onClick={() => void handleSpeechConsentConfirm()}>
                {t('speechConsentConfirm')}
              </Button>
              <Button variant="secondary" onClick={handleSpeechConsentCancel}>
                {t('speechConsentCancel')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Advanced sections: progressively disclosed (#173). */}
      <div className="app__advanced">
        {/* Providers & API Keys */}
        <Accordion id="providers" title={t('providersSection')}>
          <SelectField
            id="provider-select"
            label={t('translationProvider')}
            value={settings.selectedProvider}
            onChange={handleProviderChange}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="model-select"
            label={t('model')}
            value={settings.selectedModel}
            onChange={(value) => updateSetting('selectedModel', value)}
          >
            {selectedPolicy && <option value={AUTO_MODEL}>{t('modelRecommended')} ({selectedPolicy.recommended})</option>}
            {currentModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </SelectField>

          {settings.selectedProvider === 'gemini' && (
            <Card>
              <SectionHeader>{`${t('geminiQuotaSection')}: ${currentModel?.displayName ?? settings.selectedModel}`}</SectionHeader>
              <p className="section-hint">{t('geminiQuotaHelp')}</p>
              <div className="field-grid">
                {GEMINI_QUOTA_FIELDS.map(({ key, labelKey, min, max }) => (
                  <NumberField
                    key={key}
                    id={`gemini-quota-${key}`}
                    label={t(labelKey)}
                    min={min}
                    max={max}
                    value={currentGeminiQuota[key]}
                    onChange={(value) => {
                      const parsed = Math.floor(value)
                      const bounded = Number.isFinite(parsed)
                        ? Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min, parsed))
                        : min
                      updateGeminiQuota(key, bounded)
                    }}
                  />
                ))}
              </div>
            </Card>
          )}

          <div className="field">
            <SecretInput
              id="api-key-input"
              label={t('apiKey')}
              value={apiKeyInputs[settings.selectedProvider] ?? ''}
              onChange={(value) => handleApiKeyChange(settings.selectedProvider, value)}
              onFocus={() => handleApiKeyPreviewFocus(settings.selectedProvider)}
              onBlur={() => handleApiKeyPreviewBlur(settings.selectedProvider)}
              placeholder={t('apiKeyPlaceholder')}
              visible={Boolean(visibleKeys[settings.selectedProvider])}
              onToggleVisible={() => toggleKeyVisibility(settings.selectedProvider)}
              showLabel={t('show')}
              hideLabel={t('hide')}
            />
            <div className="inline-actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleValidateKey(settings.selectedProvider)}
                disabled={validationStatus[settings.selectedProvider] === 'checking'}
              >
                {validationStatus[settings.selectedProvider] === 'checking' ? t('validating') : t('validate')}
              </Button>
              {validationStatus[settings.selectedProvider] === 'valid' && (
                <StatusBadge tone="success" showDot={false}>{t('valid')}</StatusBadge>
              )}
              {validationStatus[settings.selectedProvider] === 'invalid' && (
                <StatusBadge tone="danger" showDot={false}>{t('invalid')}</StatusBadge>
              )}
            </div>
          </div>
        </Accordion>

        {/* Chat Filters */}
        <Accordion id="filters" title={t('filterSection')}>
          <NumberField
            id="min-length-input"
            label={t('minTextLength')}
            min={1}
            max={100}
            value={settings.minTextLength}
            onChange={(value) => updateSetting('minTextLength', Math.max(1, Math.floor(value) || 1))}
          />

          {isChineseTarget(settings.targetLanguage) && (
            <Card>
              <SectionHeader>{t('chineseVariantSection')}</SectionHeader>
              <SegmentedControl
                groupLabel={t('chineseVariantSection')}
                name="chinese-variant-mode"
                options={CHINESE_VARIANT_OPTIONS.map(({ value, labelKey }) => ({
                  value,
                  id: `chinese-variant-${value}`,
                  label: t(labelKey),
                }))}
                value={settings.chineseVariantMode}
                onChange={(value) => updateSetting('chineseVariantMode', value as ChineseVariantMode)}
              />
            </Card>
          )}

          {FILTER_TOGGLES.map(({ key, labelKey }) => (
            <ToggleRow
              key={key}
              compact
              label={t(labelKey)}
              checked={settings[key] as boolean}
              onChange={(checked) => updateSetting(key, checked)}
            />
          ))}

          <TextInput
            id="blacklist-input"
            label={t('botBlacklist')}
            value={blacklistInput}
            onChange={setBlacklistInput}
            placeholder={t('botBlacklistPlaceholder')}
          />
        </Accordion>

        {/* Quota & Health */}
        <Accordion id="quota-health" title={t('quotaHealthSection')}>
          {quotaHealthLoading ? (
            <div className="panel-loading" role="status">{t('loading')}</div>
          ) : quotaHealth.length === 0 ? (
            <EmptyState>{t('quotaHealthEmpty')}</EmptyState>
          ) : (
            <div className="quota-health-stack">
              {quotaHealth.map((result) => {
                const meta = QUOTA_HEALTH_STATUS_META[result.status]
                const integrity = INTEGRITY_STATUSES.has(result.status)
                return (
                  <Card key={result.quotaKey} className={`quota-card quota-card--${result.status}`}>
                    <div className="quota-card__header">
                      <span className="quota-card__model">{result.quotaKey}</span>
                      <StatusBadge tone={meta.tone} className="quota-card__status">
                        {t(meta.labelKey)}
                      </StatusBadge>
                    </div>
                    <p className="quota-card__description">{t(meta.descKey)}</p>
                    {result.denialReason && (
                      <div className="quota-meta">
                        {t('quotaHealthDenialPrefix')}：{t(QUOTA_HEALTH_DENIAL_LABELS[result.denialReason])}
                      </div>
                    )}
                    {result.providerDay && (
                      <div className="quota-meta">
                        {t('quotaHealthProviderDay')}：{result.providerDay}
                      </div>
                    )}
                    {result.cooldownUntil !== undefined && (
                      <div className="quota-meta">
                        {t('quotaHealthCooldownUntil')}：{formatInstant(result.cooldownUntil)}
                      </div>
                    )}
                    {result.recoveryAt !== undefined && (
                      <div className="quota-meta">
                        {t('quotaHealthRecoveryAt')}：{formatInstant(result.recoveryAt)}
                      </div>
                    )}
                    {integrity && (
                      <InlineNotice tone="info" className="quota-overflow-note">
                        {t('quotaHealthDeepSeekOverflow')}
                      </InlineNotice>
                    )}
                    {quotaRepairErrors[result.quotaKey] && (
                      <InlineNotice tone="danger" className="quota-repair-error">
                        {t('quotaHealthRepairFailed')}
                      </InlineNotice>
                    )}
                    {REPAIRABLE_STATUSES.has(result.status) && (
                      <Button
                        variant={confirmingReset[result.quotaKey] ? 'danger' : 'danger-outline'}
                        size="sm"
                        className="quota-repair-btn"
                        onClick={() => void handleResetQuota(result.quotaKey)}
                      >
                        {confirmingReset[result.quotaKey]
                          ? t('quotaHealthRepairConfirm')
                          : t('quotaHealthRepair')}
                      </Button>
                    )}
                  </Card>
                )
              })}
            </div>
          )}
        </Accordion>

        {/* Diagnostics */}
        <Accordion id="diagnostics" title={t('diagnosticsSection')}>
          <Card>
            <SectionHeader>{t('modelPolicyStatus')}</SectionHeader>
            <p>{modelPolicy.source} · v{modelPolicy.manifest.schemaVersion} · #{modelPolicy.manifest.revision}</p>
            {modelPolicy.resolutions.slice(0, 3).map((resolution, index) => (
              <p key={index}>{resolution.provider} / {resolution.workload}: {resolution.model} ({resolution.selection}, {resolution.source}, #{resolution.revision})</p>
            ))}
          </Card>
          {diagnosticsLoading ? (
            <div className="panel-loading" role="status">{t('loading')}</div>
          ) : diagnostics.length === 0 ? (
            <EmptyState>{t('diagnosticsEmpty')}</EmptyState>
          ) : (
            <ul className="diag-list">
              {diagnostics.slice(0, 5).map((event) => (
                <li
                  key={event.id}
                  className={[
                    'diag-item',
                    DIAGNOSTIC_TONES[event.stage] ? `diag-item--${DIAGNOSTIC_TONES[event.stage]}` : '',
                  ].filter(Boolean).join(' ')}
                >
                  <div className="diag-item__main">
                    {DIAGNOSTIC_TONES[event.stage] ? (
                      <StatusBadge tone={DIAGNOSTIC_TONES[event.stage]} className="diag-item__stage">
                        {t(DIAGNOSTIC_LABEL_KEYS[event.stage])}
                      </StatusBadge>
                    ) : (
                      <strong className="diag-item__stage">{t(DIAGNOSTIC_LABEL_KEYS[event.stage])}</strong>
                    )}
                  {isCountStage(event.stage) && typeof event.count === 'number'
                    ? <span className="diag-count" aria-label={`${t('diagnosticsCount')} ${event.count}`}>×{event.count}</span>
                    : null}
                  </div>
                  <time className="diag-item__time" dateTime={formatTimestampAttribute(event.timestamp)}>
                    {formatInstant(event.timestamp)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </Accordion>

        {/* Per-channel Overrides */}
        <Accordion id="channel-overrides" title={t('channelOverridesSection')}>
          {channelName ? (
            <>
              <div className="app__channel">
                <span className="card__channel-label">頻道：</span>
                <span className="card__channel-value">{channelName}</span>
              </div>
              <ToggleRow
                label="使用此頻道的專用設定"
                checked={useChannelSettings}
                onChange={(checked) => setUseChannelSettings(checked)}
              />
            </>
          ) : (
            <p className="section-hint">尚未偵測到 Twitch 頻道。</p>
          )}
        </Accordion>

        {/* Speech & Captions (deep config; quick controls stay on the dashboard) */}
        <Accordion id="speech-captions" title={t('speechCaptionsSection')}>
          <SelectField
            id="speech-provider-select"
            label={t('speechProvider')}
            value={settings.speechConfig.speechProvider}
            onChange={(value) => updateSpeechConfig('speechProvider', value as SpeechProviderId)}
          >
            {SPEECH_PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {id === 'gemini' ? 'Gemini' : id}
              </option>
            ))}
          </SelectField>

          <div className="field">
            <p className="section-hint">
              {speechCredentialConfigured[settings.speechConfig.speechProvider]
                ? t('speechCredentialOverrideActive')
                : apiKeyConfigured[settings.speechConfig.speechProvider]
                  ? t('speechCredentialSharedAvailable')
                : t('speechCredentialMissing')}
            </p>
            {speechCredentialMutationFailed[settings.speechConfig.speechProvider] && (
              <p className="section-hint" role="alert">{t('invalid')}</p>
            )}
            <ToggleRow
              label={t('speechCredentialOverrideToggle')}
              checked={Boolean(speechOverrideEnabled[settings.speechConfig.speechProvider])}
              onChange={(enabled) => void handleSpeechOverrideToggle(settings.speechConfig.speechProvider, enabled)}
            />
            {speechOverrideEnabled[settings.speechConfig.speechProvider] && (
              <SecretInput
                id="speech-api-key-override"
                label={t('speechCredentialOverrideField')}
                value={speechApiKeyInputs[settings.speechConfig.speechProvider] ?? ''}
                onChange={(value) => void handleSpeechApiKeyChange(settings.speechConfig.speechProvider, value)}
                onFocus={() => handleSpeechApiKeyPreviewFocus(settings.speechConfig.speechProvider)}
                onBlur={() => handleSpeechApiKeyPreviewBlur(settings.speechConfig.speechProvider)}
                placeholder={t('apiKeyPlaceholder')}
                visible={Boolean(visibleKeys[`speech:${settings.speechConfig.speechProvider}`])}
                onToggleVisible={() => toggleKeyVisibility(`speech:${settings.speechConfig.speechProvider}`)}
                showLabel={t('show')}
                hideLabel={t('hide')}
              />
            )}
          </div>

          <SelectField
            id="speech-model-select"
            label={t('speechModel')}
            value={settings.speechConfig.speechModel}
            onChange={(value) => updateSpeechConfig('speechModel', value)}
          >
            <option value={AUTO_MODEL}>{t('modelRecommended')} ({modelPolicy.manifest.policies.find(policy => policy.provider === 'gemini' && policy.workload === 'speech')?.recommended})</option>
            {speechModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </SelectField>

          <NumberField
            id="speech-caption-lines-input"
            label={t('speechCaptionMaxLines')}
            min={1}
            value={settings.speechConfig.captionMaxLines}
            onChange={(value) =>
              void persistLiveSpeechSettings({ captionMaxLines: Math.max(1, Math.floor(value) || 1) })
            }
          />

          <NumberField
            id="speech-caption-opacity-input"
            label={t('speechCaptionOpacity')}
            min={0}
            max={100}
            value={settings.speechConfig.captionOpacity}
            onChange={(value) => {
              const parsed = Math.floor(value)
              const bounded = Number.isFinite(parsed)
                ? Math.min(100, Math.max(0, parsed))
                : 0
              void persistLiveSpeechSettings({ captionOpacity: bounded })
            }}
          />

          <NumberField
            id="speech-session-budget-input"
            label={t('speechMaxSessionMinutes')}
            min={1}
            value={settings.speechConfig.maxSessionMinutes}
            onChange={(value) =>
              updateSpeechConfig('maxSessionMinutes', Math.max(1, Math.floor(value) || 1))
            }
          />
        </Accordion>
      </div>

      {/* Footer: save + shortcut info */}
      <footer className="app__footer">
        <div className="inline-actions">
          <Button variant="primary" onClick={handleSave}>
            {t('saveSettings')}
          </Button>
          {saveMessage && (
            <InlineNotice tone="success">{t('settingsSaved')}</InlineNotice>
          )}
          {liveControlError && (
            <InlineNotice tone="danger">{t('settingsSaveFailed')}</InlineNotice>
          )}
        </div>
        <div>{t('shortcutToggleTranslation')}</div>
        <div>{t('shortcutToggleDisplayMode')}</div>
      </footer>
    </div>
  )
}
