import { describe, expect, it } from 'vitest'
import { MESSAGE_KEYS, t } from './i18n'

describe('i18n', () => {
  describe('t()', () => {
    for (const key of MESSAGE_KEYS) {
      it(`returns a non-empty string for "${key}"`, () => {
        const msg = t(key as Parameters<typeof t>[0])
        expect(msg).toBeTypeOf('string')
        expect(msg.length).toBeGreaterThan(0)
      })
    }

    it('returns fallback Chinese for appTitle', () => {
      expect(t('appTitle')).toBe('tachi-lens')
    })

    it('returns fallback Chinese for enableTranslation', () => {
      expect(t('enableTranslation')).toBe('啟用翻譯')
    })

    it('returns fallback Chinese for displayBelow', () => {
      expect(t('displayBelow')).toBe('原文下方')
    })

    it('returns fallback Chinese for settingsSaved', () => {
      expect(t('settingsSaved')).toBe('設定已儲存')
    })
  })

  describe('error keys', () => {
    for (const key of ['errorAuth', 'errorRateLimited', 'errorTimeout', 'errorNetwork', 'errorUnsupportedModel', 'errorUnknown', 'errorNotificationTitle', 'dismiss'] as const) {
      it(`returns non-empty fallback for "${key}"`, () => {
        expect(t(key)).toBeTypeOf('string')
        expect(t(key).length).toBeGreaterThan(0)
      })
    }

    it('returns errorAuth fallback', () => {
      expect(t('errorAuth')).toBe('API Key 無效')
    })

    it('returns dismiss fallback', () => {
      expect(t('dismiss')).toBe('關閉')
    })

    it('returns errorNotificationTitle fallback', () => {
      expect(t('errorNotificationTitle')).toBe('錯誤通知')
    })
  })

  describe('message keys', () => {
    it('contains all expected message keys', () => {
      expect(MESSAGE_KEYS).toContain('appTitle')
      expect(MESSAGE_KEYS).toContain('enableTranslation')
      expect(MESSAGE_KEYS).toContain('validate')
      expect(MESSAGE_KEYS).toContain('saveSettings')
      expect(MESSAGE_KEYS).toContain('errorAuth')
      expect(MESSAGE_KEYS).toContain('dismiss')
      expect(MESSAGE_KEYS.length).toBeGreaterThanOrEqual(28)
    })
  })
})
