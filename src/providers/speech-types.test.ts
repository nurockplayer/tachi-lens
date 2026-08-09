import { describe, expect, it } from 'vitest'
import {
  SPEECH_GEMINI_DEFAULT_MODEL,
  SPEECH_GEMINI_MODELS,
  SPEECH_PROVIDER_IDS,
  isSpeechProviderId,
  type AudioChunk,
  type SpeechProvider,
  type SpeechTranslationConfig,
  type SpeechTranslationResult,
} from './speech-types'

describe('speech provider types', () => {
  it('has exactly one speech provider (Gemini) in v0.3', () => {
    expect(SPEECH_PROVIDER_IDS).toEqual(['gemini'])
  })

  it('isSpeechProviderId accepts gemini and rejects others', () => {
    expect(isSpeechProviderId('gemini')).toBe(true)
    expect(isSpeechProviderId('deepseek')).toBe(false)
    expect(isSpeechProviderId('')).toBe(false)
  })

  it('defines a Gemini speech model list with a default', () => {
    expect(SPEECH_GEMINI_MODELS.length).toBeGreaterThan(0)
    expect(SPEECH_GEMINI_MODELS.map(({ id }) => id)).toContain(SPEECH_GEMINI_DEFAULT_MODEL)
    expect(typeof SPEECH_GEMINI_DEFAULT_MODEL).toBe('string')
  })

  it('speech config defaults to disabled, Gemini, and the chat default language', () => {
    const config: SpeechTranslationConfig = {
      speechEnabled: false,
      speechProvider: 'gemini',
      speechModel: SPEECH_GEMINI_DEFAULT_MODEL,
      speechTargetLanguage: 'zh-TW',
      captionMaxLines: 2,
      captionOpacity: 100,
      maxSessionMinutes: 30,
    }

    expect(config.speechEnabled).toBe(false)
    expect(config.speechProvider).toBe('gemini')
    expect(config.speechTargetLanguage).toBe('zh-TW')
    expect(config.captionMaxLines).toBe(2)
    expect(config.captionOpacity).toBe(100)
    expect(config.maxSessionMinutes).toBe(30)
  })

  it('audio chunk accepts the Spec PCM shape', () => {
    const chunk: AudioChunk = {
      chunkId: 'c1',
      data: new ArrayBuffer(16_000),
      mimeType: 'audio/pcm;rate=16000',
      startMs: 0,
      endMs: 500,
    }

    expect(chunk.mimeType).toBe('audio/pcm;rate=16000')
    expect(chunk.data.byteLength).toBe(16_000)
  })

  it('speech translation result carries optional error and final fields', () => {
    const result: SpeechTranslationResult = {
      id: 'c1',
      text: 'hello',
      translatedText: '你好',
      isFinal: true,
    }

    expect(result.translatedText).toBe('你好')
    expect(result.isFinal).toBe(true)
  })

  it('a SpeechProvider conforms to the contract shape', () => {
    const provider: SpeechProvider = {
      id: 'gemini',
      displayName: 'Gemini',
      models: SPEECH_GEMINI_MODELS,
      defaultModel: SPEECH_GEMINI_DEFAULT_MODEL,
      transcribeChunk: async () => [],
      validateKey: async () => ({ valid: true }),
    }

    expect(provider.id).toBe('gemini')
    expect(provider.defaultModel).toBe(SPEECH_GEMINI_DEFAULT_MODEL)
    expect(typeof provider.transcribeChunk).toBe('function')
    expect(typeof provider.validateKey).toBe('function')
  })
})
