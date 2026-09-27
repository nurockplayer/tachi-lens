import type { PolicyProvider } from './model-policy'

export interface CatalogModel {
  provider: PolicyProvider
  id: string
  metadata: Record<string, string | number | boolean | string[]>
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const METADATA_KEYS = ['version', 'thinking', 'inputTokenLimit', 'outputTokenLimit', 'supportedGenerationMethods', 'context_window', 'max_output_tokens', 'input_modalities', 'output_modalities', 'deprecated', 'deprecationTime', 'shutdownTime', 'replacement', 'owned_by']

/** Only stable API metadata; marketing text/order is deliberately excluded. */
export const normalizeCatalog = (provider: PolicyProvider, body: unknown): CatalogModel[] => {
  if (!isRecord(body)) throw new Error('Invalid catalog')
  const entries = provider === 'gemini' ? body.models : body.data
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error('Invalid catalog')
  const result: CatalogModel[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) throw new Error('Invalid catalog entry')
    const rawId = provider === 'gemini' ? entry.name : entry.id
    if (typeof rawId !== 'string') throw new Error('Invalid model identifier')
    const id = provider === 'gemini' ? rawId.replace(/^models\//, '') : rawId
    if (provider === 'gemini' && !/^gemini-.*(flash|pro)/.test(id)) continue
    if (!id.startsWith(`${provider}-`) || !/^[a-z][a-z0-9.-]{0,79}$/.test(id)) continue
    const metadata: CatalogModel['metadata'] = {}
    for (const key of METADATA_KEYS) {
      const value = entry[key]
      if (typeof value === 'string' && value.length <= 160 || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) metadata[key] = value
      else if (Array.isArray(value) && value.length <= 32 && value.every(item => typeof item === 'string' && item.length <= 80)) metadata[key] = [...value].sort()
    }
    // DeepSeek exposes request capabilities as structured metadata.
    for (const key of ['effort', 'api_capabilities']) {
      if (provider === 'deepseek' && isRecord(entry[key])) {
        const canonical = JSON.stringify(entry[key], (_key, value: unknown) => isRecord(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
        if (canonical.length > 2048) throw new Error('Oversized capability metadata')
        metadata[key] = canonical
      }
    }
    result.push({ provider, id, metadata })
  }
  if (result.length === 0 || result.length > 150 || new Set(result.map(entry => entry.id)).size !== result.length) throw new Error('Empty, oversized, or duplicate supported catalog')
  return result.sort((a, b) => a.id.localeCompare(b.id))
}

export const compareCatalogs = (before: CatalogModel[], after: CatalogModel[]) => {
  const previous = new Map(before.map(model => [`${model.provider}:${model.id}`, model]))
  const current = new Map(after.map(model => [`${model.provider}:${model.id}`, model]))
  const changes: Array<{ kind: 'added' | 'removed' | 'changed'; provider: PolicyProvider; model: string }> = []
  for (const [key, model] of current) {
    const old = previous.get(key)
    if (!old) changes.push({ kind: 'added', provider: model.provider, model: model.id })
    else if (JSON.stringify(old.metadata) !== JSON.stringify(model.metadata)) changes.push({ kind: 'changed', provider: model.provider, model: model.id })
  }
  for (const [key, model] of previous) if (!current.has(key)) changes.push({ kind: 'removed', provider: model.provider, model: model.id })
  return changes
}
