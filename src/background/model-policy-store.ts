import { BUNDLED_MODEL_POLICY, validateModelPolicy, type ModelPolicyManifest, type ModelPolicySnapshot } from '@/providers/model-policy'
import packageJson from '../../package.json'

export const MODEL_POLICY_URL = 'https://raw.githubusercontent.com/nurockplayer/tachi-lens/main/public/model-policy.json'
export const MODEL_POLICY_STORAGE_KEY = 'modelPolicyState'
export const MODEL_POLICY_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
export const MODEL_POLICY_FETCH_TIMEOUT_MS = 3 * 1000
export const MODEL_POLICY_MAX_BYTES = 32 * 1024

export interface ModelPolicyStorage {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export interface ModelPolicyStoreOptions {
  storage: ModelPolicyStorage
  fetchFn?: typeof fetch
  now?: () => number
  clientVersion?: string
}

interface PersistedPolicyState {
  manifest?: unknown
  attemptedAt?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readBodyBounded = async (response: Response): Promise<string> => {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MODEL_POLICY_MAX_BYTES) throw new Error('Policy body too large')
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MODEL_POLICY_MAX_BYTES) {
          await reader.cancel()
          throw new Error('Policy body too large')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(body)
  }
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MODEL_POLICY_MAX_BYTES) throw new Error('Policy body too large')
  return text
}

const fetchPolicyBody = async (fetchFn: typeof fetch, timeoutMs: number): Promise<string> => {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchFn(MODEL_POLICY_URL, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal })
        if (!response.ok || response.redirected || (response.url !== '' && response.url !== MODEL_POLICY_URL)) throw new Error('Untrusted policy response')
        return readBodyBounded(response)
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error('Policy request timed out'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

export class ModelPolicyStore {
  private readonly storage: ModelPolicyStorage
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly clientVersion: string
  private inFlight?: Promise<ModelPolicySnapshot>
  private lastAttemptAt?: number
  private inMemorySnapshot?: ModelPolicySnapshot

  constructor(options: ModelPolicyStoreOptions) {
    this.storage = options.storage
    this.fetchFn = options.fetchFn ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.clientVersion = options.clientVersion ?? packageJson.version
  }

  get(): Promise<ModelPolicySnapshot> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.load().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  private async load(): Promise<ModelPolicySnapshot> {
    const now = this.now()
    let state: PersistedPolicyState = {}
    try {
      const items = await this.storage.get(MODEL_POLICY_STORAGE_KEY)
      const stored = items[MODEL_POLICY_STORAGE_KEY]
      if (isRecord(stored)) state = stored as PersistedPolicyState
    } catch {
      // Storage may be unavailable during startup; the immutable bundled policy remains usable.
    }

    const cachedManifest = validateModelPolicy(state.manifest, now, this.clientVersion)
    const memoryManifest = this.inMemorySnapshot
      ? validateModelPolicy(this.inMemorySnapshot.manifest, now, this.clientVersion)
      : undefined
    let current: ModelPolicySnapshot | undefined
    if (cachedManifest) current = { manifest: cachedManifest, source: 'cached' }
    if (memoryManifest && (!current || memoryManifest.revision >= current.manifest.revision)) {
      current = { manifest: memoryManifest, source: this.inMemorySnapshot!.source }
    }
    if (current) this.inMemorySnapshot = current

    const persistedAttempt = this.validAttemptAt(state.attemptedAt, now) ? state.attemptedAt : undefined
    const memoryAttempt = this.validAttemptAt(this.lastAttemptAt, now) ? this.lastAttemptAt : undefined
    const attempts = [persistedAttempt, memoryAttempt].filter((value): value is number => value !== undefined)
    const attemptedAt = attempts.length > 0 ? Math.max(...attempts) : undefined
    const refreshDue = attemptedAt === undefined || now - attemptedAt >= MODEL_POLICY_REFRESH_INTERVAL_MS
    if (refreshDue) {
      const result = await this.refresh(state, current)
      if (result) return result
    }
    const completionNow = this.now()
    const stillCurrent = current && validateModelPolicy(current.manifest, completionNow, this.clientVersion)
    if (current && stillCurrent) {
      this.inMemorySnapshot = { manifest: stillCurrent, source: current.source }
      return this.inMemorySnapshot
    }
    this.inMemorySnapshot = { manifest: BUNDLED_MODEL_POLICY, source: 'bundled' }
    return this.inMemorySnapshot
  }

  private validAttemptAt(value: unknown, now: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= now
  }

  private async refresh(oldState: PersistedPolicyState, previous?: ModelPolicySnapshot): Promise<ModelPolicySnapshot | undefined> {
    let manifest: ModelPolicyManifest | undefined
    try {
      const body = await fetchPolicyBody(this.fetchFn, MODEL_POLICY_FETCH_TIMEOUT_MS)
      let value: unknown
      try {
        value = JSON.parse(body)
      } catch {
        throw new Error('Invalid policy JSON')
      }
      const completedAt = this.now()
      manifest = validateModelPolicy(value, completedAt, this.clientVersion)
      if (!manifest) throw new Error('Invalid model policy')
      const currentAtCompletion = previous
        ? validateModelPolicy(previous.manifest, completedAt, this.clientVersion)
        : undefined
      if (currentAtCompletion && manifest.revision < currentAtCompletion.revision) {
        manifest = undefined
        throw new Error('Model policy revision is older than the current policy')
      }
    } catch {
      // Keep the prior validated policy and record a backoff attempt below.
    }

    const attemptedAt = this.now()
    this.lastAttemptAt = attemptedAt
    const priorManifest = previous
      ? validateModelPolicy(previous.manifest, attemptedAt, this.clientVersion)
      : undefined
    const accepted = manifest ? { manifest, source: 'remote' as const } : undefined
    const retained = accepted ?? (priorManifest && previous ? { manifest: priorManifest, source: previous.source } : undefined)
    const nextState: PersistedPolicyState = {
      ...(retained ? { manifest: retained.manifest } : isRecord(oldState) && oldState.manifest !== undefined ? { manifest: oldState.manifest } : {}),
      attemptedAt,
    }
    try {
      await this.storage.set({ [MODEL_POLICY_STORAGE_KEY]: nextState })
    } catch {
      // Failure to persist never prevents this session from using its valid response or fallback.
    }
    if (retained) this.inMemorySnapshot = retained
    return accepted
  }
}
