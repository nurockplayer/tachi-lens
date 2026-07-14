import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  API_KEY_PREVIEWS_STORAGE_KEY,
  API_KEYS_STORAGE_KEY,
  RUNTIME_STATE_STORAGE_KEY,
  DEFAULT_SETTINGS,
  deleteApiKey,
  deleteChannelSettings,
  getApiKeyForServiceWorker,
  getChannelSettings,
  getMaskedApiKeyForPopup,
  getPerChannelSettings,
  getRuntimeState,
  getUserSettings,
  initializeStorageAccess,
  maskApiKey,
  mergeSettings,
  rotateApiKey,
  saveApiKey,
  saveChannelSettings,
  saveRuntimeState,
  saveUserSettings,
  type StorageAreaLike,
  type UserSettings,
} from './settings'

const createStorageArea = (initial: Record<string, unknown> = {}): StorageAreaLike & { data: Record<string, unknown> } => {
  const data = { ...initial }

  return {
    data,
    get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
      if (keys === null || keys === undefined) {
        return { ...data }
      }

      if (typeof keys === 'string') {
        return { [keys]: data[keys] }
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, data[key]]))
      }

      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, data[key] ?? fallback]))
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items)
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key]
      }
    }),
    setAccessLevel: vi.fn(async () => undefined),
  }
}

const createChromeStorage = () => ({
  AccessLevel: {
    TRUSTED_CONTEXTS: 'TRUSTED_CONTEXTS',
    TRUSTED_AND_UNTRUSTED_CONTEXTS: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
  },
  local: createStorageArea(),
  session: createStorageArea(),
})

describe('settings storage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('restricts local and session storage to trusted extension contexts', async () => {
    const storage = createChromeStorage()

    await initializeStorageAccess(storage)

    expect(storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' })
    expect(storage.session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' })
  })

  it('loads default settings when local storage has not been initialized', async () => {
    const storage = createChromeStorage()

    await expect(getUserSettings(storage)).resolves.toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.geminiQuota).toMatchObject({
      rpmSafetyPercent: 80,
      tpmSafetyPercent: 80,
      rpdSafetyPercent: 95,
      liveMaxWaitMs: 1_000,
      maxConcurrency: 1,
    })
    expect(DEFAULT_SETTINGS.geminiQuota.requestsPerMinute).toBeGreaterThan(0)
    expect(DEFAULT_SETTINGS.geminiQuota.inputTokensPerMinute).toBeGreaterThan(0)
    expect(DEFAULT_SETTINGS.geminiQuota.requestsPerDay).toBeGreaterThan(0)
    const profiles = (DEFAULT_SETTINGS as UserSettings & {
      geminiQuotaProfiles: Record<string, typeof DEFAULT_SETTINGS.geminiQuota>
    }).geminiQuotaProfiles
    expect(Object.keys(profiles)).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
    expect(profiles['gemini-2.5-flash']).not.toBe(profiles['gemini-2.5-pro'])
  })

  it('migrates a legacy Gemini quota profile to every known Gemini model', async () => {
    const storage = createChromeStorage()
    const legacyProfile = {
      ...DEFAULT_SETTINGS.geminiQuota,
      requestsPerMinute: 3,
      requestsPerDay: 27,
    }
    storage.local.data.userSettings = { geminiQuota: legacyProfile }

    const settings = await getUserSettings(storage) as UserSettings & {
      geminiQuotaProfiles: Record<string, typeof legacyProfile>
    }

    expect(settings.geminiQuotaProfiles['gemini-2.5-flash']).toEqual(legacyProfile)
    expect(settings.geminiQuotaProfiles['gemini-2.5-pro']).toEqual(legacyProfile)
  })

  it('normalizes model-specific Gemini profiles independently at the storage boundary', async () => {
    const storage = createChromeStorage()
    storage.local.data.userSettings = {
      geminiQuotaProfiles: {
        'gemini-2.5-flash': { requestsPerMinute: 9 },
        'gemini-2.5-pro': { requestsPerMinute: -1, requestsPerDay: 12 },
      },
    }

    const settings = await getUserSettings(storage) as UserSettings & {
      geminiQuotaProfiles: Record<string, typeof DEFAULT_SETTINGS.geminiQuota>
    }

    expect(settings.geminiQuotaProfiles['gemini-2.5-flash']!.requestsPerMinute).toBe(9)
    expect(settings.geminiQuotaProfiles['gemini-2.5-pro']!.requestsPerMinute)
      .toBe(DEFAULT_SETTINGS.geminiQuota.requestsPerMinute)
    expect(settings.geminiQuotaProfiles['gemini-2.5-pro']!.requestsPerDay).toBe(12)
  })

  it('normalizes malformed stored Gemini quota settings at the storage boundary', async () => {
    const storage = createChromeStorage()
    storage.local.data.userSettings = {
      geminiQuota: {
        requestsPerMinute: 0,
        inputTokensPerMinute: -1,
        requestsPerDay: Number.NaN,
        maxConcurrency: 'many',
      },
    }

    const settings = await getUserSettings(storage)

    expect(settings.geminiQuota.requestsPerMinute).toBeGreaterThan(0)
    expect(settings.geminiQuota.inputTokensPerMinute).toBeGreaterThan(0)
    expect(settings.geminiQuota.requestsPerDay).toBeGreaterThan(0)
    expect(settings.geminiQuota.maxConcurrency).toBe(1)
  })

  it('normalizes malformed Gemini quota updates before persisting them', async () => {
    const storage = createChromeStorage()

    const settings = await saveUserSettings({
      geminiQuota: {
        requestsPerMinute: 0,
        inputTokensPerMinute: -1,
        requestsPerDay: Number.NaN,
        rpmSafetyPercent: Number.POSITIVE_INFINITY,
        tpmSafetyPercent: 0,
        rpdSafetyPercent: -5,
        liveMaxWaitMs: 0,
        maxConcurrency: 0,
      },
    }, storage)

    expect(settings.geminiQuota).toEqual(DEFAULT_SETTINGS.geminiQuota)
    expect((storage.local.data.userSettings as { geminiQuota: unknown }).geminiQuota)
      .toEqual(DEFAULT_SETTINGS.geminiQuota)
  })

  it('preserves existing per-model quota profiles when saveUserSettings receives only geminiQuota', async () => {
    const storage = createChromeStorage()
    const distinctProfiles: Record<string, typeof DEFAULT_SETTINGS.geminiQuota> = {
      'gemini-2.5-flash': { ...DEFAULT_SETTINGS.geminiQuota, requestsPerMinute: 10, requestsPerDay: 50 },
      'gemini-2.5-pro': { ...DEFAULT_SETTINGS.geminiQuota, requestsPerMinute: 3, requestsPerDay: 20 },
    }
    storage.local.data.userSettings = { geminiQuotaProfiles: distinctProfiles }

    // Act: save only geminiQuota, no geminiQuotaProfiles
    await saveUserSettings({
      geminiQuota: { ...DEFAULT_SETTINGS.geminiQuota, requestsPerMinute: 99 },
    }, storage)

    const saved = storage.local.data.userSettings as UserSettings & {
      geminiQuotaProfiles: Record<string, typeof DEFAULT_SETTINGS.geminiQuota>
    }
    expect(saved.geminiQuotaProfiles['gemini-2.5-flash']!.requestsPerMinute).toBe(10)
    expect(saved.geminiQuotaProfiles['gemini-2.5-flash']!.requestsPerDay).toBe(50)
    expect(saved.geminiQuotaProfiles['gemini-2.5-pro']!.requestsPerMinute).toBe(3)
    expect(saved.geminiQuotaProfiles['gemini-2.5-pro']!.requestsPerDay).toBe(20)
  })

  it('merges stored partial settings over defaults', async () => {
    const storage = createChromeStorage()
    storage.local.data.userSettings = { targetLanguage: 'ja', translationEnabled: false }

    await expect(getUserSettings(storage)).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      targetLanguage: 'ja',
      translationEnabled: false,
    })
  })

  it('persists user settings only to local storage', async () => {
    const storage = createChromeStorage()

    await saveUserSettings({ targetLanguage: 'en', minTextLength: 4 }, storage)

    expect(storage.local.data.userSettings).toEqual({
      ...DEFAULT_SETTINGS,
      targetLanguage: 'en',
      minTextLength: 4,
    })
    expect(storage.session.set).not.toHaveBeenCalled()
  })

  it('stores full API keys in chrome.storage.local without writing to session storage', async () => {
    const storage = createChromeStorage()

    await saveApiKey('deepseek', 'sk-deepseek-secret', storage)

    expect(storage.local.data[API_KEYS_STORAGE_KEY]).toEqual({ deepseek: 'sk-deepseek-secret' })
    expect(storage.local.data[API_KEY_PREVIEWS_STORAGE_KEY]).toEqual({ deepseek: 'sk-***********cret' })
    expect(storage.session.set).not.toHaveBeenCalled()
  })

  it('returns full API keys only through the service worker accessor', async () => {
    const storage = createChromeStorage()
    storage.local.data[API_KEYS_STORAGE_KEY] = { openai: 'sk-openai-secret' }

    await expect(getApiKeyForServiceWorker('openai', storage)).resolves.toBe('sk-openai-secret')
  })

  it('returns only masked API keys for popup display', async () => {
    const storage = createChromeStorage()
    storage.local.data[API_KEYS_STORAGE_KEY] = { claude: 'this-full-key-would-mask-differently' }
    storage.local.data[API_KEY_PREVIEWS_STORAGE_KEY] = { claude: 'sk-**********7890' }

    await expect(getMaskedApiKeyForPopup('claude', storage)).resolves.toBe('sk-**********7890')
  })

  it('does not reveal short API keys when masking', () => {
    expect(maskApiKey('abcdefg')).toBe('*******')
  })

  it('deletes and rotates provider API keys without touching other providers', async () => {
    const storage = createChromeStorage()
    storage.local.data[API_KEYS_STORAGE_KEY] = {
      gemini: 'gemini-old',
      deepseek: 'deepseek-old',
    }

    await rotateApiKey('gemini', 'gemini-new', storage)
    await deleteApiKey('deepseek', storage)

    expect(storage.local.data[API_KEYS_STORAGE_KEY]).toEqual({ gemini: 'gemini-new' })
    expect(storage.local.data[API_KEY_PREVIEWS_STORAGE_KEY]).toEqual({ gemini: 'gem***-new' })
  })

  it('stores short-lived runtime state in chrome.storage.session', async () => {
    const storage = createChromeStorage()

    await saveRuntimeState({ activeProvider: 'deepseek', validationInProgress: true }, storage)

    expect(storage.session.data[RUNTIME_STATE_STORAGE_KEY]).toEqual({
      activeProvider: 'deepseek',
      validationInProgress: true,
    })
    expect(storage.local.set).not.toHaveBeenCalledWith(expect.objectContaining({ [RUNTIME_STATE_STORAGE_KEY]: expect.anything() }))
    await expect(getRuntimeState(storage)).resolves.toEqual({ activeProvider: 'deepseek', validationInProgress: true })
  })

  describe('per-channel settings', () => {
    it('returns empty per-channel settings when none have been saved', async () => {
      const storage = createChromeStorage()

      const perChannel = await getPerChannelSettings(storage)

      expect(perChannel).toEqual({})
    })

    it('returns all per-channel settings', async () => {
      const storage = createChromeStorage()
      storage.local.data.perChannelSettings = {
        somerchannel: { targetLanguage: 'ja' },
        otherchannel: { translationEnabled: false },
      }

      const perChannel = await getPerChannelSettings(storage)

      expect(perChannel).toEqual({
        somerchannel: { targetLanguage: 'ja' },
        otherchannel: { translationEnabled: false },
      })
    })

    it('returns settings for a specific channel', async () => {
      const storage = createChromeStorage()
      storage.local.data.perChannelSettings = {
        mychannel: { targetLanguage: 'ko', displayMode: 'hover' },
      }

      const channelSettings = await getChannelSettings('mychannel', storage)

      expect(channelSettings).toEqual({ targetLanguage: 'ko', displayMode: 'hover' })
    })

    it('returns undefined for a channel with no saved settings', async () => {
      const storage = createChromeStorage()
      storage.local.data.perChannelSettings = { other: { minTextLength: 5 } }

      const channelSettings = await getChannelSettings('nonexistent', storage)

      expect(channelSettings).toBeUndefined()
    })

    it('saves settings for a channel', async () => {
      const storage = createChromeStorage()

      await saveChannelSettings('testchannel', { targetLanguage: 'en' }, storage)

      expect(storage.local.data.perChannelSettings).toEqual({
        testchannel: { targetLanguage: 'en' },
      })
    })

    it('never stores global Gemini quota profiles in a channel override', async () => {
      const storage = createChromeStorage()

      await saveChannelSettings('testchannel', {
        targetLanguage: 'en',
        geminiQuota: { ...DEFAULT_SETTINGS.geminiQuota, requestsPerMinute: 7 },
        geminiQuotaProfiles: {
          'gemini-2.5-flash': { ...DEFAULT_SETTINGS.geminiQuota, requestsPerMinute: 7 },
        },
      }, storage)

      expect(storage.local.data.perChannelSettings).toEqual({
        testchannel: { targetLanguage: 'en' },
      })
    })

    it('merges new channel settings with existing per-channel entries', async () => {
      const storage = createChromeStorage()
      storage.local.data.perChannelSettings = {
        existing: { minTextLength: 10 },
      }

      await saveChannelSettings('testchannel', { targetLanguage: 'th' }, storage)

      expect(storage.local.data.perChannelSettings).toEqual({
        existing: { minTextLength: 10 },
        testchannel: { targetLanguage: 'th' },
      })
    })

    it('overwrites existing settings for the same channel', async () => {
      const storage = createChromeStorage()
      storage.local.data.perChannelSettings = {
        mychannel: { targetLanguage: 'ja' },
      }

      await saveChannelSettings('mychannel', { targetLanguage: 'ko' }, storage)

      expect(storage.local.data.perChannelSettings).toEqual({
        mychannel: { targetLanguage: 'ko' },
      })
    })

    it('deletes settings for a specific channel', async () => {
      const storage = createChromeStorage()
      storage.local.data.perChannelSettings = {
        keep: { minTextLength: 3 },
        remove: { targetLanguage: 'vi' },
      }

      await deleteChannelSettings('remove', storage)

      expect(storage.local.data.perChannelSettings).toEqual({
        keep: { minTextLength: 3 },
      })
    })

    it('does not error when deleting a non-existent channel', async () => {
      const storage = createChromeStorage()
      storage.local.data.perChannelSettings = { existing: { minTextLength: 1 } }

      await expect(deleteChannelSettings('nonexistent', storage)).resolves.toBeUndefined()

      expect(storage.local.data.perChannelSettings).toEqual({ existing: { minTextLength: 1 } })
    })

    it('mergeSettings returns global settings when no channel settings given', () => {
      const result = mergeSettings(DEFAULT_SETTINGS, undefined)

      expect(result).toEqual(DEFAULT_SETTINGS)
    })

    it('mergeSettings applies channel settings on top of global settings', () => {
      const global = { ...DEFAULT_SETTINGS, targetLanguage: 'zh-TW', minTextLength: 2 }

      const result = mergeSettings(global, { targetLanguage: 'ja', minTextLength: 10 })

      expect(result.targetLanguage).toBe('ja')
      expect(result.minTextLength).toBe(10)
      // Remaining fields come from global
      expect(result.selectedProvider).toBe(DEFAULT_SETTINGS.selectedProvider)
      expect(result.translationEnabled).toBe(true)
    })

    it('mergeSettings preserves global values when channel settings are empty', () => {
      const global = { ...DEFAULT_SETTINGS, targetLanguage: 'zh-TW' }

      const result = mergeSettings(global, {})

      expect(result).toEqual(global)
    })

    it('mergeSettings applies partial channel settings over global', () => {
      const global = { ...DEFAULT_SETTINGS, targetLanguage: 'zh-TW', displayMode: 'below' as const }

      const result = mergeSettings(global, { targetLanguage: 'en' })

      expect(result.targetLanguage).toBe('en')
      expect(result.displayMode).toBe('below') // from global
    })

    it('ignores legacy channel quota overrides that the scheduler cannot read', () => {
      const global = {
        ...DEFAULT_SETTINGS,
        geminiQuotaProfiles: {
          ...DEFAULT_SETTINGS.geminiQuotaProfiles,
          'gemini-2.5-flash': { ...DEFAULT_SETTINGS.geminiQuota, requestsPerMinute: 5 },
        },
      }

      const result = mergeSettings(global, {
        geminiQuota: { ...DEFAULT_SETTINGS.geminiQuota, requestsPerMinute: 99 },
        geminiQuotaProfiles: {
          'gemini-2.5-flash': { ...DEFAULT_SETTINGS.geminiQuota, requestsPerMinute: 99 },
        },
      })

      expect(result.geminiQuotaProfiles['gemini-2.5-flash']!.requestsPerMinute).toBe(5)
    })
  })
})
