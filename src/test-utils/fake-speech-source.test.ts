// Determinism reference tests for the shared fake speech source (Spec §11).
//
// Proves the helper is deterministic: the same scripted chunks always produce
// the same fingerprints, transcripts, and mock-provider results. No timers, no
// live provider, no tabCapture/MediaRecorder/getUserMedia dependency.

import { describe, expect, it } from 'vitest'
import type { AudioChunk, SpeechTranslationResult } from '@/providers/speech-types'
import {
  FakeSpeechSource,
  chunkFingerprint,
  fluentChunk,
  loudPcm,
  mkChunk,
  resolveMockTranscription,
  silentPcm,
} from './fake-speech-source'
import { createMockSpeechProvider } from './mock-speech-provider'

describe('fake-speech-source determinism', () => {
  it('chunkFingerprint is stable across identical chunks', () => {
    const a = mkChunk()
    const b = mkChunk()
    expect(chunkFingerprint(a)).toBe(chunkFingerprint(b))
    // A final chunk changes phase → different fingerprint.
    expect(chunkFingerprint(mkChunk({ isFinal: true }))).not.toBe(chunkFingerprint(a))
  })

  it('same scripted chunks always resolve to the same transcripts', () => {
    const chunk = fluentChunk(1000, 2000, { isFinal: true })
    const first = resolveMockTranscription(chunk)
    const second = resolveMockTranscription(fluentChunk(1000, 2000, { isFinal: true }))
    expect(second).toEqual(first)
    expect(first[0]).toMatchObject({ isFinal: true, translatedText: expect.any(String) })
  })

  it('resolveMockTranscription with a transcripts map is stable and rejects misses', () => {
    const transcripts = {
      [chunkFingerprint(mkChunk({ isFinal: true }))]: { text: '你好', translatedText: 'Hello' },
    }
    expect(resolveMockTranscription(mkChunk({ isFinal: true }), transcripts)[0]!.translatedText).toBe('Hello')
    expect(() => resolveMockTranscription(mkChunk(), transcripts)).toThrow(
      'FakeSpeechSource: unexpected chunk fingerprint',
    )
  })

  it('createMockSpeechProvider returns the same canned results for identical chunks', async () => {
    const results: SpeechTranslationResult[] = [{ id: 'c', text: 'hi', translatedText: '你好', isFinal: true }]
    const { provider, handle } = createMockSpeechProvider()
    handle.setCannedResults({ [chunkFingerprint(mkChunk({ isFinal: true }))]: results })
    const a = await provider.transcribeChunk(mkChunk({ isFinal: true }), 'k', 'm', 'zh-TW')
    const b = await provider.transcribeChunk(mkChunk({ isFinal: true }), 'k', 'm', 'zh-TW')
    expect(b).toEqual(a)
    expect(b).toEqual(results)
  })

  it('FakeSpeechSource emits chunks/errors/disconnects synchronously and flushes finals', () => {
    const source = new FakeSpeechSource()
    const chunks: AudioChunk[] = []
    const finals: AudioChunk[] = []
    const errors: string[] = []
    const disconnects: string[] = []
    source.onChunk((c) => {
      chunks.push(c)
      if (c.isFinal === true) finals.push(c)
    })
    source.onError((e) => errors.push(e.reason))
    source.onDisconnect((r) => disconnects.push(r))

    source.emitScripted([fluentChunk(0, 1000), fluentChunk(1000, 2000)])
    source.emitFinalChunk()
    source.emitError({ reason: 'permission_denied', message: 'getUserMedia failed' })
    source.emitDisconnect('port_disconnected')

    expect(chunks).toHaveLength(3)
    expect(finals).toHaveLength(1)
    expect(errors).toEqual(['permission_denied'])
    expect(disconnects).toEqual(['port_disconnected'])
    // The VAD gate needs loud audio; the default fake emits loud PCM.
    expect(chunks[0]).toMatchObject({ isFinal: false })
  })

  it('silentPcm and loudPcm are deterministic audio helpers', () => {
    const silent = silentPcm()
    const loud = loudPcm()
    expect(new Int16Array(silent).every((s) => s === 0)).toBe(true)
    expect(new Int16Array(loud).every((s) => s !== 0)).toBe(true)
  })
})
