import { useCallback, useEffect, useRef, useState } from 'react'
import { listProviderMetadata } from '@/providers/registry'
import type { ProviderId } from '@/providers/types'
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
import { isDiagnosticEventMessage } from '@/shared/messages'
import type { DiagnosticEvent, DiagnosticStage, ErrorNotification, SettingsUpdatePayload } from '@/shared/messages'
import type { FilterConfig } from '@/content/message-filter'

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
}

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
  const errorListenerRef = useRef<((message: unknown) => void) | null>(null)

  const providers = listProviderMetadata()

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
        ...channelSettings
      } = updatedSettings
      await saveUserSettings({ geminiQuota, geminiQuotaProfiles })
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

      {/* 頻道資訊 */}
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

      {/* 每頻道設定 */}
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

      {/* 翻譯啟用 */}
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

      {/* 翻譯提供者 */}
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

      {/* 目標語言 */}
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

      {/* 顯示模式 */}
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

      {/* 最短翻譯長度 */}
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

      {/* 訊息過濾 */}
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

      {/* Bot 黑名單 */}
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

      {/* 儲存 */}
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

      {/* 錯誤通知區 */}
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

      <section style={{ marginTop: '1rem', borderTop: '1px solid #eee', paddingTop: '0.75rem' }}>
        <h2 style={{ fontSize: '0.9rem', margin: '0 0 0.3rem', color: '#333' }}>診斷</h2>
        {diagnostics.length === 0 ? (
          <p style={{ margin: 0, color: '#666', fontSize: '0.8rem' }}>尚未收到診斷事件。請在 Twitch 聊天室等待一則新訊息。</p>
        ) : (
          <div style={{ display: 'grid', gap: '0.35rem' }}>
            {diagnostics.slice(0, 5).map((event) => (
              <div key={event.id} style={{ fontSize: '0.8rem', color: '#444', wordBreak: 'break-word' }}>
                <strong>{DIAGNOSTIC_LABELS[event.stage]}</strong>
                {event.detail && <span style={{ color: '#666' }}>：{event.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 快捷鍵資訊 */}
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
