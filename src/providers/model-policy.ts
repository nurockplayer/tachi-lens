import bundledPolicyJson from '../../public/model-policy.json'
import packageJson from '../../package.json'

export const AUTO_MODEL = 'auto'

export type PolicyProvider = 'gemini' | 'deepseek'
export type PolicyWorkload = 'chat' | 'speech'
export type ModelConfiguration = 'default' | 'gemini-low-thinking' | 'deepseek-disabled-thinking'

export interface ModelPolicyManifest {
  schemaVersion: 1
  revision: number
  issuedAt: string
  expiresAt: string
  minimumClientVersion: string
  policies: Array<{
    provider: PolicyProvider
    workload: PolicyWorkload
    recommended: string
    fallbacks: string[]
    models: Array<{ id: string; configuration: ModelConfiguration }>
  }>
}

export interface ModelPolicySnapshot {
  manifest: ModelPolicyManifest
  source: 'remote' | 'cached' | 'bundled'
}

const MAX_COLLECTION_SIZE = 16
const MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000
const MODEL_ID_PATTERN = /^[a-z][a-z0-9.-]{0,79}$/
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))

const parseVersion = (version: string): [number, number, number] | undefined => {
  const match = VERSION_PATTERN.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

const versionAtLeast = (version: string, minimum: string): boolean => {
  const current = parseVersion(version)
  const required = parseVersion(minimum)
  if (!current || !required) return false
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== required[index]) return current[index]! > required[index]!
  }
  return true
}

const isProviderWorkload = (provider: unknown, workload: unknown): provider is PolicyProvider =>
  (provider === 'gemini' && (workload === 'chat' || workload === 'speech')) ||
  (provider === 'deepseek' && workload === 'chat')

const isConfigurationForProvider = (provider: PolicyProvider, configuration: unknown): configuration is ModelConfiguration => {
  if (provider === 'gemini') return configuration === 'default' || configuration === 'gemini-low-thinking'
  return configuration === 'deepseek-disabled-thinking'
}

const parseTimestamp = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return undefined
  return parsed
}

/** Validate untrusted policy data and return a typed copy only when every invariant holds. */
export const validateModelPolicy = (
  value: unknown,
  now: number,
  clientVersion: string,
  bundled = false,
): ModelPolicyManifest | undefined => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'revision', 'issuedAt', 'expiresAt', 'minimumClientVersion', 'policies'])) return undefined
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return undefined
  if (typeof value.minimumClientVersion !== 'string' || !parseVersion(value.minimumClientVersion) || !versionAtLeast(clientVersion, value.minimumClientVersion)) return undefined
  const issuedAt = parseTimestamp(value.issuedAt)
  const expiresAt = parseTimestamp(value.expiresAt)
  if (issuedAt === undefined || expiresAt === undefined || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_VALIDITY_MS) return undefined
  if (!bundled && (issuedAt > now + CLOCK_TOLERANCE_MS || expiresAt <= now)) return undefined
  if (!Array.isArray(value.policies) || value.policies.length > MAX_COLLECTION_SIZE) return undefined

  const policies: ModelPolicyManifest['policies'] = []
  const seenPolicyKeys = new Set<string>()
  for (const candidate of value.policies) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['provider', 'workload', 'recommended', 'fallbacks', 'models'])) return undefined
    const provider = candidate.provider
    const workloadValue = candidate.workload
    if (!isProviderWorkload(provider, workloadValue)) return undefined
    const workload = workloadValue as PolicyWorkload
    const key = `${provider}:${workload}`
    if (seenPolicyKeys.has(key)) return undefined
    seenPolicyKeys.add(key)
    const prefix = provider === 'gemini' ? 'gemini-' : 'deepseek-'
    const isSafeId = (id: unknown): id is string => typeof id === 'string' && id.startsWith(prefix) && MODEL_ID_PATTERN.test(id)
    if (!isSafeId(candidate.recommended) || !Array.isArray(candidate.fallbacks) || candidate.fallbacks.length > MAX_COLLECTION_SIZE || !Array.isArray(candidate.models) || candidate.models.length === 0 || candidate.models.length > MAX_COLLECTION_SIZE) return undefined
    const ids = new Set<string>()
    const models: ModelPolicyManifest['policies'][number]['models'] = []
    for (const model of candidate.models) {
      if (!isRecord(model) || !hasOnlyKeys(model, ['id', 'configuration']) || !isSafeId(model.id) || ids.has(model.id) || !isConfigurationForProvider(provider, model.configuration)) return undefined
      ids.add(model.id)
      models.push({ id: model.id, configuration: model.configuration })
    }
    if (!ids.has(candidate.recommended)) return undefined
    const fallbacks: string[] = []
    const seenFallbacks = new Set<string>()
    for (const fallback of candidate.fallbacks) {
      if (!isSafeId(fallback) || fallback === candidate.recommended || seenFallbacks.has(fallback) || !ids.has(fallback)) return undefined
      seenFallbacks.add(fallback)
      fallbacks.push(fallback)
    }
    policies.push({ provider, workload, recommended: candidate.recommended, fallbacks, models })
  }
  const required = ['gemini:chat', 'gemini:speech', 'deepseek:chat']
  if (required.some((key) => !seenPolicyKeys.has(key))) return undefined

  return {
    schemaVersion: 1,
    revision: value.revision as number,
    issuedAt: value.issuedAt as string,
    expiresAt: value.expiresAt as string,
    minimumClientVersion: value.minimumClientVersion,
    policies,
  }
}

const bundled = validateModelPolicy(bundledPolicyJson, Date.now(), packageJson.version, true)
if (!bundled) throw new Error('Bundled model policy is invalid')

export const BUNDLED_MODEL_POLICY: ModelPolicyManifest = bundled

const fallbackConfiguration = (provider: PolicyProvider, model: string): ModelConfiguration =>
  provider === 'deepseek' ? 'deepseek-disabled-thinking' : model.startsWith('gemini-3.') ? 'gemini-low-thinking' : 'default'

export interface ResolvedPolicyModel {
  provider: PolicyProvider
  workload: PolicyWorkload
  model: string
  configuration: ModelConfiguration
  source: ModelPolicySnapshot['source']
  revision: number
  selection: 'auto' | 'pinned'
}

export const resolvePolicyModel = (
  snapshot: ModelPolicySnapshot,
  provider: PolicyProvider,
  workload: PolicyWorkload,
  selection: string,
): ResolvedPolicyModel => {
  const isAuto = selection === AUTO_MODEL || selection === ''
  const policy = snapshot.manifest.policies.find((candidate) => candidate.provider === provider && candidate.workload === workload)
  const model = isAuto && policy ? policy.recommended : selection
  const configured = policy?.models.find((entry) => entry.id === model)?.configuration ??
    BUNDLED_MODEL_POLICY.policies.find((candidate) => candidate.provider === provider && candidate.workload === workload)?.models.find((entry) => entry.id === model)?.configuration
  return {
    provider,
    workload,
    model,
    configuration: configured ?? fallbackConfiguration(provider, model),
    source: snapshot.source,
    revision: snapshot.manifest.revision,
    selection: isAuto ? 'auto' : 'pinned',
  }
}
