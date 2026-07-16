/**
 * Pure text-validation logic for E2E DeepSeek mock.
 *
 * Extracted into src/test-utils so Vitest unit tests can exercise it
 * without requiring a Playwright browser context or E2E fixture imports.
 * The E2E fixture imports this function with a relative path.
 */

/**
 * Given the message text and optional translations map, returns the
 * translated text or throws a descriptive error.
 *
 * - Without translations map: accept only 'Hello world' → '你好，世界'.
 * - With translations map: accept only keys in the map, reject unmapped.
 */
export const resolveMockTranslation = (
  messageText: string,
  translations?: Record<string, string>,
): string => {
  if (translations) {
    const translated = translations[messageText]
    if (translated === undefined) {
      throw new Error(
        `DeepSeek mock: unexpected message text "${messageText}" with translations map. ` +
        `Expected one of: ${Object.keys(translations).map((k) => `"${k}"`).join(', ')}`,
      )
    }
    return translated
  }

  // Legacy contract: accept only "Hello world"
  if (messageText !== 'Hello world') {
    throw new Error(
      `DeepSeek mock: unexpected message text "${messageText}". ` +
      'Without a translations map, only "Hello world" is accepted.',
    )
  }

  return '你好，世界'
}
