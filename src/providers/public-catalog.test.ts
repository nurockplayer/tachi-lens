import { describe, expect, it } from 'vitest'
import { discoverPublicCatalog, parseDeepSeekPublicCatalog, parseGeminiPublicCatalog, PUBLIC_CATALOG_URLS } from '../../scripts/model-policy/public-catalog'

const geminiModels = (entries: Array<{ id: string; description?: string; state?: string }>, nav = 'gemini-9.9-flash', extra = '') => `
  <nav><a>${nav}</a></nav><main><h1>Models</h1><div class="devsite-article-body">
  <p>This guide introduces all the models available through the Gemini API.</p>
  <table><thead><tr><th>Model</th><th>Description</th><th>Endpoint</th></tr></thead><tbody>
  ${entries.map(({ id, description = 'General-purpose model.', state = '' }) => `<tr><td>${id}${state}</td><td>${description}</td><td><code>${id}</code></td></tr>`).join('')}
  </tbody></table>${extra}</div></main><footer>gemini-8.8-pro</footer>`
const geminiDeprecations = (rows: Array<[string, string, string]>) => `
  <main><h1>Gemini deprecations</h1><div class="devsite-article-body"><table>
  <tr><th>Model</th><th>Release date</th><th>Shutdown date</th><th>Recommended replacement</th></tr>
  ${rows.map(([id, shutdown, replacement]) => `<tr><td>${id}</td><td>June 2025</td><td>${shutdown}</td><td>${replacement}</td></tr>`).join('')}
  </table></div></main>`
const geminiChangelog = (statement: string, noise = 'Benchmark score increased to 99%.') => `
  <main><h1>Release notes</h1><div class="devsite-article-body"><h2>September 22, 2026</h2>
  <p>${statement}</p><p>${noise}</p></div><nav>Pricing for gemini-3.8-flash</nav></main>`
const deepSeekModels = (models = 'deepseek-flash (1)<br>deepseek-v4-pro (2)', nav = 'deepseek-v99-hidden', extra = '') => `
  <nav>${nav}</nav><main><h1>Your First API Call</h1><div class="theme-doc-markdown">
  <table><tr><th>PARAM</th><th>VALUE</th></tr><tr><td>base_url</td><td>https://api.deepseek.com</td></tr>
  <tr><td>api_key</td><td>apply for an API key</td></tr><tr><td>model</td><td>${models}</td></tr></table>${extra}</div></main>`
const deepSeekUpdates = (body: string, noise = '<p>Benchmark: 99%; API pricing is $1.</p>') => `
  <main><h1>Change Log</h1><div class="theme-doc-markdown"><h3>Date: 2026-09-10</h3>
  <h3>DeepSeek-V4.1-Flash Release</h3><p>${body}</p>${noise}</div><nav>deepseek-v77-nav</nav></main>`

describe('credential-free public provider documentation discovery', () => {
  it('detects Gemini documented IDs and same-ID lifecycle, support, and option changes', () => {
    const models = geminiModels([{ id: 'gemini-3.8-flash', description: 'Supports generateContent and low thinking.' }, { id: 'gemini-2.5-pro' }])
    const before = parseGeminiPublicCatalog(models, geminiDeprecations([['gemini-3.8-flash', 'No shutdown date announced', '']]), geminiChangelog('Gemini 3.8 Flash (gemini-3.8-flash) supports low thinking and generateContent.'))
    const changed = parseGeminiPublicCatalog(models, geminiDeprecations([['gemini-3.8-flash', 'December 1, 2026', 'gemini-4.0-flash']]), geminiChangelog('Gemini 3.8 Flash (gemini-3.8-flash) now supports high thinking and a new audio option.'))
    expect(before.observed.map(model => model.id)).toEqual(['gemini-2.5-pro', 'gemini-3.8-flash'])
    expect(changed.observed.find(model => model.id === 'gemini-3.8-flash')?.metadata).not.toEqual(before.observed.find(model => model.id === 'gemini-3.8-flash')?.metadata)
  })

  it('detects documented Gemini additions/removals while ignoring navigation, order, benchmark, pricing, and layout noise', () => {
    const dep = geminiDeprecations([['gemini-3.8-flash', 'No shutdown date announced', '']])
    const notes = geminiChangelog('Gemini 3.8 Flash (gemini-3.8-flash) remains available through generateContent.')
    const first = parseGeminiPublicCatalog(geminiModels([{ id: 'gemini-3.8-flash' }, { id: 'gemini-2.5-pro' }]), dep, notes)
    const reordered = parseGeminiPublicCatalog(geminiModels([{ id: 'gemini-2.5-pro' }, { id: 'gemini-3.8-flash' }], 'gemini-4.0-pro'), dep, geminiChangelog('Gemini 3.8 Flash (gemini-3.8-flash) remains available through generateContent.', 'Benchmark changed to 1%; pricing changed to $9. Gemini embedding-2 supports generateContent.'))
    const reduced = parseGeminiPublicCatalog(geminiModels([{ id: 'gemini-3.8-flash' }]), dep, notes)
    expect(reordered.sources.map(source => source.fingerprint)).toEqual(first.sources.map(source => source.fingerprint))
    expect(reduced.observed.map(model => model.id)).toEqual(['gemini-3.8-flash'])
  })

  it('tracks access notices and explicit model lifecycle state while ignoring marketing descriptions', () => {
    const baseline = parseGeminiPublicCatalog(
      geminiModels([{ id: 'gemini-2.5-pro', description: 'Highly advanced and thoughtful creative work.' }]),
      geminiDeprecations([['gemini-2.5-pro', 'No shutdown date announced', '']]),
      geminiChangelog('Gemini 2.5 models remain available through the API.'),
    )
    const accessChanged = parseGeminiPublicCatalog(
      geminiModels([{ id: 'gemini-2.5-pro', description: 'Different marketing copy.' }], 'gemini-9.9-flash', '<aside class="note">Gemini 2.5 models are limited to existing API users.</aside>'),
      geminiDeprecations([['gemini-2.5-pro', 'No shutdown date announced', '']]),
      geminiChangelog('Gemini 2.5 models remain available through the API.'),
    )
    const stateChanged = parseGeminiPublicCatalog(
      geminiModels([{ id: 'gemini-2.5-pro', description: 'Another unrelated marketing phrase.', state: ' (Shut down)' }]),
      geminiDeprecations([['gemini-2.5-pro', 'No shutdown date announced', '']]),
      geminiChangelog('Gemini 2.5 models remain available through the API.'),
    )
    expect(accessChanged.observed[0]?.metadata.technicalFingerprint).not.toBe(baseline.observed[0]?.metadata.technicalFingerprint)
    expect(stateChanged.observed[0]?.metadata.technicalFingerprint).not.toBe(baseline.observed[0]?.metadata.technicalFingerprint)
    expect(stateChanged.sources[0]?.fingerprint).not.toBe(baseline.sources[0]?.fingerprint)
    const marketingOnly = parseGeminiPublicCatalog(
      geminiModels([{ id: 'gemini-2.5-pro', description: 'A newly worded marketing description.' }]),
      geminiDeprecations([['gemini-2.5-pro', 'No shutdown date announced', '']]),
      geminiChangelog('Gemini 2.5 models remain available through the API.'),
    )
    expect(marketingOnly.observed[0]?.metadata.technicalFingerprint).toBe(baseline.observed[0]?.metadata.technicalFingerprint)
  })

  it('detects DeepSeek documented models and technical update changes without benchmarking or price noise', () => {
    const before = parseDeepSeekPublicCatalog(deepSeekModels(), deepSeekUpdates('Change to deepseek-flash enables image input and thinking controls.'))
    const changed = parseDeepSeekPublicCatalog(deepSeekModels(), deepSeekUpdates('Change to deepseek-flash adds audio input and a new reasoning option.'))
    const noise = parseDeepSeekPublicCatalog(deepSeekModels('deepseek-v4-pro (2)<br>deepseek-flash (1)', 'deepseek-v00-nav'), deepSeekUpdates('Change to deepseek-flash enables image input and thinking controls.', '<p>Benchmark: 1%; prices changed to $0.</p>'))
    expect(before.observed.map(model => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(changed.observed[0]?.metadata).not.toEqual(before.observed[0]?.metadata)
    expect(noise.sources.map(source => source.fingerprint)).toEqual(before.sources.map(source => source.fingerprint))
  })

  it('tracks DeepSeek documented alias repointing and retirement notices for the stable model ID', () => {
    const before = parseDeepSeekPublicCatalog(
      deepSeekModels(),
      deepSeekUpdates('DeepSeek V4.1 Flash released. The deepseek-flash model is available through the API.'),
    )
    const changed = parseDeepSeekPublicCatalog(
      deepSeekModels('deepseek-flash (1)<br>deepseek-v4-pro (2)', 'deepseek-v00-nav', '<p>For compatibility, deepseek-v4-flash is still accepted and now routes to deepseek-flash. The old deepseek-v4-flash model is retired.</p>'),
      deepSeekUpdates('DeepSeek V4.1 Flash released. The deepseek-flash model is available through the API.'),
    )
    expect(changed.observed[0]?.metadata.technicalFingerprint).not.toBe(before.observed[0]?.metadata.technicalFingerprint)
    expect(changed.sources[0]?.fingerprint).not.toBe(before.sources[0]?.fingerprint)
  })

  it('records a supported-model announcement before the public endpoint table catches up', () => {
    const models = geminiModels([{ id: 'gemini-3.8-flash' }])
    const lifecycle = geminiDeprecations([['gemini-3.8-flash', 'No shutdown date announced', '']])
    const before = parseGeminiPublicCatalog(models, lifecycle, geminiChangelog('gemini-3.8-flash supports generateContent.'))
    const after = parseGeminiPublicCatalog(models, lifecycle, geminiChangelog('gemini-3.8-flash supports generateContent. Gemini 4.0 Flash (gemini-4.0-flash) is now available through the API.'))
    expect(after.observed.map(model => model.id)).toEqual(before.observed.map(model => model.id))
    expect(after.sources[2]!.fingerprint).not.toBe(before.sources[2]!.fingerprint)
    const dsBefore = parseDeepSeekPublicCatalog(deepSeekModels(), deepSeekUpdates('deepseek-flash supports disabled thinking.'))
    const dsAfter = parseDeepSeekPublicCatalog(deepSeekModels(), deepSeekUpdates('deepseek-flash supports disabled thinking. deepseek-v5-pro is now available through the API.'))
    expect(dsAfter.sources[1]!.fingerprint).not.toBe(dsBefore.sources[1]!.fingerprint)
  })

  it('ignores price-only changes within otherwise unchanged operational statements', () => {
    const before = parseDeepSeekPublicCatalog(deepSeekModels(), deepSeekUpdates('deepseek-flash supports disabled thinking; pricing is $0.10 per token.'))
    const after = parseDeepSeekPublicCatalog(deepSeekModels(), deepSeekUpdates('deepseek-flash supports disabled thinking; pricing is $0.20 per token.'))
    expect(after.sources.map(source => source.fingerprint)).toEqual(before.sources.map(source => source.fingerprint))
    expect(after.observed).toEqual(before.observed)
    const geminiBefore = parseGeminiPublicCatalog(
      geminiModels([{ id: 'gemini-3.8-flash' }]),
      geminiDeprecations([['gemini-3.8-flash', 'No shutdown date announced', '']]),
      geminiChangelog('gemini-3.8-flash supports generateContent; pricing is $0.10 per token.'),
    )
    const geminiAfter = parseGeminiPublicCatalog(
      geminiModels([{ id: 'gemini-3.8-flash' }]),
      geminiDeprecations([['gemini-3.8-flash', 'No shutdown date announced', '']]),
      geminiChangelog('gemini-3.8-flash supports generateContent; pricing is $0.20 per token.'),
    )
    expect(geminiAfter.sources.map(source => source.fingerprint)).toEqual(geminiBefore.sources.map(source => source.fingerprint))
  })

  it('captures dated supported-model headings with generic technical release details', () => {
    const geminiModelsHtml = geminiModels([{ id: 'gemini-3.8-flash' }])
    const lifecycle = geminiDeprecations([['gemini-3.8-flash', 'No shutdown date announced', '']])
    const geminiBefore = parseGeminiPublicCatalog(geminiModelsHtml, lifecycle, geminiChangelog('gemini-3.8-flash remains available through generateContent.'))
    const geminiAfter = parseGeminiPublicCatalog(geminiModelsHtml, lifecycle, `
      <main><h1>Release notes</h1><div class="devsite-article-body"><h2>September 22, 2026</h2>
      <h3>Gemini 4.0 Flash</h3><p>Introduces a configurable reasoning option and audio input.</p></div></main>`)
    expect(geminiAfter.sources[2]?.fingerprint).not.toBe(geminiBefore.sources[2]?.fingerprint)

    const deepSeekBefore = parseDeepSeekPublicCatalog(deepSeekModels(), deepSeekUpdates('deepseek-flash supports disabled thinking.'))
    const deepSeekAfter = parseDeepSeekPublicCatalog(deepSeekModels(), `
      <main><h1>Change Log</h1><div class="theme-doc-markdown"><h3>Date: 2026-09-10</h3>
      <h3>DeepSeek V5 Pro Release</h3><p>Adds structured output and a configurable reasoning option.</p></div></main>`)
    expect(deepSeekAfter.sources[1]?.fingerprint).not.toBe(deepSeekBefore.sources[1]?.fingerprint)
  })

  it('retains heading-only announcements and model context through nested capability headings', () => {
    const models = geminiModels([{ id: 'gemini-3.8-flash' }])
    const lifecycle = geminiDeprecations([['gemini-3.8-flash', 'No shutdown date announced', '']])
    const baseline = geminiChangelog('gemini-3.8-flash supports generateContent.')
    const append = (extra: string) => baseline.replace('</div><nav>', `${extra}</div><nav>`)
    const before = parseGeminiPublicCatalog(models, lifecycle, baseline)
    const headingOnly = parseGeminiPublicCatalog(models, lifecycle, append('<h3>Gemini 4.0 Flash</h3>'))
    expect(headingOnly.sources[2]?.fingerprint).not.toBe(before.sources[2]?.fingerprint)
    const option = (value: string) => parseGeminiPublicCatalog(models, lifecycle,
      append(`<h3>Gemini 4.0 Flash</h3><h4>Capabilities</h4><p>Supports ${value} thinking.</p>`))
    expect(option('high').sources[2]?.fingerprint).not.toBe(option('low').sources[2]?.fingerprint)
  })

  it('rejects login pages, missing documentation structure, empty and oversized supported catalogs', () => {
    expect(() => parseGeminiPublicCatalog('<h1>Sign in</h1>', geminiDeprecations([]), geminiChangelog(''))).toThrow()
    expect(() => parseGeminiPublicCatalog(geminiModels([{ id: 'embedding-001' }]), geminiDeprecations([]), geminiChangelog(''))).toThrow()
    expect(() => parseDeepSeekPublicCatalog('<h1>Sign in</h1>', deepSeekUpdates(''))).toThrow()
    expect(() => parseDeepSeekPublicCatalog(deepSeekModels('no model ids'), deepSeekUpdates(''))).toThrow()
    expect(() => parseGeminiPublicCatalog(geminiModels([{ id: 'gemini-3.8-flash' }]), geminiDeprecations([['gemini-3.8-flash', 'No shutdown date announced', '']]), '<main><h1>Release notes</h1><div class="devsite-article-body"><p>Gemini models support an option.</p></div></main>')).toThrow()
    const tooLongGeminiId = `gemini-${'a'.repeat(69)}flash`
    expect(tooLongGeminiId.length).toBeGreaterThan(80)
    expect(() => parseGeminiPublicCatalog(geminiModels([{ id: tooLongGeminiId }]), geminiDeprecations([['gemini-3.8-flash', 'No shutdown date announced', '']]), geminiChangelog('Gemini 3.8 Flash (gemini-3.8-flash) supports generateContent.'))).toThrow()
  })

  it('uses fixed public URLs without credentials and rejects redirect or oversized source responses', async () => {
    const requested: Array<{ url: string; init?: RequestInit }> = []
    const responses = [
      geminiModels([{ id: 'gemini-3.8-flash' }]),
      geminiDeprecations([['gemini-3.8-flash', 'No shutdown date announced', '']]),
      geminiChangelog('gemini-3.8-flash supports generateContent.'),
      deepSeekModels(),
      deepSeekUpdates('deepseek-flash supports image input.'),
    ]
    const result = await discoverPublicCatalog(async (input, init) => {
      requested.push({ url: String(input), init })
      return new Response(responses.shift(), { status: 200 })
    })
    expect(result.observed.length).toBeGreaterThan(0)
    expect(requested).toHaveLength(5)
    expect(requested.map(request => request.url)).toEqual(Object.values(PUBLIC_CATALOG_URLS))
    expect(requested.every(request => request.init?.credentials === 'omit' && request.init?.redirect === 'error')).toBe(true)
    await expect(discoverPublicCatalog(async () => new Response('<h1>Sign in</h1>', { status: 200 }))).rejects.toThrow()
    const oversized = new Response(new Uint8Array(1_048_577))
    await expect(discoverPublicCatalog(async () => oversized)).rejects.toThrow()
  })
})
