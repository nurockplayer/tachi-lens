// Canonical identity for a single translation request.
//
// This is the single source of truth for deciding whether two translation
// requests are equivalent. The in-memory cache, in-flight coalescing (#58),
// batch-local deduplication (#56), and persistent caching (#44) all key off
// the same identity so a cached result stays reusable across those layers.
//
// The identity is built from a fixed, deterministic, length-prefixed
// encoding of every output-affecting dimension. Each field is encoded as
// `${length}#${value}`, so a field containing the separator characters
// (`|` or `#`) can never be confused with the start of the next field.
// We deliberately avoid serializing objects (JSON.stringify) because
// object property iteration order is not guaranteed and mutable inputs
// must not leak into the key.

/**
 * Version of the translation/prompt contract. Bump when the prompt shape or
 * translation semantics change in a way that would make previously cached
 * results meaningfully stale. Included in every translation identity.
 */
export const TRANSLATION_CONTRACT_VERSION = 2 as const

export interface TranslationIdentityInput {
  /** Source text exactly as the translator passes it to the provider (not trimmed). */
  text: string
  targetLang: string
  provider: string
  model: string
  /** Source-language hint when present; omitted identities are stable. */
  sourceLang?: string
  /** Prompt/contract version; defaults to the current canonical constant. */
  contractVersion?: number
}

// Separator between fields of the length-prefixed encoding. It cannot be
// confused with field content because every field starts with its exact
// length followed by '#'; a '|' (or '#' inside a value) is always consumed
// as part of the preceding length-delimited value.
const FIELD_SEPARATOR = '|'
const LENGTH_MARKER = '#'

// Encodes one dimension as `${length}#${value}` so that a value containing
// the separator (or the '#' marker) cannot blur the field boundary.
const encodeField = (value: string): string =>
  `${value.length}${LENGTH_MARKER}${value}`

/**
 * Build a deterministic string identity for a translation request.
 *
 * The source text is used verbatim: the identity must match the text the
 * translator sends to the provider, and the provider is never handed a
 * trimmed copy. Trimming here and not there would let two inputs that
 * produce different translations share an identity.
 *
 * Equivalence: identical typed inputs always produce the identical
 * identity; a difference in any dimension produces a different identity.
 * An absent sourceLang and an empty sourceLang are treated equivalently,
 * matching the behavior of the cache this identity replaces.
 */
export const buildTranslationIdentity = (
  input: TranslationIdentityInput,
): string => {
  const contractVersion = input.contractVersion ?? TRANSLATION_CONTRACT_VERSION

  return [
    encodeField(input.text),
    encodeField(input.targetLang),
    encodeField(input.provider),
    encodeField(input.model),
    encodeField(input.sourceLang ?? ''),
    encodeField(String(contractVersion)),
  ].join(FIELD_SEPARATOR)
}
