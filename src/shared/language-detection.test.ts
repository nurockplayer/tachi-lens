import { describe, expect, it } from 'vitest'
import {
  normalizeLocale,
  classifyChineseScriptTarget,
  analyzeMessageScript,
  shouldSkipMessage,
} from './language-detection'

describe('normalizeLocale', () => {
  it('returns "zh" for zh', () => {
    expect(normalizeLocale('zh')).toBe('zh')
  })

  it('returns "zh" for zh-TW', () => {
    expect(normalizeLocale('zh-TW')).toBe('zh')
  })

  it('returns "zh" for zh-CN', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh')
  })

  it('returns "zh" for zh-HK', () => {
    expect(normalizeLocale('zh-HK')).toBe('zh')
  })

  it('returns "zh" for zh-Hans', () => {
    expect(normalizeLocale('zh-Hans')).toBe('zh')
  })

  it('returns "zh" for zh-Hant', () => {
    expect(normalizeLocale('zh-Hant')).toBe('zh')
  })

  it('returns "en" for en', () => {
    expect(normalizeLocale('en')).toBe('en')
  })

  it('returns "en" for en-US', () => {
    expect(normalizeLocale('en-US')).toBe('en')
  })

  it('returns "en" for en-GB', () => {
    expect(normalizeLocale('en-GB')).toBe('en')
  })

  it('returns "ja" for ja', () => {
    expect(normalizeLocale('ja')).toBe('ja')
  })

  it('returns "ko" for ko', () => {
    expect(normalizeLocale('ko')).toBe('ko')
  })

  it('handles case-insensitive input', () => {
    expect(normalizeLocale('ZH-TW')).toBe('zh')
    expect(normalizeLocale('zh-tw')).toBe('zh')
    expect(normalizeLocale('En')).toBe('en')
  })

  it('handles underscore separator', () => {
    expect(normalizeLocale('zh_TW')).toBe('zh')
    expect(normalizeLocale('en_US')).toBe('en')
  })

  it('returns unknown locale as-is lowercased', () => {
    expect(normalizeLocale('fr')).toBe('fr')
    expect(normalizeLocale('FR')).toBe('fr')
    expect(normalizeLocale('de-DE')).toBe('de')
  })
})

describe('classifyChineseScriptTarget', () => {
  it.each([
    ['zh-CN', 'simplified'],
    ['zh-Hans', 'simplified'],
    ['zh-SG', 'simplified'],
    ['zh-TW', 'traditional'],
    ['zh-HK', 'traditional'],
    ['zh-Hant', 'traditional'],
    ['zh-MO', 'traditional'],
    ['zh', 'generic'],
    ['en', null],
    ['ja', null],
    ['ko', null],
    ['fr', null],
  ])('classifies %s as %s', (locale, expected) => {
    expect(classifyChineseScriptTarget(locale)).toBe(expected)
  })

  it('handles case-insensitive input', () => {
    expect(classifyChineseScriptTarget('zh-cn')).toBe('simplified')
    expect(classifyChineseScriptTarget('zh-tw')).toBe('traditional')
  })
})

describe('analyzeMessageScript', () => {
  it('detects simplified-only characters', () => {
    const result = analyzeMessageScript('长东马车门开')
    expect(result.hasHan).toBe(true)
    expect(result.hasSimplifiedOnly).toBe(true)
    expect(result.hasTraditionalOnly).toBe(false)
    expect(result.hasSharedHan).toBe(false)
    expect(result.hasJapaneseKana).toBe(false)
    expect(result.hasHangul).toBe(false)
  })

  it('detects traditional-only characters', () => {
    const result = analyzeMessageScript('體國長東馬')
    expect(result.hasHan).toBe(true)
    expect(result.hasSimplifiedOnly).toBe(false)
    expect(result.hasTraditionalOnly).toBe(true)
    expect(result.hasSharedHan).toBe(false)
    expect(result.hasJapaneseKana).toBe(false)
    expect(result.hasHangul).toBe(false)
  })

  it('detects shared Han characters', () => {
    const result = analyzeMessageScript('大人山水')
    expect(result.hasHan).toBe(true)
    expect(result.hasSimplifiedOnly).toBe(false)
    expect(result.hasTraditionalOnly).toBe(false)
    expect(result.hasSharedHan).toBe(true)
    expect(result.hasJapaneseKana).toBe(false)
    expect(result.hasHangul).toBe(false)
  })

  it('detects mixed simplified and traditional evidence', () => {
    const result = analyzeMessageScript('长東')
    expect(result.hasHan).toBe(true)
    expect(result.hasSimplifiedOnly).toBe(true)
    expect(result.hasTraditionalOnly).toBe(true)
  })

  it('detects Japanese Kana alongside Han', () => {
    const result = analyzeMessageScript('今天は暑い')
    expect(result.hasHan).toBe(true)
    expect(result.hasJapaneseKana).toBe(true)
    expect(result.hasHangul).toBe(false)
  })

  it('detects Hangul', () => {
    const result = analyzeMessageScript('안녕하세요')
    expect(result.hasHangul).toBe(true)
    expect(result.hasHan).toBe(false)
    expect(result.hasJapaneseKana).toBe(false)
  })

  it('detects Latin letters mixed with Han', () => {
    const result = analyzeMessageScript('hello 大家好')
    expect(result.hasHan).toBe(true)
    expect(result.hasSharedHan).toBe(true)
    expect(result.hasLatinLetter).toBe(true)
    expect(result.hasJapaneseKana).toBe(false)
    expect(result.hasHangul).toBe(false)
  })

  it('returns empty evidence for Latin-only text', () => {
    const result = analyzeMessageScript('Hello World')
    expect(result.hasHan).toBe(false)
    expect(result.hasJapaneseKana).toBe(false)
    expect(result.hasHangul).toBe(false)
    expect(result.hasSimplifiedOnly).toBe(false)
    expect(result.hasTraditionalOnly).toBe(false)
    expect(result.hasSharedHan).toBe(false)
  })

  it('returns empty evidence for numbers and punctuation', () => {
    const result = analyzeMessageScript('12345!@#$%')
    expect(result.hasHan).toBe(false)
    expect(result.hasJapaneseKana).toBe(false)
    expect(result.hasHangul).toBe(false)
    expect(result.hasSimplifiedOnly).toBe(false)
    expect(result.hasTraditionalOnly).toBe(false)
  })

  it('does not treat numbers as false confidence', () => {
    const result = analyzeMessageScript('1234567890')
    expect(result.hasHan).toBe(false)
  })

  it('treats Katakana as Japanese Kana', () => {
    const result = analyzeMessageScript('テスト韓国')
    expect(result.hasHan).toBe(true)
    expect(result.hasJapaneseKana).toBe(true)
  })

  it('treats halfwidth Katakana alongside Han as Kana', () => {
    // Codex finding: ｶﾅ国 was incorrectly classified as pure Chinese
    expect(shouldSkipMessage('ｶﾅ国', 'zh-TW', 'skip_all_chinese')).toBe(false)
    expect(shouldSkipMessage('ｶﾅ国', 'zh-TW', 'translate_other_script')).toBe(false)
  })

  it('treats Katakana Phonetic Extensions alongside Han as Kana', () => {
    // ㇰ is Katakana Phonetic Extension U+31F0
    expect(shouldSkipMessage('漢ㇰ', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('detects Hangul alongside Han', () => {
    const result = analyzeMessageScript('한국어測試')
    expect(result.hasHan).toBe(true)
    expect(result.hasHangul).toBe(true)
    expect(result.hasJapaneseKana).toBe(false)
  })

  it('treats Hangul Jamo alongside Han as Korean', () => {
    // Codex finding: 한国 was incorrectly classified as pure Chinese
    expect(shouldSkipMessage('한国', 'zh-CN', 'skip_all_chinese')).toBe(false)
    expect(shouldSkipMessage('한国', 'zh-CN', 'translate_other_script')).toBe(false)
  })

  it('treats Hangul Compatibility Jamo alongside Han as Korean', () => {
    // ㅋ U+314B is Compatibility Jamo
    expect(shouldSkipMessage('漢字ㅋㅋ', 'zh-CN', 'skip_all_chinese')).toBe(false)
  })

  it('treats accented Latin plus Han as mixed-language', () => {
    // Codex finding: é国 was incorrectly skipped as pure Chinese
    expect(shouldSkipMessage('é国', 'zh-TW', 'skip_all_chinese')).toBe(false)
    expect(shouldSkipMessage('é国', 'zh-TW', 'translate_other_script')).toBe(false)
  })

  it('treats fullwidth Latin plus Han as mixed-language', () => {
    // Codex finding: Ａ国 was incorrectly skipped (fullwidth Latin A)
    expect(shouldSkipMessage('Ａ国', 'zh-TW', 'skip_all_chinese')).toBe(false)
    expect(shouldSkipMessage('Ａ国', 'zh-TW', 'translate_other_script')).toBe(false)
  })
})

describe('shouldSkipMessage — skip_all_chinese mode', () => {
  it('skips simplified Chinese for zh-TW target', () => {
    expect(shouldSkipMessage('长东马车门开', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('skips traditional Chinese for zh-CN target', () => {
    expect(shouldSkipMessage('體國長東馬', 'zh-CN', 'skip_all_chinese')).toBe(true)
  })

  it('skips Chinese for generic zh target', () => {
    expect(shouldSkipMessage('长东马车门开', 'zh', 'skip_all_chinese')).toBe(true)
  })

  // Kanji-only Japanese must not be skipped as Chinese (Shinjitai overlap)
  it('does not skip Kanji-only Japanese text 中国', () => {
    expect(shouldSkipMessage('中国', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip Kanji-only Japanese text 会社', () => {
    expect(shouldSkipMessage('会社', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip Kanji-only Japanese text 体調', () => {
    expect(shouldSkipMessage('体調', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip shared-only Han (could be Kanji-only Japanese)', () => {
    expect(shouldSkipMessage('大人山水', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip Japanese text with Kana', () => {
    expect(shouldSkipMessage('今天は暑い', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip Korean text with Hangul', () => {
    expect(shouldSkipMessage('안녕하세요', 'zh-CN', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip Latin-only text', () => {
    expect(shouldSkipMessage('Hello World!', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip mixed Latin and Han text', () => {
    expect(shouldSkipMessage('hello 大家好', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip non-zh target even with Chinese text', () => {
    expect(shouldSkipMessage('体国长东马', 'en', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip text with only numbers', () => {
    expect(shouldSkipMessage('12345', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('skips mixed simplified and traditional Chinese text', () => {
    expect(shouldSkipMessage('体國', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })
})

describe('shouldSkipMessage — translate_other_script mode', () => {
  // Requirements from #46: 今天真的很熱 → skip, 今天真的很热 → translate, 今天很好 → skip
  // Targets from #51: traditional, simplified, generic, mixed

  describe('traditional target (zh-TW)', () => {
    it('skips text with only traditional evidence', () => {
      expect(shouldSkipMessage('體國長東馬', 'zh-TW', 'translate_other_script')).toBe(true)
    })

    it('processes text with only simplified evidence', () => {
      expect(shouldSkipMessage('体国长东马', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('processes text with mixed simplified and traditional evidence', () => {
      expect(shouldSkipMessage('长國', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('skips text with only shared Han characters (#46: 今天很好 → skip)', () => {
      expect(shouldSkipMessage('今天很好', 'zh-TW', 'translate_other_script')).toBe(true)
    })

    it('skips 今天真的很熱 for zh-TW (#46 explicit)', () => {
      // 今天真的很熱: 今/天/真/的/很 are shared, 熱 is traditional-only
      expect(shouldSkipMessage('今天真的很熱', 'zh-TW', 'translate_other_script')).toBe(true)
    })

    it('processes 今天真的很热 for zh-TW (#46 explicit)', () => {
      // 今天真的很热: 今/天/真/的/很 are shared, 热 is simplified-only
      expect(shouldSkipMessage('今天真的很热', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('does not skip Japanese text with Kana (#46/51 explicit)', () => {
      expect(shouldSkipMessage('今天は暑い', 'zh-TW', 'translate_other_script')).toBe(false)
    })
  })

  describe('simplified target (zh-CN)', () => {
    it('skips text with only simplified evidence', () => {
      expect(shouldSkipMessage('体国长东马', 'zh-CN', 'translate_other_script')).toBe(true)
    })

    it('processes text with only traditional evidence', () => {
      expect(shouldSkipMessage('體國長東馬', 'zh-CN', 'translate_other_script')).toBe(false)
    })

    it('processes text with mixed evidence', () => {
      expect(shouldSkipMessage('长國', 'zh-CN', 'translate_other_script')).toBe(false)
    })

    it('skips text with only shared Han characters', () => {
      expect(shouldSkipMessage('大人山水', 'zh-CN', 'translate_other_script')).toBe(true)
    })
  })

  describe('generic zh target', () => {
    it('does not skip simplified text (cannot determine target script)', () => {
      expect(shouldSkipMessage('体国长东马', 'zh', 'translate_other_script')).toBe(false)
    })

    it('does not skip traditional text (cannot determine target script)', () => {
      expect(shouldSkipMessage('體國長東馬', 'zh', 'translate_other_script')).toBe(false)
    })
  })

  it('does not skip Latin-only text', () => {
    expect(shouldSkipMessage('Hello', 'zh-TW', 'translate_other_script')).toBe(false)
  })

  it('does not skip non-zh target', () => {
    expect(shouldSkipMessage('体国长东马', 'en', 'translate_other_script')).toBe(false)
  })

  it('does not skip mixed Latin and Han text (#46: hello 大家好)', () => {
    expect(shouldSkipMessage('hello 大家好', 'zh-TW', 'translate_other_script')).toBe(false)
  })

  // Shared-Han Shinjitai-overlap examples in translate_other_script mode
  // These are now shared-only after Shinjitai removal, so they hit the
  // same shared-Han → skip path as 今天很好 (per-spec for specific targets).
  it('skips Kanji-only Japanese 中国 for zh-TW in translate_other_script (shared-Han path)', () => {
    expect(shouldSkipMessage('中国', 'zh-TW', 'translate_other_script')).toBe(true)
  })

  it('skips Kanji-only Japanese 会社 for zh-TW in translate_other_script (shared-Han path)', () => {
    expect(shouldSkipMessage('会社', 'zh-TW', 'translate_other_script')).toBe(true)
  })

  it('skips Kanji-only Japanese 体調 for zh-TW in translate_other_script (shared-Han path)', () => {
    expect(shouldSkipMessage('体調', 'zh-TW', 'translate_other_script')).toBe(true)
  })
})
