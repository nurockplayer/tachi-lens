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
  /** Total number of Han characters (CJK Ideographs). */
  hanCount: number
  /** Total number of non-Han/Kana/Hangul letters (Latin, Cyrillic, …). */
  foreignLetterCount: number
  /**
   * Weighted count of Mandarin structural/function characters.
   *
   * These are characters that appear constantly in ordinary Mandarin chat
   * but are rarely used as standalone characters in modern Japanese. The
   * score is deliberately conservative (see CHINESE_STRUCTURAL): common
   * Japanese Kanji such as 的 is weighted low, and characters that are
   * ordinary Japanese usage are excluded entirely.
   */
  chineseStructureScore: number
  /**
   * Weighted count of strong Mandarin structural characters only (weight 3
   * in CHINESE_STRUCTURAL: 這/啦/沒/嗎/什/麼/們/啊, …).
   *
   * Unlike chineseStructureScore, this excludes weak/ambiguous Kanji
   * (weight 1–2: 個/用/不/可/能/是/…), which also appear in ordinary
   * kana-less Japanese words (個人, 利用, 可能). Weak characters can never
   * accumulate into a confident-Chinese signal on their own.
   */
  strongStructureScore: number
  /**
   * Whether a Mandarin personal pronoun (我/你/他/她/它) is used as an actual
   * pronoun — i.e. immediately followed by a Mandarin structural character
   * (我要, 你的, 他是). Bare presence is not enough: in 他人 (Japanese
   * "other people") 他 precedes a noun and is part of a kana-less Japanese
   * compound, not a Mandarin pronoun.
   */
  hasMandarinPronoun: boolean
  /**
   * Whether 就 or 把 is used as a Mandarin function word — i.e. immediately
   * followed by a Mandarin structural character (就可, 就把). These glyphs
   * also occur inside kana-less Japanese compounds (就業, 把握) where they are
   * followed by a non-structural noun; the follower context distinguishes the
   * Mandarin usage.
   */
  hasMandarinFunction: boolean
}

// ─── Curated evidence tables ─────────────────────────────────────────────────

/** Characters exclusive to Simplified Chinese. */
const SIMPLIFIED_ONLY =
  '长东马车门开关见贝风飞发电对时乐个为书说话认识过还' +
  '这们几处么两让儿习头买卖红级纪经给组织纸线练张' +
  '奖义农动华协单罗备报边变层产场陈础传' +
  '达带导夺队吨热吗'

/** Characters exclusive to Traditional Chinese. */
const TRADITIONAL_ONLY =
  '體國長東馬車門開關見貝風飛發電對時來樂個為書說話認識過還' +
  '這會當們幾處麼兩讓兒習頭買賣紅級紀經給組織紙線練張' +
  '將獎醫義農動區華協單雙號羅備寶報邊變參層產場陳礎觸傳' +
  '達帶導點獨斷奪隊噸熱嗎'

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
  '人的大上山水中小日月天手工生心力口王白石田目足' +
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
  '雨的了吗' +
  '很呢吧啊'

const KNOWN_SHARED_SET = new Set(KNOWN_SHARED)

/**
 * Conservative Chinese-language markers.
 *
 * These structural/function characters are used as standalone Mandarin
 * particles and are not ordinary modern-Japanese Kanji usage. 的 and 了
 * are deliberately excluded because they occur in common kana-less
 * Japanese words (目的, 個人的, 終了, 完了, 了解).
 *
 * The marker set spans both script variants so a marker character can
 * also contribute Simplified/Traditional script evidence:
 * - Simplified markers: 这, 们, 吗
 * - Traditional markers: 這, 們, 嗎
 * - Shared markers: 很, 呢, 吧, 啊
 */
const CHINESE_LANGUAGE_MARKERS = '这们吗這們嗎很呢吧啊'
const CHINESE_MARKER_SET = new Set(CHINESE_LANGUAGE_MARKERS)

/**
 * Mandarin structural/function characters used for Chinese-language confidence.
 *
 * These are characters that appear constantly in ordinary Mandarin live chat
 * as grammatical particles or high-frequency function words. Each is weighted
 * by how strongly it signals Chinese rather than kana-less Japanese:
 *
 * Weight 3 (strong Mandarin structural signal):
 * - 這/这 are Mandarin demonstratives with no ordinary standalone Japanese
 *   equivalent.
 * - 啦 is a colloquial Mandarin sentence-final particle.
 * - 對/对 as a response word ("yes/right") is distinctively Mandarin; in
 *   Japanese 対 is only an affix in on-yomi compounds.
 * - 沒 (U+6C92) negates existence in Mandarin; the Traditional glyph is not
 *   ordinary modern Japanese usage. (Simplified 没 U+6CA1 is weight 1 — it is
 *   also ordinary Japanese Kanji in 没収/水没/没入.)
 * - 嗎/吗/呢/吧 are Mandarin sentence-final particles.
 * - 麼/么 form the Mandarin interrogative 什麼/什么 ("what").
 * - 們/们 is the Mandarin plural suffix.
 * - 啊 is a Mandarin sentence-final particle.
 *
 * Weight 2 (common Mandarin grammar, with real kana-less Japanese
 * homographs that weaken the signal):
 * - 很 (Mandarin degree adverb 很熱/很好).
 * - 是 (Mandarin copula 是/不是/那是; rare as standalone Japanese).
 * - 個/个 are Mandarin demonstratives/counters (這個/那个) but ordinary
 *   Japanese Kanji in on-yomi compounds (個人, 個別).
 *
 * Weight 1 (weak, but accumulate with other evidence):
 * - 不 (Mandarin negation 不客氣/不會; Japanese 不 is an affix in 不安/不明),
 * - 的 (Japanese homograph 目的/個人的), 好 (Japanese 好む is rarer),
 * - 我/你/他/她/它 (Mandarin pronouns; Japanese uses 私/あなた/彼/彼女),
 * - 要/用, 了 (Mandarin aspect particle; Japanese homograph 了 in 了解),
 * - 會/会 (Mandarin modal 會/不会; Japanese 会 is 会う in kun-yomi),
 * - 可/能 (can/may; Japanese 能/可 are affixes in 可能, 能力),
 * - 没 (U+6CA1, Simplified and ordinary Japanese Kanji in 没収/水没/没入),
 * - 什 (U+4EC0, ordinary Japanese Kanji in 什器).
 *
 * The list is deliberately conservative: characters are only added when they
 * accumulate across a sentence and cannot flip a short kana-less Japanese word
 * like 手紙 (手 shared + 紙 traditional) or 目的 (shared + shared) into a false
 * Chinese classification. Weights are tuned so 手紙/電話/自動車/目的/終了 all
 * stay below the confidence threshold.
 */
const CHINESE_STRUCTURAL: Record<string, number> = {
  // Strong Mandarin structural particles (weight 3). None of these is
  // ordinary standalone kana-less Japanese usage, so a single occurrence is
  // already strong Chinese evidence.
  //
  // Note 沒 (U+6C92, Traditional) is strong while 没 (U+6CA1, Simplified /
  // Japanese shinjitai) is weight 1: 没収/水没/没入 are ordinary kana-less
  // Japanese words using the Simplified/shinjitai glyph, so 没 must not act
  // as decisive Mandarin evidence. 沒 stays strong because Traditional 沒 is
  // not an ordinary modern Japanese usage.
  這: 3, 这: 3, 啦: 3, 對: 3, 对: 3, 沒: 3, 嗎: 3, 吗: 3, 呢: 3, 吧: 3,
  麼: 3, 么: 3, 們: 3, 们: 3, 啊: 3,
  // Common Mandarin grammar (weight 2). 個/个 are ordinary Japanese Kanji in
  // on-yomi compounds (個人, 個別) but the demonstrative-sense 這個/那个 is
  // distinctively Mandarin, so they stay at 2.
  很: 2, 是: 2, 個: 2, 个: 2,
  // Weak but accumulating (weight 1). All of these are ordinary kana-less
  // Japanese Kanji in common words (目的/終了/了解/可能性/社会), so a single
  // occurrence never clears the threshold; they only accumulate with stronger
  // evidence.
  不: 1, 的: 1, 了: 1, 好: 1, 我: 1, 你: 1, 他: 1, 她: 1, 它: 1,
  要: 1, 用: 1, 會: 1, 会: 1, 可: 1, 能: 1, 没: 1, 什: 1,
}

/**
 * Mandarin personal pronouns.
 *
 * A pronoun only counts as Mandarin evidence when it is actually used as a
 * pronoun — immediately followed by a Mandarin structural character (我要,
 * 你的, 他是, 我們). The bare glyph also occurs in kana-less Japanese
 * compounds (他人 = "other people", 我慢 = "patience"), where it is followed
 * by a noun, so the follower context is required (#182 follow-up).
 */
const MANDARIN_PRONOUNS = new Set(['我', '你', '他', '她', '它'])

/**
 * Characters that can directly follow a Mandarin pronoun in ordinary chat:
 * predicates, aspect/possessive particles, modals, and the plural suffix 們.
 * If a pronoun is followed by anything else (a noun, as in Japanese 他人),
 * it is treated as a kana-less Japanese compound instead.
 */
const MANDARIN_PRONOUN_FOLLOWERS = new Set([
  // predicates / copula
  '要', '是', '會', '会', '能', '可', '有', '在', '想', '說', '说', '看', '走', '去', '來', '来',
  // aspect / possessive / structural particles
  '的', '了', '很', '好', '不', '就', '都', '還', '还', '也', '才', '吧', '嗎', '吗', '呢', '啊', '啦',
  // Mandarin degree modifiers (我真/我太/我最/我更/我挺/我超)
  '真', '太', '最', '更', '挺', '超',
  // plural suffix
  '們', '们',
])

/**
 * Mandarin function-word / short-phrase contexts used for the mixed branch.
 *
 * These Mandarin grammatical collocations (可以, 不用, 就是, 就好, 就會) do not
 * occur in kana-less Japanese, and 就 followed by a structural character
 * (就可) distinguishes the Mandarin adverb from the Japanese compound 就業.
 * A bare 把/就 occurrence is NOT sufficient — Japanese compounds 把握/把持
 * must stay translatable.
 */
const MANDARIN_FUNCTION_PHRASES = ['可以', '就是', '就好', '就會']

/**
 * Structural score required before Han-only text is considered confidently
 * Chinese. Tuned against the kana-less Japanese guard cases (手紙, 電話,
 * 自動車, 目的, 個人的, 終了, 完了, 了解, 可能, 社会) which all stay below
 * it, and the #182 observed Chinese messages which all clear it.
 */
const CHINESE_STRUCTURE_CONFIDENCE_THRESHOLD = 4

/**
 * Minimum Han-to-foreign-letter ratio before the mixed-letter branch may trust
 * the aggregate structural score.
 *
 * A Latin acronym embedded in a long Chinese sentence is fine to skip on weak
 * structural evidence (把手機的畫面傳到電腦用OBS開台就可以不用斷: 19 Han vs 3
 * Latin, ratio ≈ 6.3). But a short kana-less Japanese phrase followed by an
 * acronym (個人利用不可OBS: 6 Han vs 3 Latin, ratio 2) must not let the same
 * weak/ambiguous Kanji accumulate into Chinese confidence. Requiring Han to
 * dominate by at least 4× the foreign letters keeps the weak-accumulation path
 * reserved for clearly Han-dominant messages only.
 */
const HAN_FOREIGN_DOMINANCE_RATIO = 4

/**
 * Minimum absolute Han count before the mixed-letter branch may skip a
 * message at all.
 *
 * The ratio gate alone is defeated by a single Latin letter: 使用不可能w
 * (5 Han vs 1 Latin) and 個人利用不可w (6 Han vs 1 Latin) would pass
 * hanCount >= 4 * 1 and skip on weak Kanji accumulation. The mixed-letter
 * path must therefore also require a substantial Han run, representing a long
 * Chinese sentence with an embedded acronym rather than a short Japanese
 * phrase with one trailing Latin character. 把手機的畫面傳到電腦用OBS開台就可
 * 以不用斷 (19 Han) clears it; the 5-6 Han Japanese phrases do not.
 */
const MIN_HAN_COUNT_FOR_MIXED = 12

/**
 * Strong structural score required before Han-only text is considered
 * confidently Chinese by strong characters alone.
 *
 * Strong characters (weight 3) are unambiguously Mandarin and never ordinary
 * kana-less Japanese usage, so a single occurrence is decisive. Weak characters
 * (weight 1–2) share glyphs with common Japanese Kanji (個/用/不/可/能 in
 * 個人/利用/可能) and are deliberately excluded from this score, so several of
 * them — e.g. 個人利用不可 (個2+用1+不1+可1) — can never accumulate into a
 * confident-Chinese signal by themselves (#182 follow-up regression).
 */
const STRONG_STRUCTURE_CONFIDENCE_THRESHOLD = 3

/**
 * Short Mandarin chat phrases that are too short to reach the structural
 * threshold on character weights alone but are unambiguously Chinese.
 *
 * These are full-message matches only (no substring matching), so a Japanese
 * sentence that happens to contain one of these strings is never affected.
 * Each phrase is a phrase that has no ordinary kana-less Japanese reading.
 */
const CHINESE_PHRASES = new Set([
  '不客氣',
  '不客气',
  '我才',
  '謝謝',
  '谢谢',
  '可以',
  '好的',
  '知道了',
])

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
 * Bopomofo (Zhuyin) phonetic characters, used in Traditional Chinese
 * chat. Neutral Chinese phonetic content: it is not a foreign letter and
 * does not determine Simplified/Traditional direction.
 */
const isBopomofo = (code: number): boolean =>
  (code >= 0x3100 && code <= 0x312F) || // Bopomofo
  (code >= 0x31A0 && code <= 0x31BF)    // Bopomofo Extended

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
 * A marker character may also contribute script-variant evidence:
 * 这/们/吗 are Simplified markers, 這/們/嗎 are Traditional markers, and
 * 很/呢/吧/啊 are shared markers. Markers do not stop classification.
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
  let hanCount = 0
  let foreignLetterCount = 0
  let chineseStructureScore = 0
  let strongStructureScore = 0
  let hasMandarinPronoun = false
  let hasMandarinFunction = false

  // Iterate by code point (not UTF-16 index): astral-plane letters such as the
  // stylized 𝕙𝕖𝕝𝕝𝕠 used in Twitch text are surrogate pairs, and indexing the
  // string yields isolated halves that never match \p{L}. Array.from splits
  // into full code points so foreign letters are detected correctly.
  const chars = Array.from(text)

  // Return the index of the next meaningful (non-separator) code point after
  // `from`, or -1. Punctuation/whitespace/marks/format between a Mandarin
  // pronoun and its predicate (我，真的不可以) must be skipped, matching the
  // phrase-strip regex.
  const nextMeaningful = (from: number): number => {
    for (let j = from; j < chars.length; j++) {
      if (!/[\p{P}\p{S}\p{M}\p{Cf}\s]/u.test(chars[j]!)) {
        return j
      }
    }
    return -1
  }

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!
    const code = char.charCodeAt(0)

    if (isHiragana(code) || isKatakana(code)) {
      hasJapaneseKana = true
      continue
    }

    if (isHangul(code)) {
      hasHangul = true
      continue
    }

    if (isBopomofo(code)) {
      // Neutral Chinese phonetic content: no foreign-letter evidence,
      // no Han evidence, and no S/T direction.
      continue
    }

    if (isCJK(code)) {
      hasHan = true
      hanCount++
      if (CHINESE_MARKER_SET.has(char)) {
        hasChineseMarker = true
      }
      // A Mandarin pronoun counts only with contextual evidence: the pronoun
      // is followed by a Mandarin predicate/particle (我要, 你的, 他是),
      // skipping any separators (我，真的不可以). The glyph after that
      // predicate must itself be a Mandarin structural character or the end of
      // the message, so Japanese 他X prefixes are excluded: 他会場利用不可
      // (他→会→場) is "other venue" and must not be a pronoun, while 他很好
      // (他→很→好) and 我真的不可以 (我→真→的) are.
      if (MANDARIN_PRONOUNS.has(char)) {
        const first = nextMeaningful(i + 1)
        if (first >= 0 && MANDARIN_PRONOUN_FOLLOWERS.has(chars[first]!)) {
          const second = nextMeaningful(first + 1)
          if (
            second < 0 ||
            CHINESE_STRUCTURAL[chars[second]!] !== undefined ||
            MANDARIN_PRONOUN_FOLLOWERS.has(chars[second]!)
          ) {
            hasMandarinPronoun = true
          }
        }
      }
      // 就/把 count as Mandarin function words. 就 needs a structural
      // follower (就可) to distinguish the Mandarin adverb from the Japanese
      // compound 就業. A bare 把 is not enough — Japanese 把握/把持 are
      // ordinary compounds; Mandarin ba-constructions are covered via the
      // MANDARIN_FUNCTION_PHRASES scan below.
      if (char === '就') {
        const follower = nextMeaningful(i + 1)
        if (follower >= 0 && CHINESE_STRUCTURAL[chars[follower]!] !== undefined) {
          hasMandarinFunction = true
        }
      }
      const weight = CHINESE_STRUCTURAL[char] ?? 0
      chineseStructureScore += weight
      if (weight >= 3) {
        strongStructureScore += weight
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
      foreignLetterCount++
    }
  }

  // Mandarin function-word collocations (可以, 就是, 就好, 就會) are
  // Mandarin contexts that unlock the mixed-branch aggregate path without
  // trusting a bare 把/就. 可以 is additionally required to be followed by a
  // Mandarin structural character or the end of the message, so a cross-word
  // match in 許可以外 (許可|以外, Japanese "except permission") does not count.
  if (!hasMandarinFunction) {
    for (const phrase of MANDARIN_FUNCTION_PHRASES) {
      if (phrase === '可以') {
        let idx = text.indexOf(phrase)
        while (idx >= 0) {
          const after = nextMeaningful(idx + phrase.length)
          if (
            after < 0 ||
            CHINESE_STRUCTURAL[chars[after]!] !== undefined
          ) {
            hasMandarinFunction = true
            break
          }
          idx = text.indexOf(phrase, idx + 1)
        }
      } else if (text.includes(phrase)) {
        hasMandarinFunction = true
        break
      }
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
    hanCount,
    foreignLetterCount,
    chineseStructureScore,
    strongStructureScore,
    hasMandarinPronoun,
    hasMandarinFunction,
  }
}

/**
 * Decide whether a chat message should be skipped for the given target language
 * and Chinese variant mode.
 *
 * Chinese-language confidence uses a deterministic weighted evidence model
 * (CHINESE_STRUCTURAL) rather than a tiny positive-marker whitelist (#182).
 * Simplified/Traditional glyph evidence is used only to determine script
 * direction and is never treated as proof that the language is Chinese,
 * because those glyphs also appear unchanged in modern Japanese.
 *
 * `skip_all_chinese` rules:
 * 1. Non-zh target families are never skipped here.
 * 2. Text with Japanese Kana or Hangul is never classified as Chinese.
 * 3. Text without any Han characters is not confidently Chinese.
 * 4. Foreign (non-Han/Kana/Hangul) letters mixed with Han are tolerated only
 *    when Han clearly dominates the message AND the Chinese structural score
 *    is strong (e.g. a Chinese sentence with an embedded acronym like OBS).
 *    Otherwise mixed-language text stays translatable.
 * 5. Han-only text is confidently Chinese when the weighted Chinese structure
 *    score clears CHINESE_STRUCTURE_CONFIDENCE_THRESHOLD. Short kana-less
 *    Japanese words (手紙, 電話, 自動車, 目的, 終了) stay below it.
 *
 * `translate_other_script` rules (preserved from #46/#51/#55):
 * 1. Letters from any non-Han/Kana/Hangul script mixed with Han → translate.
 * 2. Without a Chinese-language marker the message is not confidently
 *    Chinese and stays translatable (conservative).
 * 3. Generic zh target → never skip (conservative, favor translation).
 * 4. Unknown/unclassified Han overrides same-script evidence → translate.
 * 5. For a specific script target (simplified or traditional):
 *    - Only same-script evidence → skip
 *    - Opposite-script evidence → process (translate)
 *    - Mixed evidence → process
 *    - Known-shared-only characters → skip
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

  if (mode === 'skip_all_chinese') {
    // Short unambiguous Mandarin phrases (不客氣, 我才) clear the gate even
    // though their character weights alone stay below the threshold.
    // Punctuation/symbols/marks/format/whitespace are stripped first so
    // 不客氣！, 我才～, 不客氣❤️ (U+FE0F variation selector) and
    // 不客氣👨👩👧 (U+200D ZWJ format char) still match while 手紙 is never
    // affected.
    const phraseStripped = text.replace(/[\p{P}\p{S}\p{M}\p{Cf}\s]/gu, '')
    const isChinesePhrase = CHINESE_PHRASES.has(phraseStripped)

    // Mandarin-specific contextual evidence that unlocks the weak aggregate
    // path in the MIXED branch only. A bare aggregate of ambiguous Kanji
    // (個/用/不/可/能) is never enough — kana-less Japanese compounds reach
    // 4+ the same way (個人利用不可 = 5). The aggregate is trusted only when
    // the text also contains a Mandarin pronoun used as a pronoun (我要, 你的,
    // 他是) or a Mandarin function word (就可, 就把), AND the message is
    // Han-dominant (the dominance gate below).
    //
    // The 的-attributive-particle is deliberately NOT used as context here:
    // kana-less Japanese also forms 的 + Han (個人的使用不可, 個人的利用不可),
    // so a 的 followed by Han cannot distinguish Mandarin from Japanese.
    // Likewise 就/把 only count when followed by a structural character — the
    // same glyphs inside Japanese compounds (就業, 把握) are not function words.
    const hasMandarinContext =
      evidence.hasMandarinPronoun || evidence.hasMandarinFunction

    // Foreign letters are tolerated only when Han overwhelmingly dominates
    // the foreign letters so they read as an embedded acronym rather than
    // mixed language. The dominance gate applies uniformly — before marker,
    // strong, or weak evidence — so genuinely mixed chat (hello 這個,
    // English 對啊) stays translatable even when the Chinese segment contains
    // a marker, while the Han-dominant real Chinese OBS message
    // (把手機的畫面傳到電腦用OBS開台就可以不用斷: 19 Han vs 3 Latin, with 把
    // and 就) skips. The weak aggregate in the mixed branch is gated by the
    // same Mandarin contextual evidence, so a long Japanese signage sentence
    // with an acronym (個人情報利用不可無断転載禁止w: 14 Han vs 1 Latin, no 把/
    // 就, no pronoun) never skips.
    if (evidence.hasForeignLetter) {
      const hanDominates =
        evidence.hanCount >= HAN_FOREIGN_DOMINANCE_RATIO * evidence.foreignLetterCount &&
        evidence.hanCount >= MIN_HAN_COUNT_FOR_MIXED
      if (!hanDominates) return false
      return (
        evidence.hasChineseMarker ||
        evidence.strongStructureScore >= STRONG_STRUCTURE_CONFIDENCE_THRESHOLD ||
        (hasMandarinContext &&
          evidence.chineseStructureScore >= CHINESE_STRUCTURE_CONFIDENCE_THRESHOLD)
      )
    }

    // Han-only text is confidently Chinese when:
    // - it contains a conservative Chinese-language marker (preserved from
    //   the original #55 gate, e.g. 對啊/上啊/品質很好/我們), or
    // - it contains a strong Mandarin structural character (weight 3,
    //   e.g. 那是肯定沒有 → 沒, 那要打訊號什麼的 → 麼), or
    // - the whole message is a known Chinese phrase (e.g. 不客氣, 我才), or
    // - a Mandarin pronoun used as a pronoun pushes an otherwise-weak sentence
    //   past the aggregate threshold (e.g. 我要用你的 = 5, 他很好 = 4).
    // The Han-only path does NOT trust the 的-particle or a bare aggregate of
    // weak characters: kana-less Japanese compounds of the 個人的+X{不可/可能/
    // 不可能} family (個人的利用不可, 個人的使用不可能) have 的 + several weak
    // chars but no Mandarin pronoun and must stay translatable.
    // S/T glyph evidence alone (手紙, 電話) or a couple of shared characters
    // (目的, 終了, 大人山水) clears none of these and stays translatable.
    return (
      evidence.hasChineseMarker ||
      evidence.strongStructureScore >= STRONG_STRUCTURE_CONFIDENCE_THRESHOLD ||
      isChinesePhrase ||
      (evidence.hasMandarinPronoun &&
        evidence.chineseStructureScore >= CHINESE_STRUCTURE_CONFIDENCE_THRESHOLD)
    )
  }

  // mode === 'translate_other_script'
  // Any foreign (non-Han/Kana/Hangul) letter mixed with Han → mixed-language,
  // keep translatable
  if (evidence.hasForeignLetter) return false

  // Without a Chinese-language marker the message is not confidently Chinese.
  // S/T glyph evidence alone (e.g. 手紙, 電話, 自動車) could be Japanese.
  if (!evidence.hasChineseMarker) return false

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
