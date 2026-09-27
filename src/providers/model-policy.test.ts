import { describe, expect, it } from 'vitest'
import {
  AUTO_MODEL,
  BUNDLED_MODEL_POLICY,
  resolvePolicyModel,
  validateModelPolicy,
  type ModelPolicyManifest,
} from './model-policy'

const NOW = Date.parse('2026-09-27T00:00:00.000Z')

const manifest = (): ModelPolicyManifest => ({
  schemaVersion: 1,
  revision: 2,
  issuedAt: '2026-09-27T00:00:00.000Z',
  expiresAt: '2026-10-01T00:00:00.000Z',
  minimumClientVersion: '0.3.0',
  policies: [
    { provider: 'gemini', workload: 'chat', recommended: 'gemini-3.8-flash', fallbacks: ['gemini-2.5-flash'], models: [{ id: 'gemini-3.8-flash', configuration: 'gemini-low-thinking' }, { id: 'gemini-2.5-flash', configuration: 'default' }] },
    { provider: 'gemini', workload: 'speech', recommended: 'gemini-3.8-flash', fallbacks: ['gemini-2.5-flash'], models: [{ id: 'gemini-3.8-flash', configuration: 'gemini-low-thinking' }, { id: 'gemini-2.5-flash', configuration: 'default' }] },
    { provider: 'deepseek', workload: 'chat', recommended: 'deepseek-v4-flash', fallbacks: ['deepseek-flash'], models: [{ id: 'deepseek-v4-flash', configuration: 'deepseek-disabled-thinking' }, { id: 'deepseek-flash', configuration: 'deepseek-disabled-thinking' }] },
  ],
})

describe('model policy validation', () => {
  it('accepts a structurally valid current manifest', () => {
    expect(validateModelPolicy(manifest(), NOW, '0.3.2')).toEqual(manifest())
  })

  it('rejects unknown fields, mismatched ids/configurations, and partial policy sets', () => {
    const unknown = { ...manifest(), extra: true }
    const badConfig = manifest()
    badConfig.policies[0]!.models[0]!.configuration = 'deepseek-disabled-thinking' as never
    expect(validateModelPolicy(unknown, NOW, '0.3.2')).toBeUndefined()
    expect(validateModelPolicy(badConfig, NOW, '0.3.2')).toBeUndefined()
    expect(validateModelPolicy({ ...manifest(), policies: manifest().policies.slice(0, 2) }, NOW, '0.3.2')).toBeUndefined()
  })

  it('rejects expired or too-far-future remote data while allowing expired bundled data', () => {
    const expired = { ...manifest(), issuedAt: '2026-09-25T00:00:00.000Z', expiresAt: '2026-09-26T23:59:59.999Z' }
    const future = { ...manifest(), issuedAt: '2026-09-27T00:06:00.000Z' }
    expect(validateModelPolicy(expired, NOW, '0.3.2')).toBeUndefined()
    expect(validateModelPolicy(expired, NOW, '0.3.2', true)).toBeDefined()
    expect(validateModelPolicy(future, NOW, '0.3.2')).toBeUndefined()
  })

  it('accepts either supported Gemini request configuration on a model identifier', () => {
    const candidate = manifest()
    candidate.policies[0]!.models.push({ id: 'gemini-4.0-flash', configuration: 'gemini-low-thinking' })
    expect(validateModelPolicy(candidate, NOW, '0.3.2')).toBeDefined()
  })

  it('resolves Auto from policy and preserves concrete pins', () => {
    const snapshot = { manifest: BUNDLED_MODEL_POLICY, source: 'bundled' as const }
    const geminiChat = BUNDLED_MODEL_POLICY.policies.find((entry) => entry.provider === 'gemini' && entry.workload === 'chat')!
    expect(resolvePolicyModel(snapshot, 'gemini', 'chat', AUTO_MODEL)).toMatchObject({
      model: geminiChat.recommended,
      selection: 'auto',
      configuration: geminiChat.models.find((model) => model.id === geminiChat.recommended)!.configuration,
      revision: BUNDLED_MODEL_POLICY.revision,
    })
    expect(resolvePolicyModel(snapshot, 'deepseek', 'chat', 'deepseek-v4-pro')).toMatchObject({
      model: 'deepseek-v4-pro', selection: 'pinned', configuration: 'deepseek-disabled-thinking',
    })
  })
})
