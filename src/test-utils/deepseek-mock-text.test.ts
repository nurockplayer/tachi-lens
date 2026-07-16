/**
 * Unit tests for resolveMockTranslation (DeepSeek mock text validation).
 *
 * Colocated with the source module under src/test-utils per CLAUDE.md
 * test/source colocation rule.
 */
import { resolveMockTranslation } from './deepseek-mock-text'

describe('resolveMockTranslation (DeepSeek mock validation)', () => {
  // ── Legacy contract (no translations map) ──────────────────────────
  describe('without translations map (legacy contract)', () => {
    it('accepts "Hello world" and returns default translation', () => {
      expect(resolveMockTranslation('Hello world')).toBe('你好，世界')
    })

    it('rejects texts other than "Hello world"', () => {
      expect(() => resolveMockTranslation('something else')).toThrow(
        'DeepSeek mock: unexpected message text "something else"',
      )
    })

    it('rejects empty string', () => {
      expect(() => resolveMockTranslation('')).toThrow(
        'DeepSeek mock: unexpected message text ""',
      )
    })
  })

  // ── Translations-map contract ─────────────────────────────────────
  describe('with translations map', () => {
    const translations = {
      'before restart': '重新啟動前',
      'after restart': '重新啟動後',
    }

    it('returns translation for a mapped key', () => {
      expect(resolveMockTranslation('before restart', translations)).toBe('重新啟動前')
      expect(resolveMockTranslation('after restart', translations)).toBe('重新啟動後')
    })

    it('rejects unmapped text', () => {
      expect(() => resolveMockTranslation('unexpected text', translations)).toThrow(
        'DeepSeek mock: unexpected message text "unexpected text" with translations map',
      )
    })

    it('rejects text that would be accepted under the legacy contract', () => {
      expect(() => resolveMockTranslation('Hello world', translations)).toThrow(
        'DeepSeek mock: unexpected message text "Hello world" with translations map',
      )
    })

    it('rejects empty string even with translations map', () => {
      expect(() => resolveMockTranslation('', translations)).toThrow(
        'DeepSeek mock: unexpected message text "" with translations map',
      )
    })

    it('error message lists all accepted keys', () => {
      expect(() => resolveMockTranslation('nope', translations)).toThrow(
        'Expected one of: "before restart", "after restart"',
      )
    })
  })
})
