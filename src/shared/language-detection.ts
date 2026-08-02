/**
 * Local, deterministic language/script detection for Twitch chat messages.
 *
 * This module provides pure functions for:
 * - Normalizing locale strings to language families
 * - Classifying Chinese locale script targets (simplified/traditional/generic)
 * - Analyzing message content for CJK script evidence
 * - Deciding whether a message can be skipped based on target language and mode
 *
 * No external dependencies, network calls, or settings persistence.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type ChineseVariantMode =
  | 'skip_all_chinese'
  | 'translate_other_script'

export interface ScriptEvidence {
  hasHan: boolean
  hasSimplifiedOnly: boolean
  hasTraditionalOnly: boolean
  hasSharedHan: boolean
  hasUnknownHan: boolean
  hasJapaneseKana: boolean
  hasHangul: boolean
  hasForeignLetter: boolean
  hasChineseMarker: boolean
}

// ─── Curated evidence tables ─────────────────────────────────────────────────

/** Characters exclusive to Simplified Chinese. */
const SIMPLIFIED_ONLY =
  '长东马车门开关见贝风飞发电对时乐个为书说话认识过还' +
  '这们几处么两让儿习头买卖红级纪经给组织纸线练张' +
  '奖义农动华协单罗备报边变层产场陈础传' +
  '达带导夺队吨热'

/** Characters exclusive to Traditional Chinese. */
const TRADITIONAL_ONLY =
  '體國長東馬車門開關見貝風飛發電對時來樂個為書說話認識過還' +
  '這會當們幾處麼兩讓兒習頭買賣紅級紀經給組織紙線練張' +
  '將獎醫義農動區華協單雙號羅備寶報邊變參層產場陳礎觸傳' +
  '達帶導點獨斷奪隊噸熱'

const SIMPLIFIED_SET = new Set(SIMPLIFIED_ONLY)
const TRADITIONAL_SET = new Set(TRADITIONAL_ONLY)

/**
 * Characters genuinely shared between Simplified and Traditional Chinese.
 *
 * These have the same glyph in both scripts and are common enough that
 * their presence alone does not indicate a specific script. Inclusion is
 * conservative — only characters that are known to be identical in both
 * scripts and that help resolve ambiguous shared-only text.
 *
 * Characters absent from all three tables (SIMPLIFIED_ONLY, TRADITIONAL_ONLY,
 * KNOWN_SHARED) are classified as "unknown Han" and favor translation.
 */
const KNOWN_SHARED =
  '人大上山水中小日月天手工生心力口王白石田目足' +
  '土火木水火土金木' +
  '文子父女母子母' +
  '今明早星空原海名林花音然思安心自' +
  '先前左右南北东西里内外上下' +
  '千百元角分' +
  '我你他她它们' +
  '不也而已何其如之' +
  '能可要用' +
  '好高正新老' +
  '真' +
  '雨'

const KNOWN_SHARED_SET = new Set(KNOWN_SHARED)

/**
 * Strong Chinese-language markers: function and structural characters that
 * are characteristic of Mandarin and not ordinary modern-Japanese Kanji
 * usage.
 *
 * Simplified/Traditional glyph evidence (e.g. 紙, 時, 車) also appears
 * unchanged in Japanese, so it cannot establish that the language is
 * Chinese. A message containing a marker is confidently Chinese; script
 * evidence alone is never treated as language evidence.
 *
 * 的 marks the Chinese possessive 的-particle (Japanese uses の);
 * 了/吧/啊/呢 are clause-final particles with no Japanese equivalent.
 */
const CHINESE_LANGUAGE_MARKERS = '的了吗呢吧啊很'
const CHINESE_MARKER_SET = new Set(CHINESE_LANGUAGE_MARKERS)

// ─── Unicode ranges (BMP only) ───────────────────────────────────────────────

const isCJK = (code: number): boolean => code >= 0x4E00 && code <= 0x9FFF

const isHiragana = (code: number): boolean => code >= 0x3040 && code <= 0x309F

const isKatakana = (code: number): boolean =>
  (code >= 0x30A0 && code <= 0x30FF) ||
  (code >= 0x31F0 && code <= 0x31FF) || // Katakana Phonetic Extensions
  (code >= 0xFF66 && code <= 0xFF9D)    // Halfwidth Katakana

const isHangul = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x11FF) || // Hangul Jamo
  (code >= 0x3130 && code <= 0x318F) || // Hangul Compatibility Jamo
  (code >= 0xAC00 && code <= 0xD7AF) || // Hangul Syllables
  (code >= 0xA960 && code <= 0xA97C) || // Hangul Jamo Extended-A
  (code >= 0xD7B0 && code <= 0xD7FF)    // Hangul Jamo Extended-B

/**
 * Any Unicode letter that is not Han, Kana, or Hangul.
 *
 * Han, Kana, and Hangul are handled earlier in the analysis loop (each
 * `continue`s), so a character reaching this check that satisfies
 * the Letter property is from another script (Latin, Cyrillic, Greek,
 * Arabic, Hebrew, etc.) and marks the message as mixed-language.
 */
const isForeignLetter = (char: string): boolean => /\p{L}/u.test(char)

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Normalize a locale string to its base language family.
 *
 * Strips region/script subtags and lowercases the result.
 * Examples: 'zh-TW' → 'zh', 'en-US' → 'en', 'ZH_TW' → 'zh'
 */
export function normalizeLocale(locale: string): string {
  return (locale.split(/[-_]/)[0] ?? '').toLowerCase()
}

/**
 * Classify a Chinese locale's script target preference.
 *
 * Returns:
 * - 'simplified'  for zh-CN, zh-Hans, zh-SG
 * - 'traditional' for zh-TW, zh-Hant, zh-HK, zh-MO
 * - 'generic'     for zh without a script or region hint
 * - null          for non-zh locales
 */
export function classifyChineseScriptTarget(
  locale: string,
): 'simplified' | 'traditional' | 'generic' | null {
  const family = normalizeLocale(locale)
  if (family !== 'zh') return null

  const lower = locale.toLowerCase().replace(/_/g, '-')

  if (lower.includes('hans')) return 'simplified'
  if (lower.includes('hant')) return 'traditional'

  const parts = lower.split('-')
  for (const part of parts) {
    if (part === 'cn' || part === 'sg') return 'simplified'
    if (part === 'tw' || part === 'hk' || part === 'mo') return 'traditional'
  }

  return 'generic'
}

/**
 * Analyze a message string for script evidence.
 *
 * Iterates character-by-character to detect Han (CJK Ideographs),
 * Japanese Kana, Hangul, foreign letters, Chinese-language markers,
 * and distinguishes Simplified-only vs Traditional-only vs shared Han
 * characters using the curated evidence tables.
 *
 * Chinese-language markers are checked before script-variant classification
 * so a marker character (的, 很, 了, …) is not also recorded as shared or
 * unknown Han.
 */
export function analyzeMessageScript(text: string): ScriptEvidence {
  let hasHan = false
  let hasSimplifiedOnly = false
  let hasTraditionalOnly = false
  let hasSharedHan = false
  let hasUnknownHan = false
  let hasJapaneseKana = false
  let hasHangul = false
  let hasForeignLetter = false
  let hasChineseMarker = false

  for (const char of text) {
    const code = char.charCodeAt(0)

    if (isHiragana(code) || isKatakana(code)) {
      hasJapaneseKana = true
      continue
    }

    if (isHangul(code)) {
      hasHangul = true
      continue
    }

    if (isCJK(code)) {
      hasHan = true
      if (CHINESE_MARKER_SET.has(char)) {
        hasChineseMarker = true
        continue
      }
      if (SIMPLIFIED_SET.has(char)) {
        hasSimplifiedOnly = true
      } else if (TRADITIONAL_SET.has(char)) {
        hasTraditionalOnly = true
      } else if (KNOWN_SHARED_SET.has(char)) {
        hasSharedHan = true
      } else {
        hasUnknownHan = true
      }
      continue
    }

    if (isForeignLetter(char)) {
      hasForeignLetter = true
    }
  }

  return {
    hasHan,
    hasSimplifiedOnly,
    hasTraditionalOnly,
    hasSharedHan,
    hasUnknownHan,
    hasJapaneseKana,
    hasHangul,
    hasForeignLetter,
    hasChineseMarker,
  }
}

/**
 * Decide whether a chat message should be skipped for the given target language
 * and Chinese variant mode.
 *
 * Chinese-language confidence comes only from CHINESE_LANGUAGE_MARKERS
 * (的, 了, 吧, 啊, 呢, 很). Simplified/Traditional glyph evidence is used
 * only to determine script direction and is never treated as proof that the
 * language is Chinese, because those glyphs also appear unchanged in modern
 * Japanese.
 *
 * Rules:
 * 1. Non-zh target families are never skipped here.
 * 2. Text with Japanese Kana or Hangul is never classified as Chinese.
 * 3. Text without any Han characters is not confidently Chinese.
 * 4. Letters from any non-Han/Kana/Hangul script mixed with Han indicate a
 *    mixed-language message; these are not skipped.
 * 5. Without a Chinese-language marker the message is not confidently
 *    Chinese and stays translatable (conservative).
 * 6. `skip_all_chinese`: any confidently Chinese message is skipped.
 * 7. `translate_other_script`:
 *    - Generic zh target → never skip (conservative, favor translation).
 *    - Unknown/unclassified Han overrides same-script evidence → translate.
 *    - For a specific script target (simplified or traditional):
 *      - Only same-script evidence → skip
 *      - Opposite-script evidence → process (translate)
 *      - Mixed evidence → process
 *      - Known-shared-only characters → skip
 */
export function shouldSkipMessage(
  text: string,
  targetLanguage: string,
  mode: ChineseVariantMode,
): boolean {
  const family = normalizeLocale(targetLanguage)
  if (family !== 'zh') return false

  const evidence = analyzeMessageScript(text)

  // Japanese Kana or Hangul → not Chinese, do not skip
  if (evidence.hasJapaneseKana || evidence.hasHangul) return false

  // No Han characters → nothing to skip
  if (!evidence.hasHan) return false

  // Any foreign (non-Han/Kana/Hangul) letter mixed with Han → mixed-language,
  // keep translatable
  if (evidence.hasForeignLetter) return false

  // Without a Chinese-language marker the message is not confidently Chinese.
  // S/T glyph evidence alone (e.g. 手紙, 電話, 自動車) could be Japanese.
  if (!evidence.hasChineseMarker) return false

  if (mode === 'skip_all_chinese') {
    return true
  }

  // mode === 'translate_other_script'
  const scriptTarget = classifyChineseScriptTarget(targetLanguage)

  // Generic zh without script preference → conservative, do not skip
  if (scriptTarget === 'generic' || scriptTarget === null) return false

  // Unknown Han overrides same-script evidence: an unlisted opposite-script
  // character mixed with recognized same-script characters is not confidently
  // in the target script → favor translation.
  if (evidence.hasUnknownHan) return false

  if (scriptTarget === 'simplified') {
    if (evidence.hasSimplifiedOnly && !evidence.hasTraditionalOnly) {
      return true
    }
    if (evidence.hasTraditionalOnly) {
      return false
    }
    // Only known-shared characters → skip (confidently Chinese, ambiguous script)
    return true
  }

  // scriptTarget === 'traditional'
  if (evidence.hasTraditionalOnly && !evidence.hasSimplifiedOnly) {
    return true
  }
  if (evidence.hasSimplifiedOnly) {
    return false
  }
  // Only known-shared characters → skip
  return true
}
