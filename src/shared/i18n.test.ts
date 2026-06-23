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

  describe('message keys', () => {
    it('contains all expected message keys', () => {
      expect(MESSAGE_KEYS).toContain('appTitle')
      expect(MESSAGE_KEYS).toContain('enableTranslation')
      expect(MESSAGE_KEYS).toContain('validate')
      expect(MESSAGE_KEYS).toContain('saveSettings')
      expect(MESSAGE_KEYS.length).toBeGreaterThanOrEqual(20)
    })
  })
})
