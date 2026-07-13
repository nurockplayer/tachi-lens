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
  | 'errorAuth'
  | 'errorRateLimited'
  | 'errorTimeout'
  | 'errorNetwork'
  | 'errorUnsupportedModel'
  | 'errorUnknown'
  | 'errorNotificationTitle'
  | 'dismiss'
  | 'shortcutToggleTranslation'
  | 'shortcutToggleDisplayMode'
  | 'filterSection'
  | 'skipEmotesOnly'
  | 'skipCheermotes'
  | 'skipSlashMe'
  | 'skipWhispers'
  | 'skipReplies'
  | 'skipLinksOnly'
  | 'skipNumbersOnly'
  | 'skipSystemMessages'
  | 'geminiQuotaSection'
  | 'geminiQuotaHelp'
  | 'geminiQuotaRpm'
  | 'geminiQuotaTpm'
  | 'geminiQuotaRpd'
  | 'geminiQuotaRpmSafety'
  | 'geminiQuotaTpmSafety'
  | 'geminiQuotaRpdSafety'
  | 'geminiQuotaLiveWait'
  | 'geminiQuotaConcurrency'

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
  'errorAuth',
  'errorRateLimited',
  'errorTimeout',
  'errorNetwork',
  'errorUnsupportedModel',
  'errorUnknown',
  'errorNotificationTitle',
  'dismiss',
  'shortcutToggleTranslation',
  'shortcutToggleDisplayMode',
  'filterSection',
  'skipEmotesOnly',
  'skipCheermotes',
  'skipSlashMe',
  'skipWhispers',
  'skipReplies',
  'skipLinksOnly',
  'skipNumbersOnly',
  'skipSystemMessages',
  'geminiQuotaSection',
  'geminiQuotaHelp',
  'geminiQuotaRpm',
  'geminiQuotaTpm',
  'geminiQuotaRpd',
  'geminiQuotaRpmSafety',
  'geminiQuotaTpmSafety',
  'geminiQuotaRpdSafety',
  'geminiQuotaLiveWait',
  'geminiQuotaConcurrency',
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
  errorAuth: 'API 驗證失敗，請檢查 API Key',
  errorRateLimited: '請求次數過多，請稍後再試',
  errorTimeout: '請求超時，請檢查網路連線',
  errorNetwork: '網路錯誤，請檢查連線狀態',
  errorUnsupportedModel: '不支援的模型',
  errorUnknown: '發生未知錯誤',
  errorNotificationTitle: '錯誤通知',
  dismiss: '關閉',
  shortcutToggleTranslation: '切換翻譯 (Ctrl+Shift+T)',
  shortcutToggleDisplayMode: '切換顯示模式 (Ctrl+Shift+M)',
  filterSection: '訊息過濾',
  skipEmotesOnly: '略過純表情符號',
  skipCheermotes: '略過 Cheermote',
  skipSlashMe: '略過 /me 訊息',
  skipWhispers: '略過悄悄話',
  skipReplies: '略過回覆訊息',
  skipLinksOnly: '略過純連結',
  skipNumbersOnly: '略過純數字',
  skipSystemMessages: '略過系統訊息',
  geminiQuotaSection: 'Gemini 模型配額',
  geminiQuotaHelp: '請填入 Google AI Studio 顯示的目前模型限制；安全比例會保留使用緩衝。',
  geminiQuotaRpm: '每分鐘請求上限 (RPM)',
  geminiQuotaTpm: '每分鐘輸入 Token 上限 (TPM)',
  geminiQuotaRpd: '每日請求上限 (RPD)',
  geminiQuotaRpmSafety: 'RPM 安全比例 (%)',
  geminiQuotaTpmSafety: 'TPM 安全比例 (%)',
  geminiQuotaRpdSafety: 'RPD 安全比例 (%)',
  geminiQuotaLiveWait: '即時訊息最長等待 (ms)',
  geminiQuotaConcurrency: 'Gemini 同時請求上限',
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
