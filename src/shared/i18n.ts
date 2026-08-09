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
  | 'chineseVariantSection'
  | 'chineseVariantSkipAllChinese'
  | 'chineseVariantTranslateOtherScript'
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
  | 'quotaHealthSection'
  | 'quotaHealthStatusHealthy'
  | 'quotaHealthStatusCooldown'
  | 'quotaHealthStatusClockRollback'
  | 'quotaHealthStatusUntrustedMigration'
  | 'quotaHealthStatusMalformedSnapshot'
  | 'quotaHealthStatusUnsupportedVersion'
  | 'quotaHealthDescHealthy'
  | 'quotaHealthDescCooldown'
  | 'quotaHealthDescClockRollback'
  | 'quotaHealthDescUntrustedMigration'
  | 'quotaHealthDescMalformedSnapshot'
  | 'quotaHealthDescUnsupportedVersion'
  | 'quotaHealthDenialPrefix'
  | 'quotaHealthDenialRpm'
  | 'quotaHealthDenialTpm'
  | 'quotaHealthDenialRpd'
  | 'quotaHealthDenialCooldown'
  | 'quotaHealthDenialClockRollback'
  | 'quotaHealthProviderDay'
  | 'quotaHealthCooldownUntil'
  | 'quotaHealthRecoveryAt'
  | 'quotaHealthDeepSeekOverflow'
  | 'quotaHealthRepair'
  | 'quotaHealthRepairConfirm'
  | 'speechSection'
  | 'speechEnabled'
  | 'speechProvider'
  | 'speechModel'
  | 'speechTargetLanguage'
  | 'speechCaptionMaxLines'
  | 'speechCaptionOpacity'
  | 'speechMaxSessionMinutes'

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
  'chineseVariantSection',
  'chineseVariantSkipAllChinese',
  'chineseVariantTranslateOtherScript',
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
  'quotaHealthSection',
  'quotaHealthStatusHealthy',
  'quotaHealthStatusCooldown',
  'quotaHealthStatusClockRollback',
  'quotaHealthStatusUntrustedMigration',
  'quotaHealthStatusMalformedSnapshot',
  'quotaHealthStatusUnsupportedVersion',
  'quotaHealthDescHealthy',
  'quotaHealthDescCooldown',
  'quotaHealthDescClockRollback',
  'quotaHealthDescUntrustedMigration',
  'quotaHealthDescMalformedSnapshot',
  'quotaHealthDescUnsupportedVersion',
  'quotaHealthDenialPrefix',
  'quotaHealthDenialRpm',
  'quotaHealthDenialTpm',
  'quotaHealthDenialRpd',
  'quotaHealthDenialCooldown',
  'quotaHealthDenialClockRollback',
  'quotaHealthProviderDay',
  'quotaHealthCooldownUntil',
  'quotaHealthRecoveryAt',
  'quotaHealthDeepSeekOverflow',
  'quotaHealthRepair',
  'quotaHealthRepairConfirm',
  'speechSection',
  'speechEnabled',
  'speechProvider',
  'speechModel',
  'speechTargetLanguage',
  'speechCaptionMaxLines',
  'speechCaptionOpacity',
  'speechMaxSessionMinutes',
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
  chineseVariantSection: '中文訊息處理',
  chineseVariantSkipAllChinese: '簡體、繁體都不翻譯',
  chineseVariantTranslateOtherScript: '將另一種中文字體轉換成目標字體',
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
  quotaHealthSection: 'Gemini 配額健康狀態',
  quotaHealthStatusHealthy: '正常',
  quotaHealthStatusCooldown: '冷卻中',
  quotaHealthStatusClockRollback: '時鐘回撥',
  quotaHealthStatusUntrustedMigration: '不可信的遷移',
  quotaHealthStatusMalformedSnapshot: '資料異常',
  quotaHealthStatusUnsupportedVersion: '不支援的版本',
  quotaHealthDescHealthy: 'Gemini 配額運作正常。',
  quotaHealthDescCooldown: 'Gemini 正在冷卻，暫停送出請求以保護配額。',
  quotaHealthDescClockRollback: '偵測到時鐘回撥，Gemini 已暫停以保護配額正確性。',
  quotaHealthDescUntrustedMigration: '偵測到不可信的資料遷移，Gemini 已停用以保護配額正確性。',
  quotaHealthDescMalformedSnapshot: '偵測到損壞的配額資料，Gemini 已停用以保護配額正確性。',
  quotaHealthDescUnsupportedVersion: '偵測到不支援的配額資料版本，Gemini 已停用以保護配額正確性。',
  quotaHealthDenialPrefix: '拒絕原因',
  quotaHealthDenialRpm: '每分鐘請求上限 (RPM)',
  quotaHealthDenialTpm: '每分鐘輸入 Token 上限 (TPM)',
  quotaHealthDenialRpd: '每日請求上限 (RPD)',
  quotaHealthDenialCooldown: '冷卻中',
  quotaHealthDenialClockRollback: '時鐘回撥',
  quotaHealthProviderDay: '目前配額日',
  quotaHealthCooldownUntil: '冷卻結束',
  quotaHealthRecoveryAt: '自動恢復時間',
  quotaHealthDeepSeekOverflow: 'Gemini 暫停期間，仍可改用 DeepSeek 進行翻譯。',
  quotaHealthRepair: '修復配額資料',
  quotaHealthRepairConfirm: '確認修復？',
  speechSection: '語音字幕',
  speechEnabled: '啟用語音字幕',
  speechProvider: '語音提供者',
  speechModel: '語音模型',
  speechTargetLanguage: '語音目標語言',
  speechCaptionMaxLines: '字幕最大行數',
  speechCaptionOpacity: '字幕不透明度 (%)',
  speechMaxSessionMinutes: '單次語音時段上限 (分鐘)',
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
