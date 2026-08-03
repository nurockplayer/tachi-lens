import { describe, expect, it } from 'vitest'
import {
  buildTranslationIdentity,
  TRANSLATION_CONTRACT_VERSION,
} from './translation-identity'

const BASE = {
  text: 'Hello',
  targetLang: 'zh-TW',
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
}

describe('buildTranslationIdentity', () => {
  it('produces the same deterministic identity for equivalent typed inputs', () => {
    expect(buildTranslationIdentity(BASE))
      .toBe(buildTranslationIdentity({ ...BASE }))
    expect(buildTranslationIdentity(BASE))
      .toBe(buildTranslationIdentity({
        text: BASE.text,
        targetLang: BASE.targetLang,
        provider: BASE.provider,
        model: BASE.model,
        sourceLang: undefined,
        contractVersion: TRANSLATION_CONTRACT_VERSION,
      }))
  })

  it('does not depend on object property iteration order', () => {
    const a = buildTranslationIdentity({ ...BASE, sourceLang: 'en' })
    const b = buildTranslationIdentity({
      sourceLang: 'en',
      model: BASE.model,
      provider: BASE.provider,
      targetLang: BASE.targetLang,
      text: BASE.text,
    })
    expect(a).toBe(b)
  })

  it('is a stable string with a stable shape', () => {
    const key = buildTranslationIdentity(BASE)
    expect(key).toBe('Hello\u0000zh-TW\u0000deepseek\u0000deepseek-v4-flash\u0000\u00001')
  })

  describe('isolation dimensions', () => {
    it('distinguishes different source text', () => {
      expect(buildTranslationIdentity({ ...BASE, text: 'Hello' }))
        .not.toBe(buildTranslationIdentity({ ...BASE, text: 'World' }))
    })

    it('distinguishes different target languages', () => {
      expect(buildTranslationIdentity({ ...BASE, targetLang: 'zh-TW' }))
        .not.toBe(buildTranslationIdentity({ ...BASE, targetLang: 'ja' }))
    })

    it('distinguishes different providers', () => {
      expect(buildTranslationIdentity({ ...BASE, provider: 'deepseek' }))
        .not.toBe(buildTranslationIdentity({ ...BASE, provider: 'gemini' }))
    })

    it('distinguishes different models', () => {
      expect(buildTranslationIdentity({ ...BASE, model: 'deepseek-v4-flash' }))
        .not.toBe(buildTranslationIdentity({ ...BASE, model: 'deepseek-v3' }))
    })

    it('distinguishes different source-language hints when present', () => {
      expect(buildTranslationIdentity({ ...BASE, sourceLang: 'en' }))
        .not.toBe(buildTranslationIdentity({ ...BASE, sourceLang: 'ja' }))
    })

    it('distinguishes present and absent source-language hints', () => {
      expect(buildTranslationIdentity(BASE))
        .not.toBe(buildTranslationIdentity({ ...BASE, sourceLang: 'en' }))
    })

    it('distinguishes different translation-contract versions', () => {
      expect(buildTranslationIdentity(BASE))
        .not.toBe(buildTranslationIdentity({ ...BASE, contractVersion: 2 }))
    })
  })

  describe('source text normalization', () => {
    it('trims leading and trailing whitespace', () => {
      expect(buildTranslationIdentity({ ...BASE, text: '  Hello  ' }))
        .toBe(buildTranslationIdentity(BASE))
    })

    it('does not collapse internal whitespace or change case', () => {
      expect(buildTranslationIdentity({ ...BASE, text: 'Hello  World' }))
        .not.toBe(buildTranslationIdentity({ ...BASE, text: 'Hello World' }))
      expect(buildTranslationIdentity({ ...BASE, text: 'hello' }))
        .not.toBe(buildTranslationIdentity(BASE))
    })
  })
})
