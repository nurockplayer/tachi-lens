// Chrome storage wrapper — settings and API key management
// Only Service Worker reads complete keys; Popup only sees masked versions.

export interface UserSettings {
  selectedProvider: string
  selectedModel: string
  targetLanguage: string
  displayMode: 'below' | 'hover' | 'collapse'
  botNameBlacklist: string[]
  minTextLength: number
  translationEnabled: boolean
}

export const DEFAULT_SETTINGS: UserSettings = {
  selectedProvider: 'deepseek',
  selectedModel: 'deepseek-v4-flash',
  targetLanguage: 'zh-TW',
  displayMode: 'below',
  botNameBlacklist: [],
  minTextLength: 2,
  translationEnabled: true,
}
