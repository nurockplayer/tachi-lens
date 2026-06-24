import { useCallback, useEffect, useRef, useState } from 'react'
import { listProviderMetadata } from '@/providers/registry'
import type { ProviderId } from '@/providers/types'
import { DEFAULT_SETTINGS, maskApiKey } from '@/storage/settings'
import type { UserSettings } from '@/storage/settings'
import { t } from '@/shared/i18n'
import type { ErrorNotification } from '@/shared/messages'

type ValidationStatus = 'valid' | 'invalid' | 'checking' | null

const STORAGE_KEY = 'userSettings'

const loadSettings = async (): Promise<UserSettings> => {
  const items = await chrome.storage.local.get(STORAGE_KEY)
  const stored = items[STORAGE_KEY] as Partial<UserSettings> | undefined

  return { ...DEFAULT_SETTINGS, ...stored }
}

const loadApiKeyPreview = async (providerId: string): Promise<string> => {
  const items = await chrome.storage.local.get('providerApiKeyPreviews')
  const previews = items.providerApiKeyPreviews as Record<string, string> | undefined

  return previews?.[providerId] ?? ''
}

interface ErrorNotificationItem {
  id: string
  type: string
  message: string
  timestamp: number
}

export function App() {
  const [settings, setSettings] = useState<UserSettings | null>(null)
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({})
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({})
  const [validationStatus, setValidationStatus] = useState<Record<string, ValidationStatus>>({})
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [blacklistInput, setBlacklistInput] = useState('')
  const [errorNotifications, setErrorNotifications] = useState<ErrorNotificationItem[]>([])
  const errorListenerRef = useRef<((message: unknown) => void) | null>(null)

  const providers = listProviderMetadata()

  useEffect(() => {
    let cancelled = false

    loadSettings().then((s) => {
      if (cancelled) return
      setSettings(s)
      setBlacklistInput(s.botNameBlacklist.join(', '))
    })
    // Load API key previews for all providers
    for (const p of providers) {
      loadApiKeyPreview(p.id).then((preview) => {
        if (cancelled) return
        setApiKeyInputs((prev) => ({ ...prev, [p.id]: preview }))
      })
    }

    // Listen for error notifications from service worker
    const handleErrorNotification = (message: unknown) => {
      const msg = message as { type?: string; payload?: ErrorNotification } | undefined
      if (msg?.type === 'error_notification' && msg.payload) {
        const { id, type, message: errMsg, timestamp } = msg.payload
        setErrorNotifications((prev) => [
          { id, type, message: errMsg, timestamp },
          ...prev.slice(0, 19), // keep max 20 notifications
        ])
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

    const updatedSettings = { ...settings, botNameBlacklist: parsedBlacklist }

    await chrome.storage.local.set({ [STORAGE_KEY]: updatedSettings })
    setSettings(updatedSettings)
    setSaveMessage(t('settingsSaved'))
    setTimeout(() => setSaveMessage(null), 2000)
  }, [settings, blacklistInput])

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

      if (!trimmed) {
        // Delete key when input is cleared
        const oldKeys = await chrome.storage.local.get('providerApiKeys')
        const keys = { ...(oldKeys.providerApiKeys as Record<string, string> | undefined) }
        const oldPreviews = await chrome.storage.local.get('providerApiKeyPreviews')
        const previews = { ...(oldPreviews.providerApiKeyPreviews as Record<string, string> | undefined) }

        delete keys[providerId]
        delete previews[providerId]
        await chrome.storage.local.set({ providerApiKeys: keys, providerApiKeyPreviews: previews })
        return
      }

      // Auto-save real API key on change
      const items = await chrome.storage.local.get('providerApiKeys')
      const keys = items.providerApiKeys as Record<string, string> | undefined
      const previewItems = await chrome.storage.local.get('providerApiKeyPreviews')
      const previews = previewItems.providerApiKeyPreviews as Record<string, string> | undefined

      await chrome.storage.local.set({
        providerApiKeys: { ...keys, [providerId]: trimmed },
        providerApiKeyPreviews: { ...previews, [providerId]: maskApiKey(trimmed) },
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

  return (
    <div style={{ width: '320px', padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.2rem', margin: '0 0 0.5rem' }}>tachi-lens</h1>
      <p style={{ fontSize: '0.8rem', color: '#666', margin: '0 0 1rem' }}>
        {t('appDescription')}
      </p>

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
          <span style={{ color: 'green', fontSize: '0.85rem' }}>{saveMessage}</span>
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
    </div>
  )
}
