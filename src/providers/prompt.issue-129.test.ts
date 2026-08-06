import { describe, expect, it } from 'vitest'
import { parseTranslationResponse } from './prompt'

/**
 * Issue #129 — empty / whitespace / missing translations must surface as
 * invalid responses so the Content Script can keep the message retryable.
 *
 * The current parser passes an empty string through as `translatedText: ''`
 * (the `typeof === 'string'` check accepts it) and omits any errorType for
 * missing translations. These assertions pin the NEW contract that the
 * #129 fix implements.
 */
describe('parseTranslationResponse — issue #129 invalid translation contract', () => {
  it('treats an empty translated_text as an invalid response', () => {
    const result = parseTranslationResponse(
      '[{"id":"m1","translated_text":""}]',
      [{ id: 'm1' }],
    )
    expect(result[0]!.translatedText).toBeUndefined()
    expect(result[0]!.errorType).toBe('invalid_response')
  })

  it('treats a whitespace-only translated_text as an invalid response', () => {
    const result = parseTranslationResponse(
      '[{"id":"m1","translated_text":"   "}]',
      [{ id: 'm1' }],
    )
    expect(result[0]!.translatedText).toBeUndefined()
    expect(result[0]!.errorType).toBe('invalid_response')
  })

  it('treats a missing translated_text field as an invalid response', () => {
    const result = parseTranslationResponse(
      '[{"id":"m1"}]',
      [{ id: 'm1' }],
    )
    expect(result[0]!.translatedText).toBeUndefined()
    expect(result[0]!.errorType).toBe('invalid_response')
  })

  it('treats a non-string translated_text as an invalid response', () => {
    const result = parseTranslationResponse(
      '[{"id":"m1","translated_text":123}]',
      [{ id: 'm1' }],
    )
    expect(result[0]!.translatedText).toBeUndefined()
    expect(result[0]!.errorType).toBe('invalid_response')
  })

  it('treats a missing requested id as an invalid response', () => {
    const result = parseTranslationResponse(
      '[{"id":"m1","translated_text":"ok"}]',
      [{ id: 'm1' }, { id: 'm2' }],
    )
    expect(result[1]!.translatedText).toBeUndefined()
    expect(result[1]!.error).toBe('Missing translation for this message')
    expect(result[1]!.errorType).toBe('invalid_response')
  })

  it('treats a JSON parse failure as an invalid response for every requested id', () => {
    const result = parseTranslationResponse(
      'not json',
      [{ id: 'm1' }, { id: 'm2' }],
    )
    expect(result).toHaveLength(2)
    for (const item of result) {
      expect(item.translatedText).toBeUndefined()
      expect(item.error).toBe('Failed to parse translation response')
      expect(item.errorType).toBe('invalid_response')
    }
  })

  it('treats a non-array parsed result as an invalid response for every requested id', () => {
    const result = parseTranslationResponse(
      '{"id":"m1"}',
      [{ id: 'm1' }],
    )
    expect(result[0]!.translatedText).toBeUndefined()
    expect(result[0]!.error).toBe('Unexpected response format')
    expect(result[0]!.errorType).toBe('invalid_response')
  })

  it('preserves valid non-empty translations unchanged', () => {
    const result = parseTranslationResponse(
      '[{"id":"m1","translated_text":"こんにちは"}]',
      [{ id: 'm1' }],
    )
    expect(result[0]!.translatedText).toBe('こんにちは')
    expect(result[0]!.error).toBeUndefined()
    expect(result[0]!.errorType).toBeUndefined()
  })
})
