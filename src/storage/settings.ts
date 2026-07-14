// Chrome storage wrapper — settings and API key management
// Only Service Worker reads complete keys; Popup only sees masked versions.

import type { FilterConfig } from '@/content/message-filter'
import { DEFAULT_FILTER_CONFIG } from '@/content/message-filter'
import type { ProviderId } from '@/providers/types'
import { GEMINI_MODELS } from '@/providers/gemini'
import {
  DEFAULT_GEMINI_QUOTA,
  normalizeGeminiQuotaSettings,
  type GeminiQuotaSettings,
} from '@/background/gemini-quota'

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
  botNameBlacklist: string[]
  minTextLength: number
  translationEnabled: boolean
  filterConfig: FilterConfig
  geminiQuota: GeminiQuotaSettings
  geminiQuotaProfiles: Record<string, GeminiQuotaSettings>
}

export const DEFAULT_GEMINI_QUOTA_PROFILES: Record<string, GeminiQuotaSettings> =
  Object.fromEntries(GEMINI_MODELS.map(({ id }) => [id, { ...DEFAULT_GEMINI_QUOTA }]))

export const DEFAULT_SETTINGS: UserSettings = {
  ...DEFAULT_FILTER_CONFIG,
  selectedProvider: 'deepseek',
  selectedModel: 'deepseek-v4-flash',
  targetLanguage: 'zh-TW',
  displayMode: 'below',
  botNameBlacklist: [],
  minTextLength: 2,
  translationEnabled: true,
  filterConfig: DEFAULT_FILTER_CONFIG,
  geminiQuota: DEFAULT_GEMINI_QUOTA,
  geminiQuotaProfiles: DEFAULT_GEMINI_QUOTA_PROFILES,
}

export interface RuntimeState {
  activeProvider?: ProviderId
  validationInProgress?: boolean
  lastValidationError?: string
}

export const USER_SETTINGS_STORAGE_KEY = 'userSettings'
export const API_KEYS_STORAGE_KEY = 'providerApiKeys'
export const API_KEY_PREVIEWS_STORAGE_KEY = 'providerApiKeyPreviews'
export const RUNTIME_STATE_STORAGE_KEY = 'runtimeState'
export const PER_CHANNEL_SETTINGS_STORAGE_KEY = 'perChannelSettings'

export type PerChannelSettings = Record<string, Partial<UserSettings>>

type ApiKeyMap = Partial<Record<ProviderId, string>>
type ApiKeyPreviewMap = Partial<Record<ProviderId, string>>

const getDefaultStorage = (): ChromeStorageLike => chrome.storage

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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
}

export const getUserSettings = async (storage = getDefaultStorage()): Promise<UserSettings> => {
  const storedSettings = await readRecord(storage.local, USER_SETTINGS_STORAGE_KEY)
  const geminiQuota = normalizeGeminiQuotaSettings(storedSettings.geminiQuota)

  return {
    ...DEFAULT_SETTINGS,
    ...storedSettings,
    geminiQuota,
    geminiQuotaProfiles: normalizeGeminiQuotaProfiles(storedSettings.geminiQuotaProfiles, geminiQuota),
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
    geminiQuota,
    geminiQuotaProfiles: normalizeGeminiQuotaProfiles(profilesSource, geminiQuota),
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
  const apiKeys = await readApiKeys(storage)

  return apiKeys[providerId]
}

export const getMaskedApiKeyForPopup = async (
  providerId: ProviderId,
  storage = getDefaultStorage(),
): Promise<string | undefined> => {
  const apiKeyPreviews = await readApiKeyPreviews(storage)

  return apiKeyPreviews[providerId]
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
    ...channelSettings
  } = channel ?? {}
  const merged = { ...global, ...channelSettings }
  const geminiQuota = normalizeGeminiQuotaSettings(global.geminiQuota)
  return {
    ...merged,
    geminiQuota,
    geminiQuotaProfiles: normalizeGeminiQuotaProfiles(global.geminiQuotaProfiles, geminiQuota),
  }
}
