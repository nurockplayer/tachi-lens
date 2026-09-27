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
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
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

  it('records a current recommendation even when bounded history evicts its older identity', async () => {
    const makeManifest = (replacementCount: number) => {
      const makeModels = (prefix: string, count: number, replacements: number, configuration: 'default' | 'deepseek-disabled-thinking') => {
        const recommendation = `${prefix}-recommended`
        return [
          { id: recommendation, configuration },
          ...Array.from({ length: count - 1 - replacements }, (_, i) => ({ id: `${prefix}-old-${i}`, configuration })),
          ...Array.from({ length: replacements }, (_, i) => ({ id: `${prefix}-new-${i}`, configuration })),
        ]
      }
      const geminiChat = makeModels('gemini-chat', 16, replacementCount === 0 ? 0 : 6, 'default')
      const geminiSpeech = makeModels('gemini-speech', 16, replacementCount === 0 ? 0 : 6, 'default')
      const deepseekChat = makeModels('deepseek-chat', 16, replacementCount === 0 ? 0 : 5, 'deepseek-disabled-thinking')
      const policies = [
        { provider: 'gemini' as const, workload: 'chat' as const, models: geminiChat },
        { provider: 'gemini' as const, workload: 'speech' as const, models: geminiSpeech },
        { provider: 'deepseek' as const, workload: 'chat' as const, models: deepseekChat },
      ].map(({ provider, workload, models }) => ({
        provider,
        workload,
        recommended: models[0]!.id,
        fallbacks: [models[1]!.id],
        models,
      }))
      return {
        schemaVersion: 1 as const,
        revision: replacementCount === 0 ? 70 : 71,
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        minimumClientVersion: '0.3.0',
        policies,
      }
    }
    let manifest = makeManifest(0)
    const runtime = new ModelPolicyRuntime(async () => ({ manifest, source: 'remote' }))
    await runtime.chatSettings({ ...DEFAULT_SETTINGS, selectedProvider: 'gemini' })

    // Replacing 17 non-recommended entries grows the union from 48 to 65 IDs,
    // evicting old entries from the 64-ID trust history, including chat's recommendation.
    manifest = makeManifest(17)
    await runtime.chatSettings({ ...DEFAULT_SETTINGS, selectedProvider: 'gemini' })
    const payload = await runtime.snapshot()
    expect(payload.resolutions.filter(item => item.model === 'gemini-chat-recommended')).toHaveLength(2)

    await runtime.chatSettings({ ...DEFAULT_SETTINGS, selectedProvider: 'gemini', selectedModel: 'gemini-user-entered' })
    expect((await runtime.snapshot()).resolutions.map(item => item.model)).not.toContain('gemini-user-entered')
  })
})
