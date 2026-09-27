import { createHash } from 'node:crypto'
import { validateModelPolicy, type ModelPolicyManifest } from '../../src/providers/model-policy'
import packageMetadata from '../../package.json'

// One-time bootstrap binding, reviewed against the released providers at this main SHA.
// Never derive this fingerprint from the PR candidate or grant it to a different base.
export const INITIAL_BASE_SHA = 'ddd7fec501d63cbd995329e3be91e577b39d01cb'
const INITIAL_BEHAVIOR_SHA256 = 'd6755b7ffad7425b2812130a33a56824bc59ef0581484fc9c5499018f1394d8e'

export const policyBehaviorFingerprint = (manifest: ModelPolicyManifest): string => {
  const policies = manifest.policies.map(policy => ({
    ...policy,
    models: [...policy.models].sort((a, b) => a.id.localeCompare(b.id)),
  })).sort((a, b) => `${a.provider}:${a.workload}`.localeCompare(`${b.provider}:${b.workload}`))
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    minimumClientVersion: manifest.minimumClientVersion,
    policies,
  })).digest('hex')
}

export const classifyQualification = (candidateValue: unknown, baseValue: unknown | undefined, baseSha: string) => {
  if (!/^[a-f0-9]{40}$/.test(baseSha)) throw new Error('Invalid exact policy base SHA')
  const candidate = validateModelPolicy(candidateValue, Date.now(), packageMetadata.version)
  if (!candidate) throw new Error('Invalid current candidate policy')
  const candidateFingerprint = policyBehaviorFingerprint(candidate)
  if (baseValue === undefined) {
    const preserved = baseSha === INITIAL_BASE_SHA && candidateFingerprint === INITIAL_BEHAVIOR_SHA256
    return { required: !preserved, reason: preserved ? 'initial-preserved-main' : 'qualification-required', baseSha, candidateFingerprint }
  }
  // An expired base still defines its previous behavior; the candidate must be current.
  const base = validateModelPolicy(baseValue, Date.now(), packageMetadata.version, true)
  if (!base) throw new Error('Invalid base policy; qualification comparison failed closed')
  if (candidate.revision <= base.revision) throw new Error('Policy revision must strictly increase')
  const unchanged = policyBehaviorFingerprint(base) === candidateFingerprint
  return { required: !unchanged, reason: unchanged ? 'renewal' : 'qualification-required', baseSha, candidateFingerprint }
}
