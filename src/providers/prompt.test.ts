import { describe, expect, it } from 'vitest'
import { buildTranslationPrompt, parseTranslationResponse } from './prompt'

describe('translation prompt', () => {
  it('builds a shared JSON-only prompt with ids, text, source language, and target language', () => {
    const prompt = buildTranslationPrompt(
      [
        { id: 'm1', text: 'Hello chat', sourceLang: 'en' },
        { id: 'm2', text: 'こんにちは' },
      ],
      'zh-TW',
    )

    expect(prompt.system).toContain('Return valid JSON only')
    expect(prompt.user).toContain('"target_lang":"zh-TW"')
    expect(prompt.user).toContain('"id":"m1"')
    expect(prompt.user).toContain('"source_lang":"en"')
    expect(prompt.user).toContain('"text":"こんにちは"')
    expect(prompt.user).toContain('"translated_text"')
  })

  it('escapes message text through JSON serialization', () => {
    const prompt = buildTranslationPrompt([{ id: 'quoted', text: 'say "hello"' }], 'ja')

    expect(prompt.user).toContain('"text":"say \\"hello\\""')
  })
})

describe('parseTranslationResponse', () => {
  const REQS = [{ id: 'm1' }, { id: 'm2' }]

  it('parses a valid JSON array response', () => {
    const result = parseTranslationResponse(
      '[{"id":"m1","translated_text":"你好"},{"id":"m2","translated_text":"世界"}]',
      REQS,
    )

    expect(result).toEqual([
      { id: 'm1', translatedText: '你好' },
      { id: 'm2', translatedText: '世界' },
    ])
  })

  it('strips markdown code fences', () => {
    const result = parseTranslationResponse(
      '```json\n[{"id":"m1","translated_text":"你好"}]\n```',
      [{ id: 'm1' }],
    )

    expect(result[0]!.translatedText).toBe('你好')
  })

  it('strips markdown fences without language tag', () => {
    const result = parseTranslationResponse(
      '```\n[{"id":"m1","translated_text":"你好"}]\n```',
      [{ id: 'm1' }],
    )

    expect(result[0]!.translatedText).toBe('你好')
  })

  it('accepts camelCase translatedText key', () => {
    const result = parseTranslationResponse(
      '[{"id":"m1","translatedText":"Hello"}]',
      [{ id: 'm1' }],
    )

    expect(result[0]!.translatedText).toBe('Hello')
  })

  it('handles missing request IDs from model output', () => {
    const result = parseTranslationResponse(
      '[{"id":"m1","translated_text":"你好"}]',
      [{ id: 'm1' }, { id: 'm2' }],
    )

    expect(result).toHaveLength(2)
    expect(result[0]!.translatedText).toBe('你好')
    expect(result[1]!.error).toBe('Missing translation for this message')
  })

  it('returns errors for unparseable response', () => {
    const result = parseTranslationResponse('not json', REQS)

    expect(result).toHaveLength(2)
    expect(result[0]!.error).toBe('Failed to parse translation response')
  })

  it('returns errors when response is not an array', () => {
    const result = parseTranslationResponse('{"id":"m1"}', REQS)

    expect(result[0]!.error).toBe('Unexpected response format')
  })
})
