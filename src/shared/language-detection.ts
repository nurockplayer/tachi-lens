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
  hasJapaneseKana: boolean
  hasHangul: boolean
  hasLatinLetter: boolean
}

// ─── Curated evidence tables ─────────────────────────────────────────────────

/** Characters exclusive to Simplified Chinese. */
const SIMPLIFIED_ONLY =
  '体国长东马车门开关见贝风飞发电对时来乐个为书说话认识过还' +
  '这会当们几处么两让儿习头买卖红级纪经给组织纸线练张' +
  '将奖医义农动区华协单双号罗备宝报边变参层产场陈础触传' +
  '达带导点独断夺队吨热'

/** Characters exclusive to Traditional Chinese. */
const TRADITIONAL_ONLY =
  '體國長東馬車門開關見貝風飛發電對時來樂個為書說話認識過還' +
  '這會當們幾處麼兩讓兒習頭買賣紅級紀經給組織紙線練張' +
  '將獎醫義農動區華協單雙號羅備寶報邊變參層產場陳礎觸傳' +
  '達帶導點獨斷奪隊噸熱'

const SIMPLIFIED_SET = new Set(SIMPLIFIED_ONLY)
const TRADITIONAL_SET = new Set(TRADITIONAL_ONLY)

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

const isLatinLetter = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A) ||
  (code >= 0xC0 && code <= 0x24F && code !== 0xD7 && code !== 0xF7) ||
  (code >= 0xFF21 && code <= 0xFF3A) || (code >= 0xFF41 && code <= 0xFF5A)

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
 * Japanese Kana, Hangul, Latin letters, and distinguishes Simplified-only
 * vs Traditional-only vs shared Han characters using the curated evidence tables.
 */
export function analyzeMessageScript(text: string): ScriptEvidence {
  let hasHan = false
  let hasSimplifiedOnly = false
  let hasTraditionalOnly = false
  let hasSharedHan = false
  let hasJapaneseKana = false
  let hasHangul = false
  let hasLatinLetter = false

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
      if (SIMPLIFIED_SET.has(char)) {
        hasSimplifiedOnly = true
      } else if (TRADITIONAL_SET.has(char)) {
        hasTraditionalOnly = true
      } else {
        hasSharedHan = true
      }
      continue
    }

    if (isLatinLetter(code)) {
      hasLatinLetter = true
    }
  }

  return {
    hasHan,
    hasSimplifiedOnly,
    hasTraditionalOnly,
    hasSharedHan,
    hasJapaneseKana,
    hasHangul,
    hasLatinLetter,
  }
}

/**
 * Decide whether a chat message should be skipped for the given target language
 * and Chinese variant mode.
 *
 * Rules:
 * 1. Non-zh target families are never skipped here.
 * 2. Text with Japanese Kana or Hangul is never classified as Chinese.
 * 3. Text without any Han characters is not confidently Chinese.
 * 4. Latin letters mixed with Han indicate a mixed-language message;
 *    these are not skipped.
 * 5. `skip_all_chinese`: skip messages with explicit Simplified or Traditional
 *    evidence. Shared-only Han text is conservatively kept translatable to
 *    avoid misclassifying Kanji-only Japanese.
 * 6. `translate_other_script`:
 *    - Generic zh target → never skip (conservative, favor translation).
 *    - For a specific script target (simplified or traditional):
 *      - Only same-script evidence → skip
 *      - Opposite-script evidence → process (translate)
 *      - Mixed evidence → process
 *      - Shared-only characters → skip
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

  // Mixed Latin+Han → keep translatable
  if (evidence.hasLatinLetter) return false

  if (mode === 'skip_all_chinese') {
    // Only skip when there is explicit simplified or traditional evidence.
    // Pure shared-Han text (e.g. 開始, 大人山水) could be Kanji-only Japanese
    // and is not confidently identifiable as Chinese.
    return evidence.hasSimplifiedOnly || evidence.hasTraditionalOnly
  }

  // mode === 'translate_other_script'
  const scriptTarget = classifyChineseScriptTarget(targetLanguage)

  // Generic zh without script preference → conservative, do not skip
  if (scriptTarget === 'generic' || scriptTarget === null) return false

  if (scriptTarget === 'simplified') {
    if (evidence.hasSimplifiedOnly && !evidence.hasTraditionalOnly) {
      return true
    }
    if (evidence.hasTraditionalOnly) {
      return false
    }
    // Only shared characters → skip (confidently Chinese, ambiguous script)
    return true
  }

  // scriptTarget === 'traditional'
  if (evidence.hasTraditionalOnly && !evidence.hasSimplifiedOnly) {
    return true
  }
  if (evidence.hasSimplifiedOnly) {
    return false
  }
  // Only shared characters → skip
  return true
}
