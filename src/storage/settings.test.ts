import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  API_KEY_PREVIEWS_STORAGE_KEY,
  API_KEYS_STORAGE_KEY,
  RUNTIME_STATE_STORAGE_KEY,
  DEFAULT_SETTINGS,
  deleteApiKey,
  getApiKeyForServiceWorker,
  getMaskedApiKeyForPopup,
  getRuntimeState,
  getUserSettings,
  initializeStorageAccess,
  maskApiKey,
  rotateApiKey,
  saveApiKey,
  saveRuntimeState,
  saveUserSettings,
  type StorageAreaLike,
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
})
