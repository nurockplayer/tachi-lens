import { describe, expect, it } from 'vitest'
import { BUNDLED_MODEL_POLICY } from '@/providers/model-policy'
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
    expect(chat).toMatchObject({ selectedModel: 'gemini-3.8-flash', modelConfiguration: 'gemini-low-thinking', deepseekFallbackModel: 'deepseek-flash' })
    const speech = await runtime.speechSettings({ ...DEFAULT_SETTINGS, speechConfig: { ...DEFAULT_SETTINGS.speechConfig, speechModel: 'gemini-2.5-pro' } })
    expect(speech.speechConfig.speechModel).toBe('gemini-2.5-pro')
    expect(speech.speechModelConfiguration).toBe('default')
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
})
