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
import { isDiagnosticEventMessage, isQuotaHealthResetResultMessage, isQuotaHealthResultMessage } from '@/shared/messages'
import type {
  DiagnosticEvent,
  DiagnosticStage,
  ErrorNotification,
  QuotaHealthDenialReason,
  QuotaHealthResult,
  QuotaHealthStatus,
  SettingsUpdatePayload,
  SpeechSettingsUpdatePayload,
} from '@/shared/messages'
import type { FilterConfig } from '@/content/message-filter'

const SPEECH_LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'zh-CN', label: '簡體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'th', label: 'ภาษาไทย' },
]

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
  color: string
}> = {
  healthy: {
    labelKey: 'quotaHealthStatusHealthy',
    descKey: 'quotaHealthDescHealthy',
    color: '#2e7d32',
  },
  cooldown: {
    labelKey: 'quotaHealthStatusCooldown',
    descKey: 'quotaHealthDescCooldown',
    color: '#b26a00',
  },
  clock_rollback: {
    labelKey: 'quotaHealthStatusClockRollback',
    descKey: 'quotaHealthDescClockRollback',
    color: '#c0392b',
  },
  untrusted_migration: {
    labelKey: 'quotaHealthStatusUntrustedMigration',
    descKey: 'quotaHealthDescUntrustedMigration',
    color: '#c0392b',
  },
  malformed_snapshot: {
    labelKey: 'quotaHealthStatusMalformedSnapshot',
    descKey: 'quotaHealthDescMalformedSnapshot',
    color: '#c0392b',
  },
  unsupported_version: {
    labelKey: 'quotaHealthStatusUnsupportedVersion',
    descKey: 'quotaHealthDescUnsupportedVersion',
    color: '#c0392b',
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

export const extractChannelFromUrl = (url: string): string | undefined => {
  try {
    const { hostname, pathname } = new URL(url)

    if (!hostname.endsWith('twitch.tv')) return undefined
    if (hostname !== 'twitch.tv' && hostname !== 'www.twitch.tv') return undefined

    const match = pathname.match(/^\/([^/]+)/)

    return match?.[1]?.toLowerCase()
  } catch {
    return undefined
  }
}

type ValidationStatus = 'valid' | 'invalid' | 'checking' | null

const loadSettings = async (): Promise<UserSettings> => {
  return getUserSettings()
}

const loadApiKeyPreview = async (providerId: string): Promise<string> => {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'get_api_key_preview',
      payload: { providerId },
    })) as { type: string; payload: { preview?: string } }

    return response.payload?.preview ?? ''
  } catch {
    return ''
  }
}

interface ErrorNotificationItem {
  id: string
  type: string
  message: string
  timestamp: number
}

const DIAGNOSTIC_LABELS: Record<DiagnosticStage, string> = {
  chat_container_ready: '已連上 Twitch 聊天室',
  chat_container_missing: '找不到 Twitch 聊天室容器',
  message_detected: '偵測到聊天室訊息',
  message_not_ready: '訊息尚未完成載入',
  message_skipped: '訊息已略過',
  translation_requested: '翻譯請求已送出',
  translation_received: '收到翻譯結果',
  translation_failed: '翻譯失敗',
  translation_injected: '翻譯已顯示於聊天室',
  // Privacy-safe aggregate counters (#60). Shown as a single bounded event with
  // a count; never message content, usernames, channel names, or provider data.
  batch_dedup_removed: '同批重複請求已去重',
  in_flight_coalesced: '同內容進行中請求已合併',
  queue_overflow_drop: '佇列溢位已丟棄',
  queue_obsolete_drop: '佇列過時項目已丟棄',
  // #104: persistent L2 IndexedDB cache hits, aggregated as a bounded counter.
  l2_cache_hit: '持久快取命中',
}

const isCountStage = (stage: DiagnosticStage): boolean =>
  stage === 'batch_dedup_removed'
  || stage === 'in_flight_coalesced'
  || stage === 'queue_overflow_drop'
  || stage === 'queue_obsolete_drop'
  || stage === 'l2_cache_hit'

const mergeDiagnostics = (current: DiagnosticEvent[], incoming: DiagnosticEvent[]): DiagnosticEvent[] => {
  const byId = new Map(current.map((event) => [event.id, event]))
  for (const event of incoming) byId.set(event.id, event)
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 20)
}

export function App() {
  const [settings, setSettings] = useState<UserSettings | null>(null)
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({})
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({})
  const [validationStatus, setValidationStatus] = useState<Record<string, ValidationStatus>>({})
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [blacklistInput, setBlacklistInput] = useState('')
  const [channelName, setChannelName] = useState<string | undefined>(undefined)
  const [useChannelSettings, setUseChannelSettings] = useState(false)
  const [errorNotifications, setErrorNotifications] = useState<ErrorNotificationItem[]>([])
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>([])
  const [quotaHealth, setQuotaHealth] = useState<QuotaHealthResult[]>([])
  const errorListenerRef = useRef<((message: unknown) => void) | null>(null)

  const providers = listProviderMetadata()

  /** Refreshes the quota-health panel from the Service Worker. */
  const refreshQuotaHealth = useCallback(async (): Promise<void> => {
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
        await refreshQuotaHealth()
      }
    } catch {
      // The service worker may be restarting; the next refresh shows the state.
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
      }
    }
    void loadDiagnostics()
    void refreshQuotaHealth()

    // Load API key previews for all providers
    for (const p of providers) {
      loadApiKeyPreview(p.id).then((preview) => {
        if (cancelled) return
        setApiKeyInputs((prev) => ({ ...prev, [p.id]: preview }))
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
        const current = previous.geminiQuotaProfiles[previous.selectedModel] ?? previous.geminiQuota
        const nextProfile = { ...current, [key]: value }
        return {
          ...previous,
          geminiQuota: nextProfile,
          geminiQuotaProfiles: {
            ...previous.geminiQuotaProfiles,
            [previous.selectedModel]: nextProfile,
          },
        }
      })
    },
    [],
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

  const handleProviderChange = useCallback(
    (providerId: string) => {
      const meta = providers.find((p) => p.id === providerId)
      updateSetting('selectedProvider', providerId as ProviderId)
      if (meta) {
        updateSetting('selectedModel', meta.defaultModel)
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

    const parsedBlacklist = blacklistInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const selectedGeminiQuota = settings.geminiQuotaProfiles[settings.selectedModel] ?? settings.geminiQuota
    const updatedSettings = {
      ...settings,
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
  }, [settings, blacklistInput, useChannelSettings, channelName])

  const handleValidateKey = useCallback(
    async (providerId: string) => {
      setValidationStatus((prev) => ({ ...prev, [providerId]: 'checking' }))

      // Ensure the key is saved to storage first
      const inputValue = apiKeyInputs[providerId] ?? ''
      if (inputValue.trim() && !inputValue.includes('***')) {
        await handleApiKeyChange(providerId, inputValue)
      }

      try {
        const response = (await chrome.runtime.sendMessage({
          type: 'validate_key',
          payload: { providerId },
        })) as { type: string; payload: { valid: boolean } }

        setValidationStatus((prev) => ({
          ...prev,
          [providerId]: response.payload.valid ? 'valid' : 'invalid',
        }))
      } catch {
        setValidationStatus((prev) => ({ ...prev, [providerId]: 'invalid' }))
      }
    },
    [],
  )

  const handleApiKeyChange = useCallback(
    async (providerId: string, value: string) => {
      setApiKeyInputs((prev) => ({ ...prev, [providerId]: value }))
      setValidationStatus((prev) => ({ ...prev, [providerId]: null }))

      const trimmed = value.trim()

      // Skip auto-save for masked preview values (contain "***")
      if (trimmed.includes('***')) return

      // Save or delete via SW message — Popup never reads/writes full keys directly
      if (!trimmed) {
        await chrome.runtime.sendMessage({
          type: 'delete_api_key',
          payload: { providerId },
        })
        return
      }

      await chrome.runtime.sendMessage({
        type: 'save_api_key',
        payload: { providerId, apiKey: trimmed },
      })
    },
    [],
  )

  const toggleKeyVisibility = useCallback((providerId: string) => {
    setVisibleKeys((prev) => ({ ...prev, [providerId]: !prev[providerId] }))
  }, [])

  if (!settings) {
    return <div style={{ padding: '1rem' }}>{t('loading')}</div>
  }

  const currentModels = getModelsForProvider(settings.selectedProvider)
  const currentModel = currentModels.find((model) => model.id === settings.selectedModel)
  const currentGeminiQuota = settings.geminiQuotaProfiles[settings.selectedModel] ?? settings.geminiQuota

  return (
    <div style={{ width: '320px', padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.2rem', margin: '0 0 0.5rem' }}>tachi-lens</h1>
      <p style={{ fontSize: '0.8rem', color: '#666', margin: '0 0 1rem' }}>
        {t('appDescription')}
      </p>

      {/* Channel info */}
      {channelName && (
        <div
          style={{
            marginBottom: '0.75rem',
            padding: '0.4rem 0.5rem',
            background: '#f0f0f0',
            borderRadius: '4px',
            fontSize: '0.85rem',
          }}
        >
          <span style={{ fontWeight: 600 }}>頻道：</span>
          <span>{channelName}</span>
        </div>
      )}

      {/* Per-channel settings */}
      {channelName && (
        <label
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}
        >
          <input
            type='checkbox'
            checked={useChannelSettings}
            onChange={(e) => setUseChannelSettings(e.target.checked)}
            aria-label='使用此頻道的專用設定'
          />
          <span style={{ fontSize: '0.9rem' }}>使用此頻道的專用設定</span>
        </label>
      )}

      {/* Translation enabled */}
      <label
        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}
      >
        <input
          type='checkbox'
          checked={settings.translationEnabled}
          onChange={(e) => updateSetting('translationEnabled', e.target.checked)}
          aria-label={t('enableTranslation')}
        />
        <span style={{ fontSize: '0.9rem' }}>{t('enableTranslation')}</span>
      </label>

      {/* Translation provider */}
      <div style={{ marginBottom: '0.75rem' }}>
        <label
          style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}
          htmlFor='provider-select'
        >
          {t('translationProvider')}
        </label>
        <select
          id='provider-select'
          aria-label={t('translationProvider')}
          value={settings.selectedProvider}
          onChange={(e) => handleProviderChange(e.target.value)}
          style={{ width: '100%', padding: '0.3rem' }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </div>

      {/* Model */}
      <div style={{ marginBottom: '0.75rem' }}>
        <label
          style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}
          htmlFor='model-select'
        >
          {t('model')}
        </label>
        <select
          id='model-select'
          value={settings.selectedModel}
          onChange={(e) => updateSetting('selectedModel', e.target.value)}
          style={{ width: '100%', padding: '0.3rem' }}
        >
          {currentModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
      </div>

      {settings.selectedProvider === 'gemini' && (
        <fieldset
          style={{
            margin: '0 0 0.75rem',
            padding: '0.65rem',
            border: '1px solid #d8d8d8',
            borderRadius: '4px',
          }}
        >
          <legend style={{ padding: '0 0.25rem', fontSize: '0.85rem', fontWeight: 600 }}>
            {t('geminiQuotaSection')}: {currentModel?.displayName ?? settings.selectedModel}
          </legend>
          <p style={{ margin: '0 0 0.55rem', color: '#555', fontSize: '0.75rem', lineHeight: 1.4 }}>
            {t('geminiQuotaHelp')}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            {GEMINI_QUOTA_FIELDS.map(({ key, labelKey, min, max }) => {
              const inputId = `gemini-quota-${key}`
              return (
                <label key={key} htmlFor={inputId} style={{ display: 'block', minWidth: 0 }}>
                  <span style={{ display: 'block', marginBottom: '0.2rem', color: '#333', fontSize: '0.75rem' }}>
                    {t(labelKey)}
                  </span>
                  <input
                    id={inputId}
                    type='number'
                    min={min}
                    {...(max === undefined ? {} : { max })}
                    value={currentGeminiQuota[key]}
                    onChange={(event) => {
                      const parsed = Math.floor(Number(event.target.value))
                      const bounded = Number.isFinite(parsed)
                        ? Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min, parsed))
                        : min
                      updateGeminiQuota(key, bounded)
                    }}
                    style={{ boxSizing: 'border-box', width: '100%', padding: '0.3rem' }}
                  />
                </label>
              )
            })}
          </div>
        </fieldset>
      )}

      {/* API Key */}
      <div style={{ marginBottom: '0.75rem' }}>
        <label
          style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}
          htmlFor='api-key-input'
        >
          {t('apiKey')}
        </label>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          <input
            id='api-key-input'
            type={visibleKeys[settings.selectedProvider] ? 'text' : 'password'}
            value={apiKeyInputs[settings.selectedProvider] ?? ''}
            onChange={(e) => handleApiKeyChange(settings.selectedProvider, e.target.value)}
            placeholder={t('apiKeyPlaceholder')}
            style={{ flex: 1, padding: '0.3rem', fontFamily: 'monospace' }}
          />
          <button
            onClick={() => toggleKeyVisibility(settings.selectedProvider)}
            style={{ padding: '0.3rem 0.5rem' }}
            title={visibleKeys[settings.selectedProvider] ? t('hide') : t('show')}
          >
            {visibleKeys[settings.selectedProvider] ? '🙈' : '👁️'}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
          <button
            onClick={() => handleValidateKey(settings.selectedProvider)}
            disabled={validationStatus[settings.selectedProvider] === 'checking'}
            style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
          >
            {validationStatus[settings.selectedProvider] === 'checking' ? t('validating') : t('validate')}
          </button>
          {validationStatus[settings.selectedProvider] === 'valid' && (
            <span style={{ color: 'green', fontSize: '0.8rem' }}>{t('valid')}</span>
          )}
          {validationStatus[settings.selectedProvider] === 'invalid' && (
            <span style={{ color: 'red', fontSize: '0.8rem' }}>{t('invalid')}</span>
          )}
        </div>
      </div>

      {/* Target language */}
      <div style={{ marginBottom: '0.75rem' }}>
        <label
          style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}
          htmlFor='language-select'
        >
          {t('targetLanguage')}
        </label>
        <select
          id='language-select'
          value={settings.targetLanguage}
          onChange={(e) => updateSetting('targetLanguage', e.target.value)}
          style={{ width: '100%', padding: '0.3rem' }}
        >
          <option value='zh-TW'>繁體中文</option>
          <option value='zh-CN'>簡體中文</option>
          <option value='en'>English</option>
          <option value='ja'>日本語</option>
          <option value='ko'>한국어</option>
          <option value='vi'>Tiếng Việt</option>
          <option value='th'>ภาษาไทย</option>
        </select>
      </div>

      {/* Chinese message handling */}
      {isChineseTarget(settings.targetLanguage) && (
        <fieldset
          style={{
            margin: '0 0 0.75rem',
            padding: '0.65rem',
            border: '1px solid #d8d8d8',
            borderRadius: '4px',
          }}
        >
          <legend style={{ padding: '0 0.25rem', fontSize: '0.85rem', fontWeight: 600 }}>
            {t('chineseVariantSection')}
          </legend>
          {CHINESE_VARIANT_OPTIONS.map(({ value, labelKey }) => (
            <label
              key={value}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                marginBottom: '0.3rem',
                fontSize: '0.82rem',
              }}
            >
              <input
                type='radio'
                name='chinese-variant-mode'
                value={value}
                checked={settings.chineseVariantMode === value}
                onChange={() => updateSetting('chineseVariantMode', value)}
              />
              {t(labelKey)}
            </label>
          ))}
        </fieldset>
      )}

      {/* Display modes */}
      <div style={{ marginBottom: '0.75rem' }}>
        <label
          style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}
          htmlFor='display-mode-select'
        >
          {t('displayMode')}
        </label>
        <select
          id='display-mode-select'
          value={settings.displayMode}
          onChange={(e) =>
            updateSetting('displayMode', e.target.value as UserSettings['displayMode'])
          }
          style={{ width: '100%', padding: '0.3rem' }}
        >
          <option value='below'>{t('displayBelow')}</option>
          <option value='hover'>{t('displayHover')}</option>
          <option value='collapse'>{t('displayCollapse')}</option>
        </select>
      </div>

      {/* Minimum translation length */}
      <div style={{ marginBottom: '0.75rem' }}>
        <label
          style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}
          htmlFor='min-length-input'
        >
          {t('minTextLength')}
        </label>
        <input
          id='min-length-input'
          type='number'
          min={1}
          max={100}
          value={settings.minTextLength}
          onChange={(e) =>
            updateSetting('minTextLength', Math.max(1, parseInt(e.target.value) || 1))
          }
          style={{ width: '100%', padding: '0.3rem' }}
        />
      </div>

      {/* Message filtering */}
      <div style={{ marginBottom: '0.75rem' }}>
        <div
          style={{
            fontSize: '0.85rem',
            fontWeight: 600,
            marginBottom: '0.3rem',
            color: '#444',
          }}
        >
          {t('filterSection')}
        </div>
        {FILTER_TOGGLES.map(({ key, labelKey }) => (
          <label
            key={key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              marginBottom: '0.15rem',
              fontSize: '0.82rem',
            }}
          >
            <input
              type='checkbox'
              checked={settings[key] as boolean}
              onChange={(e) => updateSetting(key, e.target.checked)}
            />
            {t(labelKey)}
          </label>
        ))}
      </div>

      {/* Bot blacklist */}
      <div style={{ marginBottom: '0.75rem' }}>
        <label
          style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem' }}
          htmlFor='blacklist-input'
        >
          {t('botBlacklist')}
        </label>
        <input
          id='blacklist-input'
          type='text'
          value={blacklistInput}
          onChange={(e) => setBlacklistInput(e.target.value)}
          placeholder={t('botBlacklistPlaceholder')}
          style={{ width: '100%', padding: '0.3rem' }}
        />
      </div>

      {/* Speech subtitles (v0.3): capture/consent is owned by a later Issue. */}
      <fieldset
        style={{
          margin: '0 0 0.75rem',
          padding: '0.65rem',
          border: '1px solid #d8d8d8',
          borderRadius: '4px',
        }}
      >
        <legend style={{ padding: '0 0.25rem', fontSize: '0.85rem', fontWeight: 600 }}>
          {t('speechSection')}
        </legend>

        <label
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}
        >
          <input
            type='checkbox'
            checked={settings.speechConfig.speechEnabled}
            onChange={(e) => updateSpeechConfig('speechEnabled', e.target.checked)}
            aria-label={t('speechEnabled')}
          />
          <span style={{ fontSize: '0.9rem' }}>{t('speechEnabled')}</span>
        </label>

        <div style={{ marginBottom: '0.5rem' }}>
          <label
            style={{ display: 'block', fontSize: '0.75rem', marginBottom: '0.25rem', color: '#333' }}
            htmlFor='speech-provider-select'
          >
            {t('speechProvider')}
          </label>
          <select
            id='speech-provider-select'
            value={settings.speechConfig.speechProvider}
            onChange={(e) => updateSpeechConfig('speechProvider', e.target.value as SpeechProviderId)}
            style={{ width: '100%', padding: '0.3rem' }}
          >
            {SPEECH_PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {id === 'gemini' ? 'Gemini' : id}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '0.5rem' }}>
          <label
            style={{ display: 'block', fontSize: '0.75rem', marginBottom: '0.25rem', color: '#333' }}
            htmlFor='speech-model-select'
          >
            {t('speechModel')}
          </label>
          <select
            id='speech-model-select'
            value={settings.speechConfig.speechModel}
            onChange={(e) => updateSpeechConfig('speechModel', e.target.value)}
            style={{ width: '100%', padding: '0.3rem' }}
          >
            {SPEECH_GEMINI_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '0.5rem' }}>
          <label
            style={{ display: 'block', fontSize: '0.75rem', marginBottom: '0.25rem', color: '#333' }}
            htmlFor='speech-language-select'
          >
            {t('speechTargetLanguage')}
          </label>
          <select
            id='speech-language-select'
            value={settings.speechConfig.speechTargetLanguage}
            onChange={(e) => updateSpeechConfig('speechTargetLanguage', e.target.value)}
            style={{ width: '100%', padding: '0.3rem' }}
          >
            {SPEECH_LANGUAGE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: '0.5rem' }}>
          <label
            style={{ display: 'block', fontSize: '0.75rem', marginBottom: '0.25rem', color: '#333' }}
            htmlFor='speech-caption-lines-input'
          >
            {t('speechCaptionMaxLines')}
          </label>
          <input
            id='speech-caption-lines-input'
            type='number'
            min={1}
            value={settings.speechConfig.captionMaxLines}
            onChange={(e) =>
              updateSpeechConfig('captionMaxLines', Math.max(1, parseInt(e.target.value) || 1))
            }
            style={{ boxSizing: 'border-box', width: '100%', padding: '0.3rem' }}
          />
        </div>

        <div style={{ marginBottom: '0.5rem' }}>
          <label
            style={{ display: 'block', fontSize: '0.75rem', marginBottom: '0.25rem', color: '#333' }}
            htmlFor='speech-caption-opacity-input'
          >
            {t('speechCaptionOpacity')}
          </label>
          <input
            id='speech-caption-opacity-input'
            type='number'
            min={0}
            max={100}
            value={settings.speechConfig.captionOpacity}
            onChange={(e) => {
              const parsed = parseInt(e.target.value)
              const bounded = Number.isFinite(parsed)
                ? Math.min(100, Math.max(0, parsed))
                : 0
              updateSpeechConfig('captionOpacity', bounded)
            }}
            style={{ boxSizing: 'border-box', width: '100%', padding: '0.3rem' }}
          />
        </div>

        <div style={{ marginBottom: '0.25rem' }}>
          <label
            style={{ display: 'block', fontSize: '0.75rem', marginBottom: '0.25rem', color: '#333' }}
            htmlFor='speech-session-budget-input'
          >
            {t('speechMaxSessionMinutes')}
          </label>
          <input
            id='speech-session-budget-input'
            type='number'
            min={1}
            value={settings.speechConfig.maxSessionMinutes}
            onChange={(e) =>
              updateSpeechConfig('maxSessionMinutes', Math.max(1, parseInt(e.target.value) || 1))
            }
            style={{ boxSizing: 'border-box', width: '100%', padding: '0.3rem' }}
          />
        </div>
      </fieldset>

      {/* Save */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <button
          onClick={handleSave}
          style={{
            padding: '0.4rem 1rem',
            fontSize: '0.9rem',
            cursor: 'pointer',
          }}
        >
          {t('saveSettings')}
        </button>
        {saveMessage && (
          <span style={{ color: 'green', fontSize: '0.85rem' }}>{t('settingsSaved')}</span>
        )}
      </div>

      {/* Error notification area */}
      {errorNotifications.length > 0 && (
        <div style={{ marginTop: '1rem', borderTop: '1px solid #eee', paddingTop: '0.5rem' }}>
          <h3 style={{ fontSize: '0.85rem', margin: '0 0 0.5rem', color: '#666' }}>
            {t('errorNotificationTitle')}
          </h3>
          {errorNotifications.map((n) => (
            <div
              key={n.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.25rem',
                padding: '0.25rem 0',
                fontSize: '0.8rem',
                color: '#c0392b',
                wordBreak: 'break-word',
              }}
            >
              <span style={{ flex: 1 }}>{n.message}</span>
              <button
                onClick={() => dismissError(n.id)}
                style={{
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  padding: '0',
                  fontSize: '0.8rem',
                  color: '#999',
                  lineHeight: 1,
                }}
                aria-label={t('dismiss')}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Gemini quota health */}
      {quotaHealth.length > 0 && (
        <section style={{ marginTop: '1rem', borderTop: '1px solid #eee', paddingTop: '0.75rem' }}>
          <h2 style={{ fontSize: '0.9rem', margin: '0 0 0.3rem', color: '#333' }}>
            {t('quotaHealthSection')}
          </h2>
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {quotaHealth.map((result) => {
              const meta = QUOTA_HEALTH_STATUS_META[result.status]
              const integrity = INTEGRITY_STATUSES.has(result.status)
              return (
                <div
                  key={result.quotaKey}
                  style={{
                    padding: '0.4rem 0.5rem',
                    border: `1px solid ${meta.color}`,
                    borderRadius: '4px',
                    fontSize: '0.8rem',
                    color: '#333',
                  }}
                >
                  <div style={{ fontWeight: 600, color: meta.color }}>
                    {`${result.quotaKey}：${t(meta.labelKey)}`}
                  </div>
                  <div style={{ marginTop: '0.15rem', color: '#555', lineHeight: 1.4 }}>
                    {t(meta.descKey)}
                  </div>
                  {result.denialReason && (
                    <div style={{ marginTop: '0.15rem', color: '#666' }}>
                      {t('quotaHealthDenialPrefix')}：{t(QUOTA_HEALTH_DENIAL_LABELS[result.denialReason])}
                    </div>
                  )}
                  {result.providerDay && (
                    <div style={{ marginTop: '0.15rem', color: '#666' }}>
                      {t('quotaHealthProviderDay')}：{result.providerDay}
                    </div>
                  )}
                  {result.cooldownUntil !== undefined && (
                    <div style={{ marginTop: '0.15rem', color: '#666' }}>
                      {t('quotaHealthCooldownUntil')}：{formatInstant(result.cooldownUntil)}
                    </div>
                  )}
                  {result.recoveryAt !== undefined && (
                    <div style={{ marginTop: '0.15rem', color: '#666' }}>
                      {t('quotaHealthRecoveryAt')}：{formatInstant(result.recoveryAt)}
                    </div>
                  )}
                  {integrity && (
                    <div style={{ marginTop: '0.3rem', color: '#2e7d32', fontSize: '0.78rem' }}>
                      {t('quotaHealthDeepSeekOverflow')}
                    </div>
                  )}
                  {REPAIRABLE_STATUSES.has(result.status) && (
                    <button
                      type="button"
                      onClick={() => void handleResetQuota(result.quotaKey)}
                      style={{
                        marginTop: '0.35rem',
                        padding: '0.2rem 0.5rem',
                        fontSize: '0.75rem',
                        border: '1px solid #c0392b',
                        borderRadius: '4px',
                        background: confirmingReset[result.quotaKey] ? '#c0392b' : 'transparent',
                        color: confirmingReset[result.quotaKey] ? '#fff' : '#c0392b',
                        cursor: 'pointer',
                      }}
                    >
                      {confirmingReset[result.quotaKey]
                        ? t('quotaHealthRepairConfirm')
                        : t('quotaHealthRepair')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      <section style={{ marginTop: '1rem', borderTop: '1px solid #eee', paddingTop: '0.75rem' }}>
        <h2 style={{ fontSize: '0.9rem', margin: '0 0 0.3rem', color: '#333' }}>診斷</h2>
        {diagnostics.length === 0 ? (
          <p style={{ margin: 0, color: '#666', fontSize: '0.8rem' }}>尚未收到診斷事件。請在 Twitch 聊天室等待一則新訊息。</p>
        ) : (
          <div style={{ display: 'grid', gap: '0.35rem' }}>
            {diagnostics.slice(0, 5).map((event) => (
              <div key={event.id} style={{ fontSize: '0.8rem', color: '#444', wordBreak: 'break-word' }}>
                <strong>{DIAGNOSTIC_LABELS[event.stage]}</strong>
                {isCountStage(event.stage) && typeof event.count === 'number'
                  ? <span style={{ color: '#666' }}>：{event.count}</span>
                  : event.detail && <span style={{ color: '#666' }}>：{event.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Shortcut info */}
      <div
        style={{
          marginTop: '1rem',
          paddingTop: '0.75rem',
          borderTop: '1px solid #eee',
          fontSize: '0.75rem',
          color: '#999',
        }}
      >
        <div>{t('shortcutToggleTranslation')}</div>
        <div>{t('shortcutToggleDisplayMode')}</div>
      </div>
    </div>
  )
}
