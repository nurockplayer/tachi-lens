/// <reference types="chrome"/>

/**
 * Lightweight i18n helper wrapping chrome.i18n.getMessage().
 * Falls back to a provided message map when chrome APIs are unavailable
 * (e.g. in tests or node environments).
 */

export type MessageKey =
  | 'appTitle'
  | 'appDescription'
  | 'enableTranslation'
  | 'translationProvider'
  | 'model'
  | 'apiKey'
  | 'apiKeyPlaceholder'
  | 'targetLanguage'
  | 'displayMode'
  | 'displayBelow'
  | 'displayHover'
  | 'displayCollapse'
  | 'minTextLength'
  | 'botBlacklist'
  | 'botBlacklistPlaceholder'
  | 'saveSettings'
  | 'settingsSaved'
  | 'validate'
  | 'validating'
  | 'valid'
  | 'invalid'
  | 'loading'
  | 'hide'
  | 'show'
  | 'translationFailed'

export const MESSAGE_KEYS: readonly string[] = [
  'appTitle',
  'appDescription',
  'enableTranslation',
  'translationProvider',
  'model',
  'apiKey',
  'apiKeyPlaceholder',
  'targetLanguage',
  'displayMode',
  'displayBelow',
  'displayHover',
  'displayCollapse',
  'minTextLength',
  'botBlacklist',
  'botBlacklistPlaceholder',
  'saveSettings',
  'settingsSaved',
  'validate',
  'validating',
  'valid',
  'invalid',
  'loading',
  'hide',
  'show',
  'translationFailed',
] as const

const FALLBACK_MESSAGES: Record<MessageKey, string> = {
  appTitle: 'tachi-lens',
  appDescription: 'Twitch 聊天室沉浸式翻譯',
  enableTranslation: '啟用翻譯',
  translationProvider: '翻譯提供者',
  model: '模型',
  apiKey: 'API Key',
  apiKeyPlaceholder: '輸入 API Key',
  targetLanguage: '目標語言',
  displayMode: '顯示模式',
  displayBelow: '原文下方',
  displayHover: '懸停顯示',
  displayCollapse: '收合',
  minTextLength: '最短翻譯字數',
  botBlacklist: 'Bot 黑名單（逗號分隔）',
  botBlacklistPlaceholder: 'streamelements, nightbot',
  saveSettings: '儲存設定',
  settingsSaved: '設定已儲存',
  validate: '驗證',
  validating: '驗證中...',
  valid: '✓ 有效',
  invalid: '✗ 無效',
  loading: '載入中...',
  hide: '隱藏',
  show: '顯示',
  translationFailed: '翻譯失敗',
}

/**
 * Check if we're in a Chrome Extension context with i18n support.
 * chrome.i18n may be undefined in non-extension contexts (e.g. tests, Node).
 */
const hasChromeI18n = (): boolean =>
  typeof chrome !== 'undefined' &&
  typeof chrome.i18n !== 'undefined' &&
  typeof chrome.i18n.getMessage === 'function'

/**
 * Get a translated string by key.
 * Falls back to the built-in Chinese fallback if chrome.i18n is unavailable.
 */
export const t = (key: MessageKey, substitutions?: string | string[]): string => {
  if (hasChromeI18n()) {
    const msg = chrome.i18n.getMessage(key, substitutions)
    if (msg) return msg
  }

  return FALLBACK_MESSAGES[key as MessageKey] ?? key
}

/**
 * Check whether chrome.i18n is available (for testing).
 */
export const isI18nAvailable = (): boolean => hasChromeI18n()
