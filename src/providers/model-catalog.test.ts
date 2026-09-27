import { describe, expect, it } from 'vitest'
import { normalizeCatalog, compareCatalogs } from './model-catalog'

describe('provider model drift', () => {
  it('normalizes order and ignores unrelated model families without selecting any recommendation', () => {
    const models = [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'], version: '001' }, { name: 'models/embedding-001' }]
    expect(normalizeCatalog('gemini', { models })).toEqual(normalizeCatalog('gemini', { models: [...models].reverse() }))
    expect(normalizeCatalog('gemini', { models })).toHaveLength(1)
    expect(compareCatalogs(normalizeCatalog('gemini', { models }), normalizeCatalog('gemini', { models }))).toEqual([])
  })
  it('detects addition, removal, capability loss and replacement under an unchanged model id', () => {
    const before = normalizeCatalog('deepseek', { data: [{ id: 'deepseek-flash', input_modalities: ['text'], context_window: 128000 }, { id: 'deepseek-v4-pro' }] })
    const after = normalizeCatalog('deepseek', { data: [{ id: 'deepseek-flash', input_modalities: [], context_window: 64000 }, { id: 'deepseek-new' }] })
    expect(compareCatalogs(before, after).map(change => change.kind).sort()).toEqual(['added', 'changed', 'removed'])
  })
  it('rejects malformed, duplicate and unexpectedly empty catalogs instead of treating failures as retirement', () => {
    expect(() => normalizeCatalog('gemini', {})).toThrow()
    expect(() => normalizeCatalog('deepseek', { data: [] })).toThrow()
    expect(() => normalizeCatalog('deepseek', { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-flash' }] })).toThrow()
  })
})
