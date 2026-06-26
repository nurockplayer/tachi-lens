import { describe, expect, it } from 'vitest'
import { MESSAGE_KEYS, t } from './i18n'
import en from '../../public/_locales/en/messages.json'
import zh_TW from '../../public/_locales/zh_TW/messages.json'

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

  describe('locale files consistency', () => {
    const knownKeys = MESSAGE_KEYS as readonly string[]

    const getLocaleKeys = (locale: Record<string, { message: string }>): string[] =>
      Object.keys(locale)

    it('en locale has all known keys', () => {
      const keys = getLocaleKeys(en)
      for (const k of knownKeys) {
        expect(keys).toContain(k)
      }
    })

    it('zh_TW locale has all known keys', () => {
      const keys = getLocaleKeys(zh_TW)
      for (const k of knownKeys) {
        expect(keys).toContain(k)
      }
    })

    it('en locale has no extra keys', () => {
      const keys = getLocaleKeys(en)
      for (const k of keys) {
        expect(knownKeys).toContain(k)
      }
    })

    it('zh_TW locale has no extra keys', () => {
      const keys = getLocaleKeys(zh_TW)
      for (const k of keys) {
        expect(knownKeys).toContain(k)
      }
    })

    it('en locale has non-empty messages', () => {
      for (const [key, val] of Object.entries(en)) {
        expect(val.message).toBeTypeOf('string')
        expect(val.message.length).toBeGreaterThan(0)
      }
    })

    it('zh_TW locale has non-empty messages', () => {
      for (const [key, val] of Object.entries(zh_TW)) {
        expect(val.message).toBeTypeOf('string')
        expect(val.message.length).toBeGreaterThan(0)
      }
    })
  })
})
