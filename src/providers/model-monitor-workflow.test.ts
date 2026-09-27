import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/model-policy-monitor.yml', import.meta.url), 'utf8')
const script = workflow.split('      - name: Record meaningful drift or an operational failure')[1]!
  .split('          script: |\n')[1]!.split('      - uses:')[0]!
  .split('\n').map(line => line.startsWith('            ') ? line.slice(12) : line).join('\n')
const catalog = [{ provider: 'deepseek', id: 'deepseek-flash', metadata: {} }]
const sources = [{ provider: 'deepseek', url: 'https://api-docs.deepseek.com/', fingerprint: 'source-fingerprint' }]
const report = { fingerprint: 'catalog-fingerprint', observed: catalog, sources, changes: [{ kind: 'changed', provider: 'deepseek', model: 'deepseek-flash' }], policyRevision: 1, checkedAt: 'synthetic-time' }
const run = async (files: Record<string, unknown>) => {
  const calls: Array<{ kind: string; body: string }> = []
  const execute = new Function('context', 'github', 'require', `return (async () => {${script}\n})()`)
  await execute({ serverUrl: 'https://github.com', repo: { owner: 'owner', repo: 'repo' }, runId: 1 }, {
    rest: { issues: {
      create: async ({ body }: { body: string }) => { calls.push({ kind: 'create', body }) },
      update: async ({ body }: { body: string }) => { calls.push({ kind: 'update', body }) },
    } },
  }, () => ({ existsSync: (path: string) => path in files, readFileSync: (path: string) => JSON.stringify(files[path]) }))
  return calls
}

describe('scheduled public drift evidence', () => {
  it('records actionable real Markdown and source provenance without promotion', async () => {
    const calls = await run({ 'model-drift-report.json': report })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toContain('\n## Provider model drift')
    expect(calls[0]!.body).not.toContain('\\n')
    expect(calls[0]!.body).toContain('not callable availability')
    expect(calls[0]!.body).toContain(`<!-- sources:${JSON.stringify(sources)} -->`)
  })
  it('stays quiet for the same observation and for an unchanged catalog', async () => {
    const [created] = await run({ 'model-drift-report.json': report })
    expect(await run({ 'model-drift-report.json': report, 'model-drift-tracker.json': { number: 2, body: created!.body } })).toEqual([])
    expect(await run({ 'model-drift-report.json': { ...report, changes: [] } })).toEqual([])
  })
  it('preserves both observations through a deduplicated operational failure', async () => {
    const [created] = await run({ 'model-drift-report.json': report })
    const [failed] = await run({ 'model-drift-tracker.json': { number: 2, body: created!.body } })
    expect(failed!.kind).toBe('update')
    expect(failed!.body).toContain(`<!-- catalog:${JSON.stringify(catalog)} -->`)
    expect(failed!.body).toContain(`<!-- sources:${JSON.stringify(sources)} -->`)
    expect(failed!.body).toContain('not an empty catalog or model retirement')
    expect(await run({ 'model-drift-tracker.json': { number: 2, body: failed!.body } })).toEqual([])
  })
  it('records recovery without authorizing any policy publication', async () => {
    const [failed] = await run({})
    const [recovered] = await run({ 'model-drift-report.json': { ...report, changes: [] }, 'model-drift-tracker.json': { number: 2, body: failed!.body } })
    expect(recovered!.body).toContain('Observation recovered; no catalog drift.')
    expect(recovered!.body).toContain('ordinary reviewed policy PR')
  })
})
