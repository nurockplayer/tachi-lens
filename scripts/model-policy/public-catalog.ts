import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import type { CatalogModel } from '../../src/providers/model-catalog'

export const PUBLIC_CATALOG_URLS = {
  geminiModels: 'https://ai.google.dev/gemini-api/docs/models?hl=en',
  geminiDeprecations: 'https://ai.google.dev/gemini-api/docs/deprecations?hl=en',
  geminiChangelog: 'https://ai.google.dev/gemini-api/docs/changelog?hl=en',
  deepseekModels: 'https://api-docs.deepseek.com/',
  deepseekUpdates: 'https://api-docs.deepseek.com/updates/',
} as const

const MAX_SOURCE_BYTES = 1_048_576
const SOURCE_TIMEOUT_MS = 15_000
const SAFE_ID = /^[a-z][a-z0-9.-]{0,79}$/
const supportedGeminiId = (id: string) => id.startsWith('gemini-') && SAFE_ID.test(id) && /^gemini-.*(?:flash|pro)/.test(id)
const supportedDeepSeekId = (id: string) => id.startsWith('deepseek-') && SAFE_ID.test(id)
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const cleanText = (value: string) => value.replace(/\s+/g, ' ').trim()
const normalizeText = (value: string) => cleanText(value).toLowerCase()

export interface PublicCatalogSource {
  provider: 'gemini' | 'deepseek'
  url: string
  fingerprint: string
}

export interface PublicCatalogResult {
  observed: CatalogModel[]
  sources: PublicCatalogSource[]
}

interface GeminiPageFacts {
  observed: CatalogModel[]
  modelFingerprint: string
  lifecycleFingerprint: string
  changelogFingerprint: string
}

const articleFor = (html: string, provider: 'gemini' | 'deepseek', titlePattern: RegExp): { document: Document; article: Element } => {
  if (typeof html !== 'string' || html.length === 0 || html.length > MAX_SOURCE_BYTES) throw new Error('Invalid public documentation response')
  const document = new JSDOM(html).window.document
  const title = cleanText(document.querySelector('main h1, article h1, h1')?.textContent ?? '')
  if (!titlePattern.test(title)) throw new Error(`Unexpected ${provider} documentation page`)
  const article = provider === 'gemini' ? document.querySelector('.devsite-article-body') : document.querySelector('.theme-doc-markdown')
  if (!article || article.textContent?.trim().length === 0) throw new Error(`Missing ${provider} documentation article`)
  return { document, article }
}

const safeIdsIn = (value: string, validate: (id: string) => boolean) => [...new Set(value.match(/[a-z0-9.-]+/gi) ?? [])]
  .map(id => id.toLowerCase())
  .filter(id => SAFE_ID.test(id) && validate(id))

const technicalText = (sentence: string) => cleanText(sentence
  // Consume the whole pricing/benchmark clause: periods also occur inside decimals.
  .replace(/\b(?:(?:api|model)\s+)?(?:benchmarks?|pricing|prices?|billed at|priced at|cost)\b(?:(?![.!?](?:\s|$)|;)[\s\S])*/gi, ' ')
  .replace(/\$\s?\d+(?:\.\d+)?|\b\d+(?:\.\d+)?\s?%/gi, ' '))

const isTechnicalSentence = (sentence: string) =>
  /\b(?:support(?:s|ed)?|available|access|deprecated|deprecat(?:e|ion)|shut ?down|retir(?:e|ed)|replacement|replace[sd]?|endpoint|api|model|thinking|reasoning|audio|transcrib|input|output|context|token|tool|function call|generatecontent|option|capabilit(?:y|ies)|release|general availability|preview|ga\b|limited|accept(?:ed|s)?|legacy|served|routed?)\b/i.test(sentence)

const operationalSentences = (value: string) => cleanText(value)
  .split(/(?<=[.!?])\s+/)
  .map(technicalText)
  .filter(sentence => sentence.length > 0 && sentence.length <= 2000 && isTechnicalSentence(sentence))

const announcesSupportedModel = (statement: string, provider: 'gemini' | 'deepseek') =>
  safeIdsIn(statement, provider === 'gemini' ? supportedGeminiId : supportedDeepSeekId).length > 0 ||
  (provider === 'gemini'
    ? /\bgemini[-\s]+\d+(?:\.\d+)?[-\s]+(?:flash|pro)\b/i.test(statement)
    : /\bdeepseek[-\s]+v?\d+(?:\.\d+)?[-\s]+(?:flash|pro)\b/i.test(statement))

const datedOperationalText = (article: Element, provider: 'gemini' | 'deepseek') => {
  const selected: string[] = []
  let inDatedSection = false
  let modelHeading = ''
  let modelHeadingLevel = 0
  const walker = article.ownerDocument!.createTreeWalker(article, 1 /* NodeFilter.SHOW_ELEMENT */)
  let node = walker.nextNode() as Element | null
  while (node) {
    const tag = node.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag)) {
      const text = cleanText(node.textContent ?? '')
      if (/\b(?:date:\s*)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+20\d{2}\b|\bdate:\s*20\d{2}-\d{2}-\d{2}\b/i.test(text)) {
        inDatedSection = true
        modelHeading = ''
        modelHeadingLevel = 0
      } else if (inDatedSection) {
        const level = Number(tag.slice(1))
        if (announcesSupportedModel(text, provider)) {
          modelHeading = technicalText(text)
          modelHeadingLevel = level
          selected.push(modelHeading)
        } else if (level <= modelHeadingLevel) {
          modelHeading = ''
          modelHeadingLevel = 0
        }
      }
    } else if (inDatedSection && (tag === 'p' || tag === 'li')) {
      const text = cleanText(node.textContent ?? '')
      if (text.length <= 4000) selected.push(...operationalSentences(text).map(statement => modelHeading ? `${modelHeading}: ${statement}` : statement))
    }
    node = walker.nextNode() as Element | null
  }
  return [...new Set(selected.map(normalizeText))].sort()
}

const hasModelMention = (id: string, text: string, provider: 'gemini' | 'deepseek') => {
  const lower = normalizeText(text)
  if (lower.includes(id)) return true
  const label = id.replace(new RegExp(`^${provider}-`), '').replace(/[-.]/g, ' ')
  const brand = provider === 'gemini' ? 'gemini' : 'deepseek'
  if (new RegExp(`\\b${brand}\\s+${label.replace(/ /g, '\\s+')}\\b`, 'i').test(lower)) return true
  if (provider === 'gemini') {
    const family = id.match(/^gemini-(\d+(?:\.\d+)?)-/)
    return Boolean(family?.[1] && new RegExp(`\\bgemini\\s+${family[1].replace('.', '\\.')}\\b`, 'i').test(lower))
  }
  if (id === 'deepseek-flash') return /\bdeepseek\s+v4(?:\.1)?\s+flash\b/i.test(lower)
  return false
}

const geminiModelRows = (article: Element) => {
  const rows = new Map<string, string[]>()
  let recognizedTable = false
  for (const table of article.querySelectorAll('table')) {
    const headers = [...table.querySelectorAll('tr:first-child th, tr:first-child td')].map(cell => normalizeText(cell.textContent ?? ''))
    const endpointColumn = headers.findIndex(header => /^endpoint\b/.test(header))
    const modelColumn = headers.findIndex(header => /^model\b/.test(header))
    if (endpointColumn < 0 || modelColumn < 0) continue
    recognizedTable = true
    for (const row of [...table.querySelectorAll('tr')].slice(1)) {
      const cells = [...row.querySelectorAll('th,td')]
      const endpoint = cells[endpointColumn]
      const modelLabel = cells[modelColumn]?.textContent ?? ''
      if (!endpoint || !cells[modelColumn]) continue
      const state = modelLabel.match(/\b(?:shut\s*down|deprecated|retired|preview|generally available|ga)\b/i)?.[0]
      const rowFacts = state ? [normalizeText(state)] : []
      for (const id of safeIdsIn(endpoint.textContent ?? '', supportedGeminiId)) {
        const statements = [...new Set([...(rows.get(id) ?? []), ...rowFacts])].sort()
        rows.set(id, statements)
      }
    }
  }
  if (!recognizedTable || rows.size === 0 || rows.size > 150) throw new Error('Gemini model endpoint table is missing, empty, or oversized')
  return rows
}

const geminiLifecycleRows = (article: Element) => {
  const rows = new Map<string, { shutdownDate: string; replacement: string }>()
  let recognizedTable = false
  let supportedRows = 0
  for (const table of article.querySelectorAll('table')) {
    const headers = [...table.querySelectorAll('tr:first-child th, tr:first-child td')].map(cell => normalizeText(cell.textContent ?? ''))
    const modelColumn = headers.findIndex(header => /^model\b/.test(header))
    const shutdownColumn = headers.findIndex(header => /shutdown/.test(header))
    const replacementColumn = headers.findIndex(header => /recommended replacement/.test(header))
    if (modelColumn < 0 || shutdownColumn < 0 || replacementColumn < 0) continue
    recognizedTable = true
    for (const row of [...table.querySelectorAll('tr')].slice(1)) {
      const cells = [...row.querySelectorAll('th,td')]
      const id = safeIdsIn(cells[modelColumn]?.textContent ?? '', supportedGeminiId)[0]
      if (!id) continue
      const shutdownDate = cleanText(cells[shutdownColumn]?.textContent ?? '')
      const replacement = cleanText(cells[replacementColumn]?.textContent ?? '')
      if (!shutdownDate || shutdownDate.length > 160 || replacement.length > 320) throw new Error('Invalid Gemini lifecycle row')
      const existing = rows.get(id)
      if (existing && (existing.shutdownDate !== shutdownDate || existing.replacement !== replacement)) throw new Error('Conflicting Gemini lifecycle rows')
      rows.set(id, { shutdownDate, replacement })
      supportedRows++
    }
  }
  if (!recognizedTable || supportedRows === 0 || supportedRows > 150) throw new Error('Gemini lifecycle table is missing, empty, or oversized')
  return rows
}

const parseGeminiFacts = (modelsHtml: string, deprecationsHtml: string, changelogHtml: string): GeminiPageFacts => {
  const { article: modelsArticle } = articleFor(modelsHtml, 'gemini', /^models$/i)
  const { article: lifecycleArticle } = articleFor(deprecationsHtml, 'gemini', /^gemini deprecations$/i)
  const { article: changelogArticle } = articleFor(changelogHtml, 'gemini', /^release notes$/i)
  if (!/models available through the gemini api/i.test(cleanText(modelsArticle.textContent ?? ''))) throw new Error('Gemini models page purpose marker is missing')
  const modelRows = geminiModelRows(modelsArticle)
  const lifecycleRows = geminiLifecycleRows(lifecycleArticle)
  const accessNotes = [...new Set([...modelsArticle.querySelectorAll('aside.note, .note')]
    .flatMap(note => operationalSentences(note.textContent ?? '').map(normalizeText)))].sort()
  const allAnnouncements = datedOperationalText(changelogArticle, 'gemini')
  const announcements = allAnnouncements.filter(statement => announcesSupportedModel(statement, 'gemini') || [...modelRows.keys()].some(id => hasModelMention(id, statement, 'gemini')))
  if (announcements.length === 0 || !announcements.some(statement => /\b(?:gemini|models?|api)\b/i.test(statement))) throw new Error('Gemini dated operational changelog statements are missing')

  const observed: CatalogModel[] = [...modelRows.entries()].map(([id, rowStatements]) => {
    const lifecycle = lifecycleRows.get(id)
    const idAnnouncements = announcements.filter(statement => hasModelMention(id, statement, 'gemini'))
    const idAccessNotes = accessNotes.filter(statement => hasModelMention(id, statement, 'gemini'))
    const technical = [...new Set([...rowStatements, ...idAccessNotes, ...idAnnouncements])].sort()
    return {
      provider: 'gemini' as const,
      id,
      metadata: {
        documentedInModelsPage: true,
        technicalFingerprint: sha256(technical),
        ...(lifecycle ? { shutdownDate: lifecycle.shutdownDate, replacement: lifecycle.replacement } : {}),
      },
    }
  }).sort((a, b) => a.id.localeCompare(b.id))
  return {
    observed,
    modelFingerprint: sha256({
      models: [...modelRows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, facts]) => [id, [...facts].sort()]),
      accessNotes: accessNotes.filter(statement => [...modelRows.keys()].some(id => hasModelMention(id, statement, 'gemini'))),
    }),
    lifecycleFingerprint: sha256([...lifecycleRows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, facts]) => [id, facts])),
    changelogFingerprint: sha256(announcements),
  }
}

const deepSeekModelIds = (article: Element) => {
  let recognizedTable = false
  const ids = new Set<string>()
  for (const table of article.querySelectorAll('table')) {
    const headers = [...table.querySelectorAll('tr:first-child th, tr:first-child td')].map(cell => normalizeText(cell.textContent ?? ''))
    if (!/^param(?:eter)?$/.test(headers[0] ?? '') || !/^value$/.test(headers[1] ?? '')) continue
    for (const row of [...table.querySelectorAll('tr')].slice(1)) {
      const cells = [...row.querySelectorAll('th,td')]
      if (normalizeText(cells[0]?.textContent ?? '') !== 'model') continue
      recognizedTable = true
      for (const id of safeIdsIn(cells[1]?.textContent ?? '', supportedDeepSeekId)) ids.add(id)
      break
    }
    if (recognizedTable) break
  }
  if (!recognizedTable || ids.size === 0 || ids.size > 150) throw new Error('DeepSeek first-call model table is missing, empty, or oversized')
  return [...ids].sort()
}

const parseDeepSeekFacts = (modelsHtml: string, updatesHtml: string) => {
  const { article: modelsArticle } = articleFor(modelsHtml, 'deepseek', /^your first api call$/i)
  const { article: updatesArticle } = articleFor(updatesHtml, 'deepseek', /^change log$/i)
  const ids = deepSeekModelIds(modelsArticle)
  const guideNotes = [...modelsArticle.querySelectorAll('p,li')]
    .flatMap(element => operationalSentences(element.textContent ?? '').map(normalizeText))
  const allAnnouncements = datedOperationalText(updatesArticle, 'deepseek')
  const announcements = allAnnouncements.filter(statement => announcesSupportedModel(statement, 'deepseek') || ids.some(id => hasModelMention(id, statement, 'deepseek')))
  if (announcements.length === 0 || !announcements.some(statement => /\b(?:deepseek|models?|api)\b/i.test(statement))) throw new Error('DeepSeek dated operational update statements are missing')
  const observed: CatalogModel[] = ids.map(id => ({
    provider: 'deepseek' as const,
    id,
    metadata: {
      documentedInFirstCallGuide: true,
      technicalFingerprint: sha256([
        ...new Set(guideNotes.filter(statement => hasModelMention(id, statement, 'deepseek'))),
        ...announcements.filter(statement => hasModelMention(id, statement, 'deepseek')),
      ].sort()),
    },
  }))
  return {
    observed,
    modelsFingerprint: sha256({
      ids,
      notices: [...new Set(guideNotes.filter(statement => ids.some(id => hasModelMention(id, statement, 'deepseek'))))].sort(),
    }),
    updatesFingerprint: sha256(announcements),
  }
}

export const parseGeminiPublicCatalog = (modelsHtml: string, deprecationsHtml: string, changelogHtml: string): PublicCatalogResult => {
  const facts = parseGeminiFacts(modelsHtml, deprecationsHtml, changelogHtml)
  return {
    observed: facts.observed,
    sources: [
      { provider: 'gemini', url: PUBLIC_CATALOG_URLS.geminiModels, fingerprint: facts.modelFingerprint },
      { provider: 'gemini', url: PUBLIC_CATALOG_URLS.geminiDeprecations, fingerprint: facts.lifecycleFingerprint },
      { provider: 'gemini', url: PUBLIC_CATALOG_URLS.geminiChangelog, fingerprint: facts.changelogFingerprint },
    ],
  }
}

export const parseDeepSeekPublicCatalog = (modelsHtml: string, updatesHtml: string): PublicCatalogResult => {
  const facts = parseDeepSeekFacts(modelsHtml, updatesHtml)
  return {
    observed: facts.observed,
    sources: [
      { provider: 'deepseek', url: PUBLIC_CATALOG_URLS.deepseekModels, fingerprint: facts.modelsFingerprint },
      { provider: 'deepseek', url: PUBLIC_CATALOG_URLS.deepseekUpdates, fingerprint: facts.updatesFingerprint },
    ],
  }
}

const readBoundedText = async (response: Response) => {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) throw new Error('Public documentation source exceeds size bound')
  if (!response.body) throw new Error('Public documentation source has no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_SOURCE_BYTES) {
        await reader.cancel()
        throw new Error('Public documentation source exceeds size bound')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

const fetchPage = async (fetchFn: typeof fetch, url: string) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS)
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok || response.redirected) throw new Error('Public documentation request failed')
    if (response.url) {
      const actual = new URL(response.url)
      const expected = new URL(url)
      if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.search !== expected.search) throw new Error('Unexpected public documentation URL')
    }
    return await readBoundedText(response)
  } catch {
    throw new Error('Public provider documentation discovery failed')
  } finally {
    clearTimeout(timer)
  }
}

export const discoverPublicCatalog = async (fetchFn: typeof fetch = fetch): Promise<PublicCatalogResult> => {
  const [geminiModels, geminiDeprecations, geminiChangelog, deepseekModels, deepseekUpdates] = await Promise.all([
    fetchPage(fetchFn, PUBLIC_CATALOG_URLS.geminiModels),
    fetchPage(fetchFn, PUBLIC_CATALOG_URLS.geminiDeprecations),
    fetchPage(fetchFn, PUBLIC_CATALOG_URLS.geminiChangelog),
    fetchPage(fetchFn, PUBLIC_CATALOG_URLS.deepseekModels),
    fetchPage(fetchFn, PUBLIC_CATALOG_URLS.deepseekUpdates),
  ])
  const gemini = parseGeminiPublicCatalog(geminiModels, geminiDeprecations, geminiChangelog)
  const deepseek = parseDeepSeekPublicCatalog(deepseekModels, deepseekUpdates)
  return {
    observed: [...gemini.observed, ...deepseek.observed].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)),
    sources: [...gemini.sources, ...deepseek.sources],
  }
}
