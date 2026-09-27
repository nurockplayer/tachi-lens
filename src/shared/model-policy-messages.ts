import { isSafePolicyModelId, validateModelPolicy, type ModelPolicyManifest, type PolicyProvider, type ResolvedPolicyModel } from '@/providers/model-policy'
import packageMetadata from '../../package.json'

export interface ModelPolicySnapshotPayload {
  manifest: ModelPolicyManifest
  source: 'remote' | 'cached' | 'bundled'
  resolutions: Array<ResolvedPolicyModel & { timestamp: number }>
}

/** Popup-only data: never includes provider errors or user payloads. */
export const isModelPolicySnapshotMessage = (value: unknown): value is {
  type: 'model_policy_snapshot'
  payload: ModelPolicySnapshotPayload
} => {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  if (message.type !== 'model_policy_snapshot' || !message.payload || typeof message.payload !== 'object') return false
  const payload = message.payload as Record<string, unknown>
  if (!['remote', 'cached', 'bundled'].includes(String(payload.source))) return false
  if (!validateModelPolicy(payload.manifest, Date.now(), packageMetadata.version, payload.source === 'bundled')) return false
  if (!Array.isArray(payload.resolutions) || payload.resolutions.length > 20) return false
  return payload.resolutions.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false
    const record = item as Record<string, unknown>
    return Object.keys(record).every(key => ['provider', 'workload', 'model', 'configuration', 'source', 'revision', 'selection', 'timestamp'].includes(key))
      && ['gemini', 'deepseek'].includes(String(record.provider))
      && ['chat', 'speech'].includes(String(record.workload))
      && isSafePolicyModelId(record.provider as PolicyProvider, record.model)
      && ['default', 'gemini-low-thinking', 'deepseek-disabled-thinking'].includes(String(record.configuration))
      && ['remote', 'cached', 'bundled'].includes(String(record.source))
      && ['auto', 'pinned'].includes(String(record.selection))
      && Number.isSafeInteger(record.revision) && typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
  })
}
