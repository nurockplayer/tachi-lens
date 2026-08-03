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
    // Length-prefixed: `${len}#${value}` per dimension, joined with '|'.
    expect(key).toBe('5#Hello|5#zh-TW|8#deepseek|17#deepseek-v4-flash|0#|1#1')
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
    it('preserves leading and trailing whitespace as distinct identities', () => {
      expect(buildTranslationIdentity({ ...BASE, text: ' Hello ' }))
        .not.toBe(buildTranslationIdentity({ ...BASE, text: 'Hello' }))
      expect(buildTranslationIdentity({ ...BASE, text: '  Hello  ' }))
        .not.toBe(buildTranslationIdentity({ ...BASE, text: 'Hello' }))
    })

    it('does not collapse internal whitespace or change case', () => {
      expect(buildTranslationIdentity({ ...BASE, text: 'Hello  World' }))
        .not.toBe(buildTranslationIdentity({ ...BASE, text: 'Hello World' }))
      expect(buildTranslationIdentity({ ...BASE, text: 'hello' }))
        .not.toBe(buildTranslationIdentity(BASE))
    })
  })

  describe('length-prefixed collision safety', () => {
    it('uses the verbatim text in the identity so it matches the provider input', () => {
      expect(buildTranslationIdentity({ ...BASE, text: 'Hello' }))
        .toBe('5#Hello|5#zh-TW|8#deepseek|17#deepseek-v4-flash|0#|1#1')
      expect(buildTranslationIdentity({ ...BASE, text: ' Hello ' }))
        .toBe('7# Hello |5#zh-TW|8#deepseek|17#deepseek-v4-flash|0#|1#1')
    })

    it('keeps leading/trailing whitespace in the provider text and the identity identical', () => {
      const padded = '  Hello  '
      // The identity encodes the exact string that the translator sends to
      // the provider: no trimming anywhere.
      expect(buildTranslationIdentity({ ...BASE, text: padded }))
        .toBe(buildTranslationIdentity({ ...BASE, text: padded }))
      expect(buildTranslationIdentity({ ...BASE, text: padded }))
        .not.toBe(buildTranslationIdentity({ ...BASE, text: padded.trim() }))
    })

    it('cannot collide when a value contains the field separator or length marker', () => {
      // '|' and '#' are the encoding separators; the length prefix must keep
      // them from blurring field boundaries.
      expect(buildTranslationIdentity({ ...BASE, text: 'a|b' }))
        .not.toBe(buildTranslationIdentity({ ...BASE, text: 'a', sourceLang: 'b' }))
      expect(buildTranslationIdentity({ ...BASE, text: 'a#b' }))
        .not.toBe(buildTranslationIdentity({ ...BASE, text: 'a', sourceLang: 'b' }))
    })

    it('cannot collide across the model and sourceLang dimensions', () => {
      // With a raw separator join, a value ending in '|' followed by the next
      // dimension is indistinguishable from an embedded '|' in that value:
      // model:'x|yz' (sourceLang absent) and model:'x', sourceLang:'yz' both
      // produce the run 'x|yz'. The length prefix keeps them distinct.
      const a = buildTranslationIdentity({ ...BASE, model: 'x|yz' })
      const b = buildTranslationIdentity({ ...BASE, model: 'x', sourceLang: 'yz' })
      expect(a).not.toBe(b)
      expect(a).toBe('5#Hello|5#zh-TW|8#deepseek|4#x|yz|0#|1#1')
      expect(b).toBe('5#Hello|5#zh-TW|8#deepseek|1#x|2#yz|1#1')
    })

    it('cannot collide when the model contains the NUL character', () => {
      const withNul = buildTranslationIdentity({ ...BASE, model: 'a\u0000b' })
      const without = buildTranslationIdentity({ ...BASE, model: 'a', sourceLang: 'b' })
      expect(withNul).not.toBe(without)
    })
  })
})
