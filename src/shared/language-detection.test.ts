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
    expect(result.hasForeignLetter).toBe(true)
    expect(result.hasJapaneseKana).toBe(false)
    expect(result.hasHangul).toBe(false)
  })

  it('detects Cyrillic letters mixed with Han', () => {
    const result = analyzeMessageScript('привет 国')
    expect(result.hasHan).toBe(true)
    expect(result.hasForeignLetter).toBe(true)
  })

  it('does not treat × or ÷ as foreign letters', () => {
    expect(analyzeMessageScript('×').hasForeignLetter).toBe(false)
    expect(analyzeMessageScript('÷').hasForeignLetter).toBe(false)
    // Real Latin letters around them still count
    expect(analyzeMessageScript('A×B').hasForeignLetter).toBe(true)
  })

  it('treats Bopomofo as neutral Chinese phonetic content, not foreign', () => {
    const result = analyzeMessageScript('ㄏㄏ')
    expect(result.hasForeignLetter).toBe(false)
    expect(result.hasHan).toBe(false)
  })

  it('treats Bopomofo alongside Han as Chinese, not foreign', () => {
    const result = analyzeMessageScript('這個很好ㄏㄏ')
    expect(result.hasForeignLetter).toBe(false)
    expect(result.hasHan).toBe(true)
  })

  it('treats Bopomofo Extended as neutral, not a foreign letter', () => {
    // ㆠ is Bopomofo Extended U+31A0
    const result = analyzeMessageScript('ㆠ')
    expect(result.hasForeignLetter).toBe(false)
    expect(result.hasHan).toBe(false)
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
    expect(shouldSkipMessage('这个很热', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('skips traditional Chinese for zh-CN target', () => {
    expect(shouldSkipMessage('這個很熱', 'zh-CN', 'skip_all_chinese')).toBe(true)
  })

  it('skips Chinese for generic zh target', () => {
    expect(shouldSkipMessage('这个很热', 'zh', 'skip_all_chinese')).toBe(true)
  })

  // Shinjitai-overlap characters removed from SIMPLIFIED_ONLY must not skip
  it('does not skip Kanji-only Japanese 参加 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('参加', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip Kanji-only Japanese 宝石 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('宝石', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip Kanji-only Japanese 接触 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('接触', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  // Kanji-only Japanese must not be skipped as Chinese (Shinjitai overlap)
  it('does not skip Kanji-only Japanese text 中国', () => {
    expect(shouldSkipMessage('中国', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  // Traditional-only glyphs also used in Japanese must not imply Chinese language
  it('does not skip kana-less Japanese 手紙 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('手紙', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip kana-less Japanese 営業時間 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('営業時間', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip kana-less Japanese 電話 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('電話', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip kana-less Japanese 自動車 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('自動車', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  // 的/了 are ordinary Japanese Kanji, not Chinese-only markers
  it('does not skip kana-less Japanese 目的 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('目的', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip kana-less Japanese 個人的 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('個人的', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip kana-less Japanese 終了 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('終了', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip kana-less Japanese 完了 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('完了', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip kana-less Japanese 了解 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('了解', 'zh-TW', 'skip_all_chinese')).toBe(false)
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

  it('skips Traditional Chinese with Bopomofo for zh-TW in skip_all_chinese', () => {
    // ㄏㄏ is neutral Chinese phonetic content, not a foreign letter
    expect(shouldSkipMessage('這個很好ㄏㄏ', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('does not skip Bopomofo-only text for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('ㄏㄏ', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip Bopomofo-only text for zh-TW in translate_other_script', () => {
    expect(shouldSkipMessage('ㄏㄏ', 'zh-TW', 'translate_other_script')).toBe(false)
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
    expect(shouldSkipMessage('这个熱吧', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  // #182: ordinary Chinese live chat must be skipped when the target is
  // Chinese. These observed messages contain no CHINESE_LANGUAGE_MARKERS
  // character and previously fell through to a translate_request.
  describe('Issue #182 observed messages', () => {
    it.each([
      '那是肯定沒有',
      '不客氣',
      '我才',
      '那要打訊號什麼的',
    ])('skips %s for a zh-TW target in skip_all_chinese', (text) => {
      expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(true)
    })

    it.each([
      '那是肯定沒有',
      '不客氣',
      '我才',
      '那要打訊號什麼的',
    ])('skips %s for a zh-CN target in skip_all_chinese', (text) => {
      expect(shouldSkipMessage(text, 'zh-CN', 'skip_all_chinese')).toBe(true)
    })

    it('skips the OBS-mixed message for a zh-TW target in skip_all_chinese', () => {
      // 把手機的畫面傳到電腦用OBS開台就可以不用斷: Han-dominated sentence
      // with an embedded English acronym. The Chinese structure evidence is
      // strong enough to skip despite the foreign letters.
      expect(
        shouldSkipMessage('把手機的畫面傳到電腦用OBS開台就可以不用斷', 'zh-TW', 'skip_all_chinese'),
      ).toBe(true)
    })

    it('skips the OBS-mixed message for a zh-CN target in skip_all_chinese', () => {
      expect(
        shouldSkipMessage('把手機的畫面傳到電腦用OBS開台就可以不用斷', 'zh-CN', 'skip_all_chinese'),
      ).toBe(true)
    })

    it('does not skip the OBS-mixed message in translate_other_script mode', () => {
      // Mixed-script evidence and foreign letters stay conservative here.
      expect(
        shouldSkipMessage('把手機的畫面傳到電腦用OBS開台就可以不用斷', 'zh-TW', 'translate_other_script'),
      ).toBe(false)
    })

    it('skips #182 messages with trailing punctuation in skip_all_chinese', () => {
      // CHINESE_PHRASES matching strips punctuation/symbols, so 不客氣！/我才～ are still skipped.
      expect(shouldSkipMessage('不客氣！', 'zh-TW', 'skip_all_chinese')).toBe(true)
      expect(shouldSkipMessage('不客氣～', 'zh-TW', 'skip_all_chinese')).toBe(true)
      expect(shouldSkipMessage('我才！', 'zh-TW', 'skip_all_chinese')).toBe(true)
    })
  })
})

describe('shouldSkipMessage — preserved skip_all_chinese coverage', () => {
  // Regression guard for the original #55 marker gate: these common Mandarin
  // messages all contain a CHINESE_LANGUAGE_MARKERS character and were skipped
  // before the #182 scoring model, and must keep skipping.
  it.each([
    '對啊',
    '上啊',
    '衝啊',
    '品質很好',
    '品質很鳥',
    '今天很好',
    '今天真的很熱',
    '今天真的很热',
    '我們',
    '我們要走了',
  ])('still skips %s for a zh-TW target in skip_all_chinese', (text) => {
    expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('still does not skip kana-less Japanese guard words with markers for zh-TW', () => {
    // 完/了 are weight-1 characters and not markers; these stay translatable.
    expect(shouldSkipMessage('完了', 'zh-TW', 'skip_all_chinese')).toBe(false)
    expect(shouldSkipMessage('了解', 'zh-TW', 'skip_all_chinese')).toBe(false)
    expect(shouldSkipMessage('個人的', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })
})

describe('shouldSkipMessage — weak Kanji do not accumulate into Chinese', () => {
  // #182 follow-up regression: several weak/ambiguous Han characters that also
  // occur in kana-less Japanese words (個/用/不/可/能 in 個人, 利用, 可能) must
  // never accumulate into a confident-Chinese signal on their own. Only strong
  // (weight-3) Mandarin structural characters, markers, or phrases are decisive.
  it.each([
    '個人利用不可',
    '使用不可能',
    '不可能',
    '再利用不可',
    '個人利用',
    '利用不可',
    '個人情報',
    '使用禁止',
    '立入禁止',
    '申込不要',
  ])('does not skip kana-less Japanese %s for a zh-TW target in skip_all_chinese', (text) => {
    expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it.each([
    '個人利用不可',
    '使用不可能',
    '不可能',
  ])('does not skip kana-less Japanese %s for a zh-CN target in skip_all_chinese', (text) => {
    expect(shouldSkipMessage(text, 'zh-CN', 'skip_all_chinese')).toBe(false)
  })
})

describe('shouldSkipMessage — Japanese-use Kanji is not strong Mandarin evidence', () => {
  // #182 follow-up: 没 (U+6CA1) is both Simplified Chinese and ordinary modern
  // Japanese Kanji (没収/水没/没入), so it must not act as decisive Mandarin
  // evidence. Traditional 沒 (U+6C92) stays strong because it is not a
  // Simplified-Chinese glyph and is not ordinary modern Japanese usage.
  it.each([
    '没収',
    '水没',
    '没入',
  ])('does not skip kana-less Japanese %s (simplified 没) for zh-TW in skip_all_chinese', (text) => {
    expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it.each([
    '没収',
    '水没',
    '没入',
  ])('does not skip kana-less Japanese %s (simplified 没) for zh-CN in skip_all_chinese', (text) => {
    expect(shouldSkipMessage(text, 'zh-CN', 'skip_all_chinese')).toBe(false)
  })

  it('still skips Traditional Chinese 那是肯定沒有 with 沒 (U+6C92) for zh-TW', () => {
    expect(shouldSkipMessage('那是肯定沒有', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })
})

describe('shouldSkipMessage — weak Kanji must not skip in mixed-letter messages', () => {
  // #182 follow-up: the foreign-letter branch must obey the same conservative
  // principle as the Han-only branch. A short kana-less Japanese phrase with a
  // Latin acronym (個人利用不可OBS: 6 Han vs 3 Latin) must not skip on weak
  // accumulation, while the Han-dominant real Chinese OBS message does.
  it.each([
    '個人利用不可OBS',
    '使用不可能OBS',
    '不可能OBS',
    '再利用不可OBS',
    '個人情報OBS',
  ])('does not skip kana-less Japanese with acronym %s for zh-TW in skip_all_chinese', (text) => {
    expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  // A single trailing Latin letter (halfwidth w or fullwidth ｗ U+FF57) is a
  // foreign letter too; it must not let short Japanese phrases skip on weak
  // Kanji accumulation. The absolute Han-count floor rejects these.
  it.each([
    '使用不可能w',
    '個人利用不可w',
    '使用不可能ｗ',
    '個人利用不可ｗ',
    '不可能w',
    '個人情報w',
  ])('does not skip kana-less Japanese with a trailing Latin letter %s for zh-TW', (text) => {
    expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('still skips the Han-dominant Chinese OBS message for zh-TW in skip_all_chinese', () => {
    expect(
      shouldSkipMessage('把手機的畫面傳到電腦用OBS開台就可以不用斷', 'zh-TW', 'skip_all_chinese'),
    ).toBe(true)
  })

  it('still skips the Han-dominant Chinese OBS message for zh-CN in skip_all_chinese', () => {
    expect(
      shouldSkipMessage('把手機的畫面傳到電腦用OBS開台就可以不用斷', 'zh-CN', 'skip_all_chinese'),
    ).toBe(true)
  })
})

describe('shouldSkipMessage — Japanese-use Kanji is not strong Mandarin evidence (什)', () => {
  // #182 follow-up: 什 (U+4EC0) is ordinary modern Japanese Kanji (什器
  // = fixtures/tools), so it must not act as decisive weight-3 evidence.
  it.each([
    '什器',
    '什物',
    '什錦',
  ])('does not skip kana-less Japanese %s for zh-TW in skip_all_chinese', (text) => {
    expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('still skips 那要打訊號什麼的 via 麼 (U+9EBC) for zh-TW', () => {
    // 什 demoted to weight 1, but 麼 stays weight 3 → strong evidence remains.
    expect(shouldSkipMessage('那要打訊號什麼的', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })
})

describe('shouldSkipMessage — Mandarin pronouns unlock Han-only aggregate', () => {
  // #182 follow-up: Han-only Mandarin built from weak structural entries
  // (我要用你的 = 5) must skip, but a Mandarin personal pronoun is required so
  // kana-less Japanese compounds (個人利用不可, 使用不可能) still translate.
  it('skips 我要用你的 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('我要用你的', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('skips 我真的不可以 for zh-TW in skip_all_chinese', () => {
    // 我→真 is a pronoun followed by a Mandarin degree modifier, so the
    // aggregate path unlocks; total = 我1+真0+的1+不1+可1+以0 = 4.
    expect(shouldSkipMessage('我真的不可以', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('skips 我，真的不可以 (separator between pronoun and predicate) for zh-TW', () => {
    // Punctuation between the pronoun and its predicate must be skipped.
    expect(shouldSkipMessage('我，真的不可以', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('skips 我 真的不可以 (space between pronoun and predicate) for zh-TW', () => {
    expect(shouldSkipMessage('我 真的不可以', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('skips 你要好好的 for zh-TW in skip_all_chinese', () => {
    // 你1+要1+好1+好1+的1 = 5 with a Mandarin pronoun → aggregate path.
    expect(shouldSkipMessage('你要好好的', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('does not skip pronoun-free 個人利用不可 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('個人利用不可', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip pronoun-free 使用不可能 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('使用不可能', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  // #182 follow-up: the pronoun must be used AS a pronoun (followed by a
  // Mandarin predicate/particle). Bare presence is not enough — in 他人
  // (Japanese "other people") 他 precedes a noun and must not unlock the
  // aggregate path.
  it.each([
    '他人使用不可',
    '他人利用不可',
    '他人',
    '自己',
    '我慢',
  ])('does not skip kana-less Japanese %s for zh-TW in skip_all_chinese', (text) => {
    expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('still skips Mandarin pronoun-in-context 他很好 for zh-TW in skip_all_chinese', () => {
    // 他→很 is a pronoun followed by a Mandarin predicate → aggregate unlocks.
    expect(shouldSkipMessage('他很好', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })
})

describe('shouldSkipMessage — long Japanese mixed message needs Mandarin context', () => {
  // #182 follow-up: long kana-less Japanese signage sentences with an acronym
  // (個人情報利用不可無断転載禁止w, 個人的使用不可無断転載禁止w) pass the
  // dominance gate and reach a weak aggregate of 4-5, but must not skip. The
  // mixed branch requires Mandarin-specific context (pronoun-as-pronoun or a
  // Mandarin function word 把/就); the real Chinese OBS message skips via 把
  // and 就 in 把手機的畫面傳到電腦用OBS開台就可以不用斷.
  it.each([
    '個人情報利用不可無断転載禁止w',
    '個人情報利用不可無断転載禁止',
    '個人情報利用不可無断転載禁止OBS',
    '個人的使用不可無断転載禁止w',
    '個人的使用不可OBS',
    '就業規則個人情報無断利用不可w',
    '把握事項個人情報利用不可禁止w',
    '不用品個人情報無断利用禁止w',
    '許可以外使用不可無断転載禁止w',
    '📺📺許可以外使用不可無断転載禁止w',
    '各種情報利用不可禁止',
  ])('does not skip long kana-less Japanese %s for zh-TW in skip_all_chinese', (text) => {
    expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('still skips the Han-dominant Chinese OBS message via 把/就 for zh-TW', () => {
    // 把手機的畫面傳到電腦用OBS開台就可以不用斷: contains 把 (ba-construction)
    // and 就 (adverb), so the Mandarin function-word context unlocks the
    // aggregate path in the mixed branch.
    expect(
      shouldSkipMessage('把手機的畫面傳到電腦用OBS開台就可以不用斷', 'zh-TW', 'skip_all_chinese'),
    ).toBe(true)
  })

  it('still skips 把手機的畫面傳到電腦用OBS開台就可以不用斷 for zh-CN', () => {
    expect(
      shouldSkipMessage('把手機的畫面傳到電腦用OBS開台就可以不用斷', 'zh-CN', 'skip_all_chinese'),
    ).toBe(true)
  })

  it('still skips the 把-construction OBS message without 的 for zh-TW', () => {
    // 把手機畫面傳到電腦用OBS開台可以不用斷: 把 introduces a noun phrase
    // (把手機), so hasMandarinFunction is set even though 把 is not followed
    // by a structural character. Han-dominant mixed message.
    expect(
      shouldSkipMessage('把手機畫面傳到電腦用OBS開台可以不用斷', 'zh-TW', 'skip_all_chinese'),
    ).toBe(true)
  })
})

describe('shouldSkipMessage — mixed strong/marker evidence requires Han dominance', () => {
  // #182 follow-up: a foreign-dominated segment with a marker or weight-3 char
  // (hello 這個, English 對啊) must not skip the whole message; the dominance
  // gate now applies before any Chinese evidence.
  it.each([
    'hello 這個',
    'English 對啊',
    'hello 品質很好',
  ])('does not skip foreign-dominant mixed message %s for zh-TW', (text) => {
    expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('still skips the Han-dominant Chinese OBS message for zh-TW in skip_all_chinese', () => {
    expect(
      shouldSkipMessage('把手機的畫面傳到電腦用OBS開台就可以不用斷', 'zh-TW', 'skip_all_chinese'),
    ).toBe(true)
  })
})

describe('shouldSkipMessage — emoji variation selectors do not break phrase matching', () => {
  // #182 follow-up: 不客氣❤️ contains ❤ (So) + U+FE0F variation selector (Mn);
  // both must be stripped so the phrase still matches.
  it('skips 不客氣❤️ for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('不客氣❤️', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('skips 我才👍 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('我才👍', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('does not skip 不客氣 with a Kana suffix', () => {
    // Kana still short-circuits to translate regardless of the phrase.
    expect(shouldSkipMessage('不客氣です', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('skips 不客氣👨👩👧 (joined emoji with U+200D ZWJ) for zh-TW', () => {
    // The ZWJ (Cf format char) must be stripped like other marks/symbols.
    expect(shouldSkipMessage('不客氣👨👩👧', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })
})

describe('shouldSkipMessage — common courtesy phrases skip', () => {
  // #182 follow-up: 謝謝/谢谢 are extremely common Chinese chat messages with
  // no marker/structural/Mandarin-context evidence; they belong in the
  // exact-phrase fallback.
  it.each(['謝謝', '谢谢', '可以', '好的', '知道了'])(
    'skips %s for zh-TW in skip_all_chinese',
    (text) => {
      expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(true)
    },
  )

  it.each(['没问题', '没有问题', '沒問題', '沒问题'])(
    'skips %s (没问题 reply) for zh-TW in skip_all_chinese',
    (text) => {
      // Simplified 没 is weight 1 (so 没収/水没/没入 stay translatable), so
      // these full-message forms are recognized via the phrase fallback.
      expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(true)
    },
  )

  it('still does not skip 謝謝です (kana suffix)', () => {
    expect(shouldSkipMessage('謝謝です', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip 可以做 (可以 as a prefix is not an exact phrase match)', () => {
    // 可以 is only skipped as an exact message; 可以做 is a longer utterance.
    expect(shouldSkipMessage('可以做', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })
})

describe('shouldSkipMessage — astral-plane letters are detected as foreign', () => {
  // #182 follow-up: stylized Twitch text uses astral-plane letters (surrogate
  // pairs). Iterating the UTF-16 string by index yields surrogate halves that
  // never match \p{L}; code-point iteration must count them as foreign letters.
  it('does not skip 𝕙𝕖𝕝𝕝𝕠 這個 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('𝕙𝕖𝕝𝕝𝕠 這個', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('does not skip 𝕙𝕖𝕝𝕝𝕠 大家好 for zh-TW in skip_all_chinese', () => {
    expect(shouldSkipMessage('𝕙𝕖𝕝𝕝𝕠 大家好', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })
})

describe('shouldSkipMessage — Han-only path does not trust 的-particle', () => {
  // #182 follow-up: kana-less Japanese compounds of the 個人的+X{不可/可能/不
  // 可能} family (個人的利用不可, 個人的使用不可能) have 的 followed by a Han
  // character and several weak structural chars, but no Mandarin pronoun. The
  // Han-only aggregate path trusts only a pronoun used as a pronoun (我要,
  // 你的, 他是), never the 的-particle or a bare weak-char aggregate, so all of
  // these stay translatable. The real Chinese OBS message skips via the MIXED
  // branch (foreign letters + dominance + particle context).
  it.each([
    '個人的使用禁止',
    '個人的利用禁止',
    '個人的利用不可',
    '個人的使用不可',
    '個人的利用可能',
    '個人的使用不可能',
    '個人の使用禁止',
    '目的的利用',
  ])('does not skip kana-less Japanese %s for zh-TW in skip_all_chinese', (text) => {
    expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  // 他用途不可: 他 is a Japanese prefix meaning "other" (他用途 = other use);
  // 用 is not a Mandarin pronoun follower, so this is not a pronoun context.
  it.each([
    '他用途不可',
    '他利用不可',
    '他用途禁止',
    '他会場利用不可',
    '他方利用不可',
  ])('does not skip kana-less Japanese %s for zh-TW in skip_all_chinese', (text) => {
    expect(shouldSkipMessage(text, 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('still skips the Han-dominant Chinese OBS message via the mixed branch', () => {
    expect(
      shouldSkipMessage('把手機的畫面傳到電腦用OBS開台就可以不用斷', 'zh-TW', 'skip_all_chinese'),
    ).toBe(true)
  })

  it('still skips 我要用你的 (Han-only, Mandarin pronoun context)', () => {
    expect(shouldSkipMessage('我要用你的', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('still skips 他很好 (Han-only, 他→很 pronoun context)', () => {
    expect(shouldSkipMessage('他很好', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  // #182 follow-up: Mandarin predicates can take a numeral/classifier + noun
  // object (我要一個手機). The numeral after the predicate is acceptable
  // pronoun context; the Japanese 他X prefixes (他有地, 他会場) are not.
  it('skips 我要一個手機 (numeral/classifier object) for zh-TW', () => {
    expect(shouldSkipMessage('我要一個手機', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('skips 我要買一個手機 (intervening verb before numeral object) for zh-TW', () => {
    // 我→要→買→一: an ordinary lexical verb may intervene between the
    // predicate and the numeral/classifier object.
    expect(shouldSkipMessage('我要買一個手機', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('skips 我要再買一個手機 (adverb + verb before numeral object) for zh-TW', () => {
    // 我→要→再→買→一: an adverb and a lexical verb may both intervene.
    expect(shouldSkipMessage('我要再買一個手機', 'zh-TW', 'skip_all_chinese')).toBe(true)
  })

  it('rejects Japanese 不用品 after 他', () => {
    // 他不用品買取不可 ("other unwanted goods purchase not accepted") is
    // kana-less Japanese; 用 is a structural char but 品 is a bare noun, so
    // the tail walk rejects it.
    expect(shouldSkipMessage('他不用品買取不可', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('rejects Japanese 不要品 after 他 (follower does not bypass the tail)', () => {
    // 他不要品買取不可: 要 is a follower but 品 is a bare noun; the tail walk
    // must continue past the follower chain and reject the bare noun.
    expect(shouldSkipMessage('他不要品買取不可', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('recognizes numeral objects after pronoun predicates as context', () => {
    expect(analyzeMessageScript('我要一個手機').hasMandarinPronoun).toBe(true)
    expect(analyzeMessageScript('我要兩台電腦').hasMandarinPronoun).toBe(true)
    expect(analyzeMessageScript('他要一本書').hasMandarinPronoun).toBe(true)
    expect(analyzeMessageScript('我要買一個手機').hasMandarinPronoun).toBe(true)
    expect(analyzeMessageScript('他很好').hasMandarinPronoun).toBe(true)
  })

  it('keeps Japanese 他X prefixes out of numeral-object context', () => {
    // 地/場 are nouns, not numerals — the second lookahead still rejects them.
    expect(analyzeMessageScript('他有地利用不可').hasMandarinPronoun).toBe(false)
    expect(analyzeMessageScript('他会場利用不可').hasMandarinPronoun).toBe(false)
    expect(analyzeMessageScript('他人使用不可').hasMandarinPronoun).toBe(false)
    expect(analyzeMessageScript('他用途不可').hasMandarinPronoun).toBe(false)
    expect(shouldSkipMessage('他有地利用不可', 'zh-TW', 'skip_all_chinese')).toBe(false)
    expect(shouldSkipMessage('他会場利用不可', 'zh-TW', 'skip_all_chinese')).toBe(false)
    expect(shouldSkipMessage('他人使用不可', 'zh-TW', 'skip_all_chinese')).toBe(false)
    expect(shouldSkipMessage('他用途不可', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })

  it('excludes Japanese 他X prefixes while keeping structural pronoun contexts', () => {
    // 他→很→好, 我→真→的, 我→要→用 are Mandarin pronoun contexts.
    expect(analyzeMessageScript('他很好').hasMandarinPronoun).toBe(true)
    expect(analyzeMessageScript('我真的不可以').hasMandarinPronoun).toBe(true)
    expect(analyzeMessageScript('我要用你的').hasMandarinPronoun).toBe(true)
    // Japanese 他X prefixes (他→会→場, 他→有→地) are not Mandarin pronouns,
    // even when the second character is an allowed follower. These short
    // clauses translate because their aggregate stays below the threshold.
    expect(analyzeMessageScript('他会場利用不可').hasMandarinPronoun).toBe(false)
    expect(analyzeMessageScript('他有地利用不可').hasMandarinPronoun).toBe(false)
    expect(analyzeMessageScript('我要手機').hasMandarinPronoun).toBe(false)
    expect(shouldSkipMessage('我要手機', 'zh-TW', 'skip_all_chinese')).toBe(false)
  })
})

describe('shouldSkipMessage — translate_other_script mode', () => {
  // Requirements from #46: 今天真的很熱 → skip, 今天真的很热 → translate, 今天很好 → skip
  // Targets from #51: traditional, simplified, generic, mixed

  describe('traditional target (zh-TW)', () => {
    it('skips text with only traditional evidence and a Chinese marker', () => {
      expect(shouldSkipMessage('這個很熱', 'zh-TW', 'translate_other_script')).toBe(true)
    })

    it('skips Traditional Chinese with Bopomofo for zh-TW in translate_other_script', () => {
      expect(shouldSkipMessage('這個很好ㄏㄏ', 'zh-TW', 'translate_other_script')).toBe(true)
    })

    it('processes Traditional Chinese with Bopomofo for zh-CN in translate_other_script', () => {
      // 這個 = traditional evidence → opposite-script for zh-CN → translate
      expect(shouldSkipMessage('這個很好ㄏㄏ', 'zh-CN', 'translate_other_script')).toBe(false)
    })

    it('processes text with only simplified evidence', () => {
      expect(shouldSkipMessage('这个很热', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('processes text with mixed simplified and traditional evidence', () => {
      expect(shouldSkipMessage('这个熱吧', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('skips text with only shared Han characters (#46: 今天很好 → skip)', () => {
      expect(shouldSkipMessage('今天很好', 'zh-TW', 'translate_other_script')).toBe(true)
    })

    it('does not skip kana-less Japanese 手紙 for zh-TW in translate_other_script', () => {
      // 手 is known-shared, 紙 is a Traditional glyph also used in modern Japanese
      expect(shouldSkipMessage('手紙', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('does not skip kana-less Japanese 電話 for zh-TW in translate_other_script', () => {
      expect(shouldSkipMessage('電話', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('does not skip kana-less Japanese 自動車 for zh-TW in translate_other_script', () => {
      expect(shouldSkipMessage('自動車', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('does not skip kana-less Japanese 目的 for zh-TW in translate_other_script', () => {
      expect(shouldSkipMessage('目的', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('does not skip kana-less Japanese 個人的 for zh-TW in translate_other_script', () => {
      expect(shouldSkipMessage('個人的', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('does not skip kana-less Japanese 終了 for zh-TW in translate_other_script', () => {
      expect(shouldSkipMessage('終了', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('does not skip kana-less Japanese 完了 for zh-TW in translate_other_script', () => {
      expect(shouldSkipMessage('完了', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('does not skip kana-less Japanese 了解 for zh-TW in translate_other_script', () => {
      expect(shouldSkipMessage('了解', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('skips 今天真的很熱 for zh-TW (#46 explicit)', () => {
      // 今天真的很熱: 今/天/真/的/很 are shared, 熱 is traditional-only
      expect(shouldSkipMessage('今天真的很熱', 'zh-TW', 'translate_other_script')).toBe(true)
    })

    it('skips 今天很好 for zh-TW (shared marker 很 + shared Han)', () => {
      expect(shouldSkipMessage('今天很好', 'zh-TW', 'translate_other_script')).toBe(true)
    })

    it('processes 这个很好 for zh-TW (simplified marker 这 forces translation)', () => {
      // 这个 = simplified script evidence → opposite-script → translate
      expect(shouldSkipMessage('这个很好', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('skips 這個很好 for zh-TW (traditional marker 這 + same-script)', () => {
      expect(shouldSkipMessage('這個很好', 'zh-TW', 'translate_other_script')).toBe(true)
    })

    it('processes 你好吗 for zh-TW (simplified marker 吗 forces translation)', () => {
      expect(shouldSkipMessage('你好吗', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('skips 你好嗎 for zh-TW (traditional marker 嗎 + same-script)', () => {
      expect(shouldSkipMessage('你好嗎', 'zh-TW', 'translate_other_script')).toBe(true)
    })

    it('processes 今天真的很热 for zh-TW (#46 explicit)', () => {
      // 今天真的很热: 今/天/真/的/很 are shared, 热 is simplified-only
      expect(shouldSkipMessage('今天真的很热', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('processes 這個学校 for zh-TW (unknown Han overrides same-script evidence)', () => {
      // 這/個 are Traditional, 学/校 are unlisted Han → unknown overrides → translate
      expect(shouldSkipMessage('這個学校', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('processes 不会 for zh-TW (会 removed from KNOWN_SHARED)', () => {
      // 会 is now unknown Han → favor translation
      expect(shouldSkipMessage('不会', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('processes 参加 for zh-TW in translate_other_script (参 removed from SIMPLIFIED_ONLY)', () => {
      expect(shouldSkipMessage('参加', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('processes 宝石 for zh-TW in translate_other_script (宝 removed from SIMPLIFIED_ONLY)', () => {
      expect(shouldSkipMessage('宝石', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('processes 接触 for zh-TW in translate_other_script (触 removed from SIMPLIFIED_ONLY)', () => {
      expect(shouldSkipMessage('接触', 'zh-TW', 'translate_other_script')).toBe(false)
    })

    it('does not skip Japanese text with Kana (#46/51 explicit)', () => {
      expect(shouldSkipMessage('今天は暑い', 'zh-TW', 'translate_other_script')).toBe(false)
    })
  })

  describe('simplified target (zh-CN)', () => {
    it('skips text with only simplified evidence and a Chinese marker', () => {
      expect(shouldSkipMessage('这个很热', 'zh-CN', 'translate_other_script')).toBe(true)
    })

    it('processes text with only traditional evidence', () => {
      expect(shouldSkipMessage('這個很熱', 'zh-CN', 'translate_other_script')).toBe(false)
    })

    it('processes text with mixed evidence', () => {
      expect(shouldSkipMessage('这个熱吧', 'zh-CN', 'translate_other_script')).toBe(false)
    })

    it('skips text with only shared Han characters and a Chinese marker', () => {
      expect(shouldSkipMessage('今天很好', 'zh-CN', 'translate_other_script')).toBe(true)
    })

    it('processes 这个學校 for zh-CN (unknown Han overrides same-script evidence)', () => {
      // 这/个 are Simplified, 學/校 are unlisted Han → unknown overrides → translate
      expect(shouldSkipMessage('这个學校', 'zh-CN', 'translate_other_script')).toBe(false)
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

  it('does not skip Cyrillic mixed with Han (привет 国)', () => {
    expect(shouldSkipMessage('привет 国', 'zh-CN', 'translate_other_script')).toBe(false)
    expect(shouldSkipMessage('привет 国', 'zh-CN', 'skip_all_chinese')).toBe(false)
  })

  // Shared-Han Shinjitai-overlap examples in translate_other_script mode
  // After Shinjitai removal, these are unknown/unlisted Han → must translate
  it('processes Kanji-only Japanese 中国 for zh-TW in translate_other_script', () => {
    expect(shouldSkipMessage('中国', 'zh-TW', 'translate_other_script')).toBe(false)
  })

  it('processes Kanji-only Japanese 会社 for zh-TW in translate_other_script', () => {
    expect(shouldSkipMessage('会社', 'zh-TW', 'translate_other_script')).toBe(false)
  })

  it('processes Kanji-only Japanese 体調 for zh-TW in translate_other_script', () => {
    expect(shouldSkipMessage('体調', 'zh-TW', 'translate_other_script')).toBe(false)
  })

  // Unlisted Han must remain translatable in translate_other_script mode
  it('does not skip 学校 for zh-TW in translate_other_script (学 not in curated table)', () => {
    expect(shouldSkipMessage('学校', 'zh-TW', 'translate_other_script')).toBe(false)
  })

  it('does not skip 网络 for zh-TW in translate_other_script (网/络 not in curated table)', () => {
    expect(shouldSkipMessage('网络', 'zh-TW', 'translate_other_script')).toBe(false)
  })
})
