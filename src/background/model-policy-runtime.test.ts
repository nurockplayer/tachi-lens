import { describe, expect, it } from 'vitest'
import { BUNDLED_MODEL_POLICY } from '@/providers/model-policy'
import { isModelPolicySnapshotMessage } from '@/shared/model-policy-messages'
import { DEFAULT_SETTINGS } from '@/storage/settings'
import { ModelPolicyRuntime } from './model-policy-runtime'

describe('model policy runtime integration', () => {
  it('resolves Auto before cache/quota identity and keeps concrete pins across promotion and rollback', async () => {
    const manifest = structuredClone(BUNDLED_MODEL_POLICY)
    const policy = manifest.policies.find(entry => entry.provider === 'deepseek')!
    policy.models.push({ id: 'deepseek-future-flash', configuration: 'deepseek-disabled-thinking' })
    policy.recommended = 'deepseek-future-flash'
    policy.fallbacks = ['deepseek-flash']
    manifest.revision++
    const runtime = new ModelPolicyRuntime(async () => ({ manifest, source: 'remote' }))
    const automatic = await runtime.chatSettings(DEFAULT_SETTINGS)
    expect(automatic.selectedModel).toBe('deepseek-future-flash')
    expect(DEFAULT_SETTINGS.selectedModel).toBe('auto')
    const pinned = { ...DEFAULT_SETTINGS, selectedModel: 'deepseek-flash' }
    expect((await runtime.chatSettings(pinned)).selectedModel).toBe('deepseek-flash')
    policy.recommended = 'deepseek-flash'
    policy.fallbacks = ['deepseek-future-flash']
    manifest.revision++
    expect((await runtime.chatSettings(DEFAULT_SETTINGS)).selectedModel).toBe('deepseek-flash')
  })

  it('resolves Gemini primary and DeepSeek fallback from one snapshot and keeps speech independent', async () => {
    const runtime = new ModelPolicyRuntime(async () => ({ manifest: BUNDLED_MODEL_POLICY, source: 'cached' }))
    const chat = await runtime.chatSettings({ ...DEFAULT_SETTINGS, selectedProvider: 'gemini' })
    const geminiChat = BUNDLED_MODEL_POLICY.policies.find(entry => entry.provider === 'gemini' && entry.workload === 'chat')!
    const deepseekChat = BUNDLED_MODEL_POLICY.policies.find(entry => entry.provider === 'deepseek' && entry.workload === 'chat')!
    const geminiSpeech = BUNDLED_MODEL_POLICY.policies.find(entry => entry.provider === 'gemini' && entry.workload === 'speech')!
    const recommendedConfiguration = geminiChat.models.find(model => model.id === geminiChat.recommended)!.configuration
    expect(chat).toMatchObject({ selectedModel: geminiChat.recommended, modelConfiguration: recommendedConfiguration, deepseekFallbackModel: deepseekChat.recommended })
    const speechPin = geminiSpeech.models.find(model => model.id !== geminiSpeech.recommended) ?? geminiSpeech.models[0]!
    const speech = await runtime.speechSettings({ ...DEFAULT_SETTINGS, speechConfig: { ...DEFAULT_SETTINGS.speechConfig, speechModel: speechPin.id } })
    expect(speech.speechConfig.speechModel).toBe(speechPin.id)
    expect(speech.speechModelConfiguration).toBe(speechPin.configuration)
    expect((await runtime.snapshot()).resolutions).toHaveLength(3)
  })

  it('bounds resolution diagnostics and excludes arbitrary unsafe pin strings', async () => {
    const runtime = new ModelPolicyRuntime(async () => ({ manifest: BUNDLED_MODEL_POLICY, source: 'bundled' }))
    for (let i = 0; i < 25; i++) await runtime.chatSettings(DEFAULT_SETTINGS)
    await runtime.chatSettings({ ...DEFAULT_SETTINGS, selectedModel: 'username/secret?chat=content' })
    const payload = await runtime.snapshot()
    expect(payload.resolutions).toHaveLength(20)
    expect(JSON.stringify(payload)).not.toContain('username')
  })

  it('records trusted removed pins but excludes arbitrary pins and accepts the full Gemini ID bound', async () => {
    const retiredId = 'gemini-retired-test'
    const longModelId = `gemini-${'a'.repeat(73)}`
    expect(longModelId).toHaveLength(80)
    const makeSnapshotManifest = (includeRetired: boolean) => ({
      schemaVersion: 1 as const,
      revision: includeRetired ? 50 : 51,
      issuedAt: '2026-09-27T00:00:00.000Z',
      expiresAt: '2026-10-01T00:00:00.000Z',
      minimumClientVersion: '0.3.0',
      policies: [
        { provider: 'gemini' as const, workload: 'chat' as const, recommended: 'gemini-test-chat', fallbacks: ['gemini-test-legacy'], models: [
          { id: 'gemini-test-chat', configuration: 'default' as const },
          { id: 'gemini-test-legacy', configuration: 'default' as const },
          ...(includeRetired ? [{ id: retiredId, configuration: 'default' as const }] : []),
          { id: longModelId, configuration: 'default' as const },
        ] },
        { provider: 'gemini' as const, workload: 'speech' as const, recommended: 'gemini-test-speech', fallbacks: ['gemini-test-legacy'], models: [{ id: 'gemini-test-speech', configuration: 'default' as const }, { id: 'gemini-test-legacy', configuration: 'default' as const }] },
        { provider: 'deepseek' as const, workload: 'chat' as const, recommended: 'deepseek-test-chat', fallbacks: ['deepseek-test-legacy'], models: [{ id: 'deepseek-test-chat', configuration: 'deepseek-disabled-thinking' as const }, { id: 'deepseek-test-legacy', configuration: 'deepseek-disabled-thinking' as const }] },
      ],
    })
    let manifest = makeSnapshotManifest(true)
    const runtime = new ModelPolicyRuntime(async () => ({ manifest, source: 'remote' }))

    await runtime.chatSettings({ ...DEFAULT_SETTINGS, selectedProvider: 'gemini', selectedModel: retiredId })
    manifest = makeSnapshotManifest(false)
    await runtime.chatSettings({ ...DEFAULT_SETTINGS, selectedProvider: 'gemini', selectedModel: retiredId })
    await runtime.chatSettings({ ...DEFAULT_SETTINGS, selectedProvider: 'gemini', selectedModel: 'gemini-user-entered' })
    await runtime.chatSettings({ ...DEFAULT_SETTINGS, selectedProvider: 'gemini', selectedModel: longModelId })
    const payload = await runtime.snapshot()
    expect(payload.resolutions.map(item => item.model)).toContain(retiredId)
    expect(payload.resolutions.map(item => item.model)).toContain(longModelId)
    expect(payload.resolutions.map(item => item.model)).not.toContain('gemini-user-entered')
    expect(isModelPolicySnapshotMessage({ type: 'model_policy_snapshot', payload })).toBe(true)
  })
})
