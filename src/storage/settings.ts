// Chrome storage wrapper — settings and API key management
// Only Service Worker reads complete keys; Popup only sees masked versions.

import type { FilterConfig } from '@/content/message-filter'
import { DEFAULT_FILTER_CONFIG } from '@/content/message-filter'
import { AUTO_MODEL } from '@/providers/model-policy'
import type { ProviderId } from '@/providers/types'
import { GEMINI_MODELS } from '@/providers/gemini'
import { DEEPSEEK_DEFAULT_MODEL } from '@/providers/deepseek'
import {
  DEFAULT_GEMINI_QUOTA,
  normalizeGeminiQuotaSettings,
  type GeminiQuotaSettings,
} from '@/background/gemini-quota'
import { isSpeechProviderId } from '@/providers/speech-types'
import type { SpeechProviderId, SpeechTranslationConfig } from '@/providers/speech-types'
import type { ChineseVariantMode } from '@/shared/language-detection'

export interface StorageAreaLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
  setAccessLevel(options: { accessLevel: string }): Promise<void>
}

export interface ChromeStorageLike {
  AccessLevel: {
    TRUSTED_CONTEXTS: string
  }
  local: StorageAreaLike
  session: StorageAreaLike
}

export interface UserSettings extends FilterConfig {
  selectedProvider: ProviderId
  selectedModel: string
  targetLanguage: string
  displayMode: 'below' | 'hover' | 'collapse'
  chineseVariantMode: ChineseVariantMode
  botNameBlacklist: string[]
  minTextLength: number
  translationEnabled: boolean
  filterConfig: FilterConfig
  geminiQuota: GeminiQuotaSettings
  geminiQuotaProfiles: Record<string, GeminiQuotaSettings>
  /** v0.3 speech config — global-only, independent of chat settings (Spec §5). */
  speechConfig: SpeechTranslationConfig
}

export const DEFAULT_SPEECH_CONFIG: SpeechTranslationConfig = {
  speechEnabled: false,
  speechConsentGranted: false,
  speechProvider: 'gemini',
  speechModel: AUTO_MODEL,
  speechTargetLanguage: 'zh-TW',
  captionMaxLines: 2,
  captionOpacity: 100,
  maxSessionMinutes: 30,
}

export const DEFAULT_GEMINI_QUOTA_PROFILES: Record<string, GeminiQuotaSettings> =
  Object.fromEntries(GEMINI_MODELS.map(({ id }) => [id, { ...DEFAULT_GEMINI_QUOTA }]))

export const DEFAULT_SETTINGS: UserSettings = {
  ...DEFAULT_FILTER_CONFIG,
  selectedProvider: 'deepseek',
  selectedModel: AUTO_MODEL,
  targetLanguage: 'zh-TW',
  displayMode: 'below',
  chineseVariantMode: 'skip_all_chinese',
  botNameBlacklist: [],
  minTextLength: 2,
  translationEnabled: true,
  filterConfig: DEFAULT_FILTER_CONFIG,
  geminiQuota: DEFAULT_GEMINI_QUOTA,
  geminiQuotaProfiles: DEFAULT_GEMINI_QUOTA_PROFILES,
  speechConfig: DEFAULT_SPEECH_CONFIG,
}

export interface RuntimeState {
  activeProvider?: ProviderId
  validationInProgress?: boolean
  lastValidationError?: string
}

const LEGACY_DEEPSEEK_FLASH_MODEL = 'deepseek-v4-flash'

const normalizeSelectedModel = (provider: unknown, model: unknown): string => {
  const candidate = typeof model === 'string' && model.trim()
    ? model.trim()
    : DEFAULT_SETTINGS.selectedModel

  return provider === 'deepseek' && candidate === LEGACY_DEEPSEEK_FLASH_MODEL
    ? DEEPSEEK_DEFAULT_MODEL
    : candidate
}

export const USER_SETTINGS_STORAGE_KEY = 'userSettings'
export const API_KEYS_STORAGE_KEY = 'providerApiKeys'
export const API_KEY_PREVIEWS_STORAGE_KEY = 'providerApiKeyPreviews'
export const SPEECH_API_KEYS_STORAGE_KEY = 'speechProviderApiKeys'
export const SPEECH_API_KEY_PREVIEWS_STORAGE_KEY = 'speechProviderApiKeyPreviews'
export const SPEECH_CREDENTIAL_OVERRIDES_STORAGE_KEY = 'speechProviderApiKeyOverrides'
export const SPEECH_CREDENTIAL_OVERRIDE_PREVIEWS_STORAGE_KEY = 'speechProviderApiKeyOverridePreviews'
export const RUNTIME_STATE_STORAGE_KEY = 'runtimeState'
export const PER_CHANNEL_SETTINGS_STORAGE_KEY = 'perChannelSettings'

export type PerChannelSettings = Record<string, Partial<UserSettings>>

type ApiKeyMap = Partial<Record<ProviderId, string>>
type ApiKeyPreviewMap = Partial<Record<ProviderId, string>>
type SpeechApiKeyMap = Partial<Record<SpeechProviderId, string>>
type SpeechApiKeyPreviewMap = Partial<Record<SpeechProviderId, string>>

const getDefaultStorage = (): ChromeStorageLike => chrome.storage

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const normalizeChineseVariantMode = (value: unknown): ChineseVariantMode =>
  value === 'skip_all_chinese' || value === 'translate_other_script'
    ? value
    : DEFAULT_SETTINGS.chineseVariantMode

export const normalizeGeminiQuotaProfiles = (
  value: unknown,
  legacyProfile: GeminiQuotaSettings = DEFAULT_GEMINI_QUOTA,
): Record<string, GeminiQuotaSettings> => {
  const storedProfiles = isRecord(value) ? value : {}
  const modelIds = new Set([
    ...GEMINI_MODELS.map(({ id }) => id),
    ...Object.keys(storedProfiles),
  ])

  return Object.fromEntries(Array.from(modelIds, (modelId) => {
    const candidate = storedProfiles[modelId]
    const merged = isRecord(candidate)
      ? { ...legacyProfile, ...candidate }
      : legacyProfile
    return [modelId, normalizeGeminiQuotaSettings(merged)]
  }))
}

const clampInt = (value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback

/**
 * Storage-boundary guard for the v0.3 speech config. Rejects unknown providers,
 * clamps captionMaxLines to >=1, captionOpacity to 0..100, and maxSessionMinutes
 * to >=1. Mirrors the normalizeChineseVariantMode / normalizeGeminiQuotaProfiles
 * pattern (Spec §5).
 */
export const normalizeSpeechConfig = (value: unknown): SpeechTranslationConfig => {
  const candidate = isRecord(value) ? value : {}

  return {
    speechEnabled: candidate.speechEnabled === true,
    speechConsentGranted: candidate.speechConsentGranted === true,
    speechProvider: typeof candidate.speechProvider === 'string' && isSpeechProviderId(candidate.speechProvider)
      ? candidate.speechProvider
      : DEFAULT_SPEECH_CONFIG.speechProvider,
    speechModel: typeof candidate.speechModel === 'string' && candidate.speechModel.trim()
      ? candidate.speechModel.trim()
      : DEFAULT_SPEECH_CONFIG.speechModel,
    speechTargetLanguage: typeof candidate.speechTargetLanguage === 'string' && candidate.speechTargetLanguage.trim()
      ? candidate.speechTargetLanguage.trim()
      : DEFAULT_SPEECH_CONFIG.speechTargetLanguage,
    captionMaxLines: clampInt(candidate.captionMaxLines, DEFAULT_SPEECH_CONFIG.captionMaxLines, 1),
    captionOpacity: clampInt(candidate.captionOpacity, DEFAULT_SPEECH_CONFIG.captionOpacity, 0, 100),
    maxSessionMinutes: clampInt(candidate.maxSessionMinutes, DEFAULT_SPEECH_CONFIG.maxSessionMinutes, 1),
  }
}

const readRecord = async (area: StorageAreaLike, key: string): Promise<Record<string, unknown>> => {
  const items = await area.get(key)
  const value = items[key]

  return isRecord(value) ? value : {}
}

const readApiKeys = async (storage: ChromeStorageLike): Promise<ApiKeyMap> =>
  readRecord(storage.local, API_KEYS_STORAGE_KEY) as ApiKeyMap

const readApiKeyPreviews = async (storage: ChromeStorageLike): Promise<ApiKeyPreviewMap> =>
  readRecord(storage.local, API_KEY_PREVIEWS_STORAGE_KEY) as ApiKeyPreviewMap

export const initializeStorageAccess = async (storage = getDefaultStorage()): Promise<void> => {
  const accessLevel = storage.AccessLevel.TRUSTED_CONTEXTS

  await Promise.all([
    storage.local.setAccessLevel({ accessLevel }),
    storage.session.setAccessLevel({ accessLevel }),
  ])
  await migrateSpeechCredentials(storage)
}

export const getUserSettings = async (storage = getDefaultStorage()): Promise<UserSettings> => {
  const storedSettings = await readRecord(storage.local, USER_SETTINGS_STORAGE_KEY)
  const geminiQuota = normalizeGeminiQuotaSettings(storedSettings.geminiQuota)
  const mergedSettings = { ...DEFAULT_SETTINGS, ...storedSettings }

  return {
    ...mergedSettings,
    selectedModel: normalizeSelectedModel(mergedSettings.selectedProvider, mergedSettings.selectedModel),
    chineseVariantMode: normalizeChineseVariantMode(storedSettings.chineseVariantMode),
    geminiQuota,
    geminiQuotaProfiles: normalizeGeminiQuotaProfiles(storedSettings.geminiQuotaProfiles, geminiQuota),
    speechConfig: normalizeSpeechConfig(storedSettings.speechConfig),
  }
}

export const saveUserSettings = async (
  updates: Partial<UserSettings>,
  storage = getDefaultStorage(),
): Promise<UserSettings> => {
  const mergedSettings = {
    ...(await getUserSettings(storage)),
    ...updates,
  }
  const geminiQuota = normalizeGeminiQuotaSettings(mergedSettings.geminiQuota)
  const profilesSource = updates.geminiQuotaProfiles ?? mergedSettings.geminiQuotaProfiles
  const nextSettings = {
    ...mergedSettings,
    selectedModel: normalizeSelectedModel(mergedSettings.selectedProvider, mergedSettings.selectedModel),
    chineseVariantMode: normalizeChineseVariantMode(mergedSettings.chineseVariantMode),
    geminiQuota,
    geminiQuotaProfiles: normalizeGeminiQuotaProfiles(profilesSource, geminiQuota),
    speechConfig: normalizeSpeechConfig(mergedSettings.speechConfig),
  }

  await storage.local.set({ [USER_SETTINGS_STORAGE_KEY]: nextSettings })

  return nextSettings
}

export const maskApiKey = (apiKey: string): string => {
  if (apiKey.length <= 7) {
    return '*'.repeat(apiKey.length)
  }

  const prefix = apiKey.slice(0, 3)
  const suffix = apiKey.slice(-4)
  const maskedLength = apiKey.length - prefix.length - suffix.length

  return `${prefix}${'*'.repeat(maskedLength)}${suffix}`
}

export const saveApiKey = async (
  providerId: ProviderId,
  apiKey: string,
  storage = getDefaultStorage(),
): Promise<void> => {
  await migrateSpeechCredentials(storage)
  const normalizedKey = apiKey.trim()

  if (!normalizedKey) {
    await deleteApiKey(providerId, storage)
    return
  }

  const apiKeys = await readApiKeys(storage)
  const apiKeyPreviews = await readApiKeyPreviews(storage)

  await storage.local.set({
    [API_KEYS_STORAGE_KEY]: {
      ...apiKeys,
      [providerId]: normalizedKey,
    },
    [API_KEY_PREVIEWS_STORAGE_KEY]: {
      ...apiKeyPreviews,
      [providerId]: maskApiKey(normalizedKey),
    },
  })
}

export const rotateApiKey = saveApiKey

export const deleteApiKey = async (providerId: ProviderId, storage = getDefaultStorage()): Promise<void> => {
  await migrateSpeechCredentials(storage)
  const apiKeys = await readApiKeys(storage)
  const apiKeyPreviews = await readApiKeyPreviews(storage)

  delete apiKeys[providerId]
  delete apiKeyPreviews[providerId]

  await storage.local.set({
    [API_KEYS_STORAGE_KEY]: apiKeys,
    [API_KEY_PREVIEWS_STORAGE_KEY]: apiKeyPreviews,
  })
}

export const getApiKeyForServiceWorker = async (
  providerId: ProviderId,
  storage = getDefaultStorage(),
): Promise<string | undefined> => {
  await migrateSpeechCredentials(storage)
  const apiKeys = await readApiKeys(storage)
  const apiKey = apiKeys[providerId]

  return hasCredential(apiKey) ? apiKey : undefined
}

export const getMaskedApiKeyForPopup = async (
  providerId: ProviderId,
  storage = getDefaultStorage(),
): Promise<string | undefined> => {
  await migrateSpeechCredentials(storage)
  const apiKeys = await readApiKeys(storage)
  const apiKey = apiKeys[providerId]

  return hasCredential(apiKey) ? maskApiKey(apiKey) : undefined
}

const readSpeechCredentialOverrides = async (storage: ChromeStorageLike): Promise<SpeechApiKeyMap> =>
  readRecord(storage.local, SPEECH_CREDENTIAL_OVERRIDES_STORAGE_KEY) as SpeechApiKeyMap

const readSpeechCredentialOverridePreviews = async (storage: ChromeStorageLike): Promise<SpeechApiKeyPreviewMap> =>
  readRecord(storage.local, SPEECH_CREDENTIAL_OVERRIDE_PREVIEWS_STORAGE_KEY) as SpeechApiKeyPreviewMap

const credentialMigrations = new WeakMap<StorageAreaLike, Promise<void>>()

const hasCredential = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const migrateSpeechCredentialsOnce = async (storage: ChromeStorageLike): Promise<void> => {
  const legacyItems = await storage.local.get([SPEECH_API_KEYS_STORAGE_KEY, SPEECH_API_KEY_PREVIEWS_STORAGE_KEY])
  const legacyKeys = isRecord(legacyItems[SPEECH_API_KEYS_STORAGE_KEY])
    ? legacyItems[SPEECH_API_KEYS_STORAGE_KEY] as Record<string, unknown>
    : {}
  const hasLegacyState = legacyItems[SPEECH_API_KEYS_STORAGE_KEY] !== undefined ||
    legacyItems[SPEECH_API_KEY_PREVIEWS_STORAGE_KEY] !== undefined
  if (!hasLegacyState) return

  const sharedKeys = await readApiKeys(storage)
  const sharedPreviews = await readApiKeyPreviews(storage)
  const overrides = await readSpeechCredentialOverrides(storage)
  const overridePreviews = await readSpeechCredentialOverridePreviews(storage)

  for (const [providerId, legacyKey] of Object.entries(legacyKeys)) {
    if (!hasCredential(legacyKey)) continue
    const sharedKey = sharedKeys[providerId as ProviderId]
    if (!hasCredential(sharedKey)) {
      sharedKeys[providerId as ProviderId] = legacyKey
      sharedPreviews[providerId as ProviderId] = maskApiKey(legacyKey)
    } else if (sharedKey !== legacyKey && !hasCredential(overrides[providerId as SpeechProviderId])) {
      overrides[providerId as SpeechProviderId] = legacyKey
      overridePreviews[providerId as SpeechProviderId] = maskApiKey(legacyKey)
    }
  }

  await storage.local.set({
    [API_KEYS_STORAGE_KEY]: sharedKeys,
    [API_KEY_PREVIEWS_STORAGE_KEY]: sharedPreviews,
    [SPEECH_CREDENTIAL_OVERRIDES_STORAGE_KEY]: overrides,
    [SPEECH_CREDENTIAL_OVERRIDE_PREVIEWS_STORAGE_KEY]: overridePreviews,
  })

  // Chrome storage has no transaction API. Read back every replacement map
  // before removing legacy secrets so a partial write remains recoverable.
  const persisted = await storage.local.get([
    API_KEYS_STORAGE_KEY,
    API_KEY_PREVIEWS_STORAGE_KEY,
    SPEECH_CREDENTIAL_OVERRIDES_STORAGE_KEY,
    SPEECH_CREDENTIAL_OVERRIDE_PREVIEWS_STORAGE_KEY,
  ])
  const persistedShared = persisted[API_KEYS_STORAGE_KEY]
  const persistedSharedPreviews = persisted[API_KEY_PREVIEWS_STORAGE_KEY]
  const persistedOverrides = persisted[SPEECH_CREDENTIAL_OVERRIDES_STORAGE_KEY]
  const persistedOverridePreviews = persisted[SPEECH_CREDENTIAL_OVERRIDE_PREVIEWS_STORAGE_KEY]
  if (!isRecord(persistedShared) || !isRecord(persistedSharedPreviews) ||
      !isRecord(persistedOverrides) || !isRecord(persistedOverridePreviews)) {
    throw new Error('Credential migration could not verify replacement storage')
  }
  for (const [providerId, legacyKey] of Object.entries(legacyKeys)) {
    if (!hasCredential(legacyKey)) continue
    const sharedKey = sharedKeys[providerId as ProviderId]
    const replacement = hasCredential(sharedKey) && sharedKey !== legacyKey
      ? persistedOverrides[providerId]
      : persistedShared[providerId]
    if (replacement !== legacyKey) {
      throw new Error('Credential migration could not verify replacement storage')
    }
  }

  await storage.local.remove([SPEECH_API_KEYS_STORAGE_KEY, SPEECH_API_KEY_PREVIEWS_STORAGE_KEY])
}

export const migrateSpeechCredentials = async (storage = getDefaultStorage()): Promise<void> => {
  const area = storage.local
  const current = credentialMigrations.get(area)
  if (current) return current

  const migration = migrateSpeechCredentialsOnce(storage)
  credentialMigrations.set(area, migration)
  try {
    await migration
  } catch (error) {
    credentialMigrations.delete(area)
    throw error
  }
}

export const saveSpeechApiKeyOverride = async (
  providerId: SpeechProviderId,
  apiKey: string,
  storage = getDefaultStorage(),
): Promise<void> => {
  await migrateSpeechCredentials(storage)
  const normalizedKey = apiKey.trim()

  if (!normalizedKey) {
    await deleteSpeechApiKeyOverride(providerId, storage)
    return
  }

  const speechApiKeys = await readSpeechCredentialOverrides(storage)
  const speechApiKeyPreviews = await readSpeechCredentialOverridePreviews(storage)

  await storage.local.set({
    [SPEECH_CREDENTIAL_OVERRIDES_STORAGE_KEY]: {
      ...speechApiKeys,
      [providerId]: normalizedKey,
    },
    [SPEECH_CREDENTIAL_OVERRIDE_PREVIEWS_STORAGE_KEY]: {
      ...speechApiKeyPreviews,
      [providerId]: maskApiKey(normalizedKey),
    },
  })
}

export const deleteSpeechApiKeyOverride = async (
  providerId: SpeechProviderId,
  storage = getDefaultStorage(),
): Promise<void> => {
  await migrateSpeechCredentials(storage)
  const speechApiKeys = await readSpeechCredentialOverrides(storage)
  const speechApiKeyPreviews = await readSpeechCredentialOverridePreviews(storage)

  delete speechApiKeys[providerId]
  delete speechApiKeyPreviews[providerId]

  await storage.local.set({
    [SPEECH_CREDENTIAL_OVERRIDES_STORAGE_KEY]: speechApiKeys,
    [SPEECH_CREDENTIAL_OVERRIDE_PREVIEWS_STORAGE_KEY]: speechApiKeyPreviews,
  })
}

export const getSpeechApiKeyForServiceWorker = async (
  providerId: SpeechProviderId,
  storage = getDefaultStorage(),
): Promise<string | undefined> => {
  await migrateSpeechCredentials(storage)
  const speechApiKeys = await readSpeechCredentialOverrides(storage)
  const sharedApiKeys = await readApiKeys(storage)

  const override = speechApiKeys[providerId]
  if (hasCredential(override)) return override
  const shared = sharedApiKeys[providerId]
  return hasCredential(shared) ? shared : undefined
}

export const getSpeechApiKeyOverrideForServiceWorker = async (
  providerId: SpeechProviderId,
  storage = getDefaultStorage(),
): Promise<string | undefined> => {
  await migrateSpeechCredentials(storage)
  const speechApiKeys = await readSpeechCredentialOverrides(storage)

  const apiKey = speechApiKeys[providerId]

  return hasCredential(apiKey) ? apiKey : undefined
}

/** @deprecated Prefer the explicit override name. */
export const saveSpeechApiKey = saveSpeechApiKeyOverride
/** @deprecated Prefer the explicit override name. */
export const deleteSpeechApiKey = deleteSpeechApiKeyOverride

export const getMaskedSpeechApiKeyForPopup = async (
  providerId: SpeechProviderId,
  storage = getDefaultStorage(),
): Promise<string | undefined> => {
  await migrateSpeechCredentials(storage)
  const speechApiKeys = await readSpeechCredentialOverrides(storage)
  const apiKey = speechApiKeys[providerId]

  return hasCredential(apiKey) ? maskApiKey(apiKey) : undefined
}

export const saveRuntimeState = async (
  runtimeState: RuntimeState,
  storage = getDefaultStorage(),
): Promise<void> => {
  await storage.session.set({ [RUNTIME_STATE_STORAGE_KEY]: runtimeState })
}

export const getRuntimeState = async (storage = getDefaultStorage()): Promise<RuntimeState | undefined> => {
  const items = await storage.session.get(RUNTIME_STATE_STORAGE_KEY)
  const runtimeState = items[RUNTIME_STATE_STORAGE_KEY]

  return isRecord(runtimeState) ? (runtimeState as RuntimeState) : undefined
}

export const getPerChannelSettings = async (storage = getDefaultStorage()): Promise<PerChannelSettings> =>
  readRecord(storage.local, PER_CHANNEL_SETTINGS_STORAGE_KEY) as unknown as PerChannelSettings

export const getChannelSettings = async (
  channelName: string,
  storage = getDefaultStorage(),
): Promise<Partial<UserSettings> | undefined> => {
  const all = await getPerChannelSettings(storage)

  return all[channelName]
}

export const saveChannelSettings = async (
  channelName: string,
  settings: Partial<UserSettings>,
  storage = getDefaultStorage(),
): Promise<void> => {
  const all = await getPerChannelSettings(storage)
  const {
    geminiQuota: _ignoredLegacyQuota,
    geminiQuotaProfiles: _ignoredQuotaProfiles,
    // Speech config is global-only in v0.3 (Spec §5, §13); never persisted in
    // a per-channel override, exactly like the Gemini quota fields.
    speechConfig: _ignoredSpeechConfig,
    ...channelSettings
  } = settings

  await storage.local.set({
    [PER_CHANNEL_SETTINGS_STORAGE_KEY]: {
      ...all,
      [channelName]: channelSettings,
    },
  })
}

export const deleteChannelSettings = async (
  channelName: string,
  storage = getDefaultStorage(),
): Promise<void> => {
  const all = await getPerChannelSettings(storage)

  delete all[channelName]

  await storage.local.set({ [PER_CHANNEL_SETTINGS_STORAGE_KEY]: all })
}

export const mergeSettings = (
  global: UserSettings,
  channel?: Partial<UserSettings>,
): UserSettings => {
  const {
    geminiQuota: _ignoredLegacyQuota,
    geminiQuotaProfiles: _ignoredQuotaProfiles,
    // Speech config is global-only in v0.3; channel overrides never carry it.
    speechConfig: _ignoredSpeechConfig,
    ...channelSettings
  } = channel ?? {}
  const merged = { ...global, ...channelSettings }
  const geminiQuota = normalizeGeminiQuotaSettings(global.geminiQuota)
  const channelVariant = (channel as Partial<UserSettings> | undefined)?.chineseVariantMode
  const chineseVariantMode =
    channelVariant === 'skip_all_chinese' || channelVariant === 'translate_other_script'
      ? channelVariant
      : global.chineseVariantMode
  return {
    ...merged,
    selectedModel: normalizeSelectedModel(merged.selectedProvider, merged.selectedModel),
    chineseVariantMode,
    geminiQuota,
    geminiQuotaProfiles: normalizeGeminiQuotaProfiles(global.geminiQuotaProfiles, geminiQuota),
    speechConfig: normalizeSpeechConfig(global.speechConfig),
  }
}
