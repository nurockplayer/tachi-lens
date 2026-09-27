import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { validateModelPolicy, type ModelPolicyManifest } from '../../src/providers/model-policy'
import { normalizeCatalog, compareCatalogs, type CatalogModel } from '../../src/providers/model-catalog'
import { createGeminiProvider } from '../../src/providers/gemini'
import { createDeepSeekProvider } from '../../src/providers/deepseek'
import { createGeminiSpeechProvider } from '../../src/providers/speech-gemini'
import packageMetadata from '../../package.json'

const mode = process.argv[2] ?? 'check'
const policyPath = process.argv[3] ?? 'public/model-policy.json'
const policy = validateModelPolicy(JSON.parse(await readFile(policyPath, 'utf8')), Date.now(), packageMetadata.version, mode === 'check' || mode === 'discover')
if (!policy) throw new Error('Policy schema, validity, or client compatibility check failed')
if (mode === 'check') {
  console.log(`Validated policy revision ${policy.revision}; schema ${policy.schemaVersion}`)
} else {
  const keys = {
    gemini: process.env.MODEL_MONITOR_GEMINI_API_KEY,
    deepseek: process.env.MODEL_MONITOR_DEEPSEEK_API_KEY,
  }
  if (!keys.gemini || !keys.deepseek) throw new Error('Dedicated Gemini and DeepSeek monitor secrets are required')
  // Never propagate provider errors, headers, request payloads, or keys to output.
  const boundedFetch: typeof fetch = async (input, init) => {
    const requestSignal = init?.signal
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (requestSignal?.aborted) abort()
    else requestSignal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 15_000)
    try {
      const response = await fetch(input, { ...init, redirect: 'error', signal: controller.signal })
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 1_048_576) {
              await reader.cancel()
              throw new Error('Oversized provider response')
            }
            chunks.push(value)
          }
        } finally {
          reader.releaseLock()
        }
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return new Response(bytes.length > 0 ? bytes : null, { status: response.status, statusText: response.statusText, headers: response.headers })
    } finally {
      clearTimeout(timer)
      requestSignal?.removeEventListener('abort', abort)
    }
  }
  if (mode === 'discover') {
    const models: unknown[] = []
    let token: string | undefined
    const seenTokens = new Set<string>()
    for (let page = 0; page < 10; page++) {
      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models')
      url.searchParams.set('pageSize', '1000')
      if (token) url.searchParams.set('pageToken', token)
      const response = await boundedFetch(url, { headers: { 'x-goog-api-key': keys.gemini } })
      if (!response.ok) throw new Error(`Gemini discovery failed (${response.status})`)
      const body = await response.json() as { models?: unknown[]; nextPageToken?: unknown }
      // Individual pages may contain only embedding models; normalize after pagination.
      if (!Array.isArray(body.models)) throw new Error('Invalid Gemini discovery response')
      models.push(...body.models)
      if (models.length > 1000) throw new Error('Oversized Gemini catalog')
      if (body.nextPageToken === undefined) break
      if (typeof body.nextPageToken !== 'string' || body.nextPageToken.length > 1024 || seenTokens.has(body.nextPageToken) || page === 9) throw new Error('Invalid Gemini pagination')
      token = body.nextPageToken
      seenTokens.add(token)
    }
    const gemini = normalizeCatalog('gemini', { models })
    const response = await boundedFetch('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${keys.deepseek}` } })
    if (!response.ok) throw new Error(`DeepSeek discovery failed (${response.status})`)
    const observed = [...gemini, ...normalizeCatalog('deepseek', await response.json())]
    let previous: CatalogModel[] = []
    try { previous = JSON.parse(await readFile('model-catalog-previous.json', 'utf8')) } catch { /* Initial bootstrap. */ }
    const changes = compareCatalogs(previous, observed)
    const unavailable = policy.policies.flatMap(entry => [entry.recommended, ...entry.fallbacks].filter(id => !observed.some(model => model.provider === entry.provider && model.id === id)).map(model => ({ kind: 'unavailable', provider: entry.provider, model })))
    const fingerprint = createHash('sha256').update(JSON.stringify(observed)).digest('hex')
    await writeFile('model-drift-report.json', JSON.stringify({ fingerprint, observed, changes: [...changes, ...unavailable, ...(Date.parse(policy.expiresAt) - Date.now() < 7 * 86400000 ? [{ kind: 'renew-policy', provider: 'all', model: `revision-${policy.revision}` }] : [])], policyRevision: policy.revision, checkedAt: new Date().toISOString() }, null, 2))
    console.log(`Catalog observation ${fingerprint}; ${changes.length} catalog changes`)
  } else if (mode === 'probe') {
    await probePolicy(policy, boundedFetch, keys as { gemini: string; deepseek: string })
  } else throw new Error('Unknown model-policy command')
}

async function probePolicy(manifest: ModelPolicyManifest, fetchFn: typeof fetch, keys: { gemini: string; deepseek: string }) {
  const results: Array<{ provider: string; workload: string; model: string; configuration: string; latencyMs: number; pass: boolean }> = []
  const audioPath = process.env.SPEECH_PROBE_WAV
  if (!audioPath) throw new Error('Synthetic speech WAV fixture is required')
  const wav = await readFile(audioPath)
  // ffmpeg supplies a WAV; walk chunks rather than assuming a 44-byte header.
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid synthetic WAV')
  let pcm: Buffer | undefined
  let validFormat = false
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const dataOffset = offset + 8
    if (dataOffset + size > wav.length) throw new Error('Truncated synthetic WAV')
    if (name === 'fmt ' && size >= 16) validFormat = wav.readUInt16LE(dataOffset) === 1 && wav.readUInt16LE(dataOffset + 2) === 1 && wav.readUInt32LE(dataOffset + 4) === 16000 && wav.readUInt16LE(dataOffset + 14) === 16
    if (name === 'data') pcm = wav.subarray(dataOffset, dataOffset + size)
    offset = dataOffset + size + size % 2
  }
  if (!validFormat || !pcm || pcm.length === 0 || pcm.length > 320000) throw new Error('Synthetic audio must be bounded 16kHz mono 16-bit PCM')
  for (const entry of manifest.policies) {
    // Every remotely selectable model/configuration is part of the promotion contract.
    for (const model of entry.models) {
      const start = performance.now()
      let pass = false
      try {
        if (entry.workload === 'chat') {
          const provider = entry.provider === 'gemini' ? createGeminiProvider(fetchFn) : createDeepSeekProvider(fetchFn)
          const translated = await provider.translateBatch([{ id: 'synthetic-compatibility', text: 'Hello friends, enjoy the stream!' }], keys[entry.provider], model.id, 'ja', undefined, model.configuration)
          pass = translated.length === 1 && translated[0]?.id === 'synthetic-compatibility' && typeof translated[0].translatedText === 'string' && translated[0].translatedText.trim().length > 0 && !translated[0].error
        } else {
          const provider = createGeminiSpeechProvider(fetchFn)
          const buffer = new Uint8Array(pcm).buffer
          const translated = await provider.transcribeChunk({ chunkId: 'synthetic-audio-compatibility', data: buffer, mimeType: 'audio/pcm;rate=16000', isFinal: true }, keys.gemini, model.id, 'ja', undefined, model.configuration)
          pass = translated.length === 1 && !translated[0]?.error && Boolean(translated[0]?.text.trim()) && Boolean(translated[0]?.translatedText?.trim())
        }
      } catch { /* Only bounded pass/fail metadata leaves the probe. */ }
      const latencyMs = Math.round(performance.now() - start)
      results.push({ provider: entry.provider, workload: entry.workload, model: model.id, configuration: model.configuration, latencyMs, pass: pass && latencyMs <= 15000 })
    }
  }
  await writeFile('model-compatibility-report.json', JSON.stringify({ policyRevision: manifest.revision, policySha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), checkedAt: new Date().toISOString(), results }, null, 2))
  console.log(JSON.stringify(results))
  if (results.some(result => !result.pass)) throw new Error('Model compatibility probe failed; do not promote')
}
