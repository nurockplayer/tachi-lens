import { describe, expect, it } from 'vitest'
import { buildTranslationPrompt } from './prompt'

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
