import { describe, expect, it } from 'vitest'
import { classifyQualification, INITIAL_BASE_SHA } from '../../scripts/model-policy/qualification'

// Frozen initial fixture, independent of future production promotions.
const initial = {
  "schemaVersion": 1,
  "revision": 1,
  "issuedAt": "2026-09-27T00:00:00.000Z",
  "expiresAt": "2026-10-27T00:00:00.000Z",
  "minimumClientVersion": "0.3.3",
  "policies": [
    {
      "provider": "gemini",
      "workload": "chat",
      "recommended": "gemini-3.8-flash",
      "fallbacks": [
        "gemini-2.5-flash",
        "gemini-2.5-pro"
      ],
      "models": [
        {
          "id": "gemini-3.8-flash",
          "configuration": "gemini-low-thinking"
        },
        {
          "id": "gemini-2.5-flash",
          "configuration": "default"
        },
        {
          "id": "gemini-2.5-pro",
          "configuration": "default"
        }
      ]
    },
    {
      "provider": "gemini",
      "workload": "speech",
      "recommended": "gemini-3.8-flash",
      "fallbacks": [
        "gemini-2.5-flash",
        "gemini-2.5-pro"
      ],
      "models": [
        {
          "id": "gemini-3.8-flash",
          "configuration": "gemini-low-thinking"
        },
        {
          "id": "gemini-2.5-flash",
          "configuration": "default"
        },
        {
          "id": "gemini-2.5-pro",
          "configuration": "default"
        }
      ]
    },
    {
      "provider": "deepseek",
      "workload": "chat",
      "recommended": "deepseek-flash",
      "fallbacks": [
        "deepseek-v4-pro"
      ],
      "models": [
        {
          "id": "deepseek-flash",
          "configuration": "deepseek-disabled-thinking"
        },
        {
          "id": "deepseek-v4-pro",
          "configuration": "deepseek-disabled-thinking"
        }
      ]
    }
  ]
}

const manifest = () => ({ ...structuredClone(initial),
  issuedAt: new Date(Date.now() - 60000).toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
})

describe('policy qualification boundary', () => {
  it('exempts only the proven initial behavior against the exact released base', () => {
    expect(classifyQualification(manifest(), undefined, INITIAL_BASE_SHA).required).toBe(false)
    expect(classifyQualification(manifest(), undefined, '0'.repeat(40)).required).toBe(true)
    const changed = manifest()
    changed.policies[0]!.recommended = 'gemini-2.5-pro'
    changed.policies[0]!.fallbacks = ['gemini-3.8-flash']
    expect(classifyQualification(changed, undefined, INITIAL_BASE_SHA).required).toBe(true)
  })
  it('permits revision/date renewal with identical effective policy, independent of list order', () => {
    const candidate = manifest()
    candidate.revision++
    candidate.policies.reverse()
    candidate.policies.forEach(policy => policy.models.reverse())
    candidate.issuedAt = new Date(Date.now() - 60000).toISOString()
    candidate.expiresAt = new Date(Date.now() + 86400000).toISOString()
    expect(classifyQualification(candidate, manifest(), '1'.repeat(40))).toMatchObject({ required: false, reason: 'renewal' })
  })
  it('requires credentials for recommendation switches and rollback among existing tuples', () => {
    const switched = manifest()
    switched.revision++
    switched.policies[0]!.recommended = 'gemini-2.5-pro'
    switched.policies[0]!.fallbacks = ['gemini-3.8-flash']
    expect(classifyQualification(switched, manifest(), INITIAL_BASE_SHA).required).toBe(true)
    const rollback = manifest()
    rollback.revision = switched.revision + 1
    expect(classifyQualification(rollback, switched, INITIAL_BASE_SHA).required).toBe(true)
  })
  it('requires credentials for model/configuration/fallback changes and fails malformed comparison closed', () => {
    for (const modify of [
      (p: ReturnType<typeof manifest>) => { p.policies[0]!.models.push({ id: 'gemini-new-flash', configuration: 'default' }) },
      (p: ReturnType<typeof manifest>) => { p.policies[0]!.models[0]!.configuration = 'default' },
      (p: ReturnType<typeof manifest>) => { p.policies[0]!.fallbacks.reverse() },
    ]) {
      const candidate = manifest()
      candidate.revision++
      modify(candidate)
      expect(classifyQualification(candidate, manifest(), INITIAL_BASE_SHA).required).toBe(true)
    }
    expect(() => classifyQualification(manifest(), {}, INITIAL_BASE_SHA)).toThrow()
    expect(() => classifyQualification({}, undefined, INITIAL_BASE_SHA)).toThrow()
    expect(() => classifyQualification(manifest(), manifest(), INITIAL_BASE_SHA)).toThrow()
    expect(() => classifyQualification(manifest(), undefined, 'bad')).toThrow()
  })
})
