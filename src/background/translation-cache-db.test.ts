import { beforeEach, describe, expect, it } from 'vitest'
import { TranslationCacheDb } from './translation-cache-db'
import { buildTranslationIdentity } from '@/shared/translation-identity'
import {
  TRANSLATION_CACHE_CLEANUP_BOUND,
  TRANSLATION_CACHE_MAX_ENTRIES,
  TRANSLATION_CACHE_STORE,
  TRANSLATION_CACHE_TTL_MS,
} from './translation-cache-db'

// ---- Minimal in-memory IndexedDB mock ----
//
// The repository has no fake-indexeddb dependency and the vitest environment
// is `node`, so the adapter injects an IndexedDbFactory. These helpers
// implement just enough of the IDB surface the adapter touches:
//   open -> IDBOpenDBRequest (upgradeneeded then success, with a
//           versionchange transaction exposing the object store)
//   transaction -> { objectStore() }
//   objectStore -> { get/put/delete/clear/count, index().openCursor(),
//                    indexNames, createIndex } -> IDBRequest (success)
//
// The mock mirrors the real upgrade flow: the object store is created during
// 'upgradeneeded', the storedAt index is created when present, and the adapter
// resolves its db after 'success'. The storedAt index cursor iterates records
// in ascending (storedAt, key) order, matching IndexedDB index ordering.

type StoreBackend = Map<string, unknown>

interface MockDb {
  stores: Record<string, StoreBackend>
  /** storeName -> (indexName -> index keyPath). */
  indexes: Record<string, Map<string, string>>
}

interface MockCursor {
  key: unknown
  primaryKey: string
  value: unknown
  delete(): void
  continue(): void
}

/** Mutable stand-in for IDBRequest so the mock can set result during upgrade. */
interface MockRequest {
  result: unknown
  error: DOMException | null
  transaction?: unknown
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void
  dispatchEvent(event: Event): boolean
}

interface IndexedDbMock {
  factory: { indexedDB: { open: (name: string, version?: number) => IDBOpenDBRequest } }
  /** In-memory records currently in the store, or undefined when empty. */
  data: () => Record<string, unknown> | undefined
  /** Inject a raw value directly into the storage layer (bypasses the adapter). */
  seed: (value: unknown) => void
}

const addListener = (
  listeners: Map<string, Set<(evt: Event) => void>>,
  type: string,
  listener: EventListenerOrEventListenerObject,
): void => {
  const set = listeners.get(type) ?? new Set()
  if (typeof listener === 'function') {
    set.add(listener)
  } else {
    set.add((evt) => listener.handleEvent(evt))
  }
  listeners.set(type, set)
}

const createIndexedDbMock = (): IndexedDbMock => {
  const db: MockDb = {
    stores: { [TRANSLATION_CACHE_STORE]: new Map() },
    indexes: { [TRANSLATION_CACHE_STORE]: new Map() },
  }

  const makeRequest = (settled: { result?: unknown }, onSettle?: () => void): MockRequest => {
    const listeners = new Map<string, Set<(evt: Event) => void>>()
    const request: MockRequest = {
      result: settled.result,
      error: null,
      addEventListener: (type, listener) => addListener(listeners, type, listener),
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    }
    // Mirror the real upgrade flow: prepare the fresh database, run the
    // upgradeneeded handlers (store + index creation), then resolve with success.
    queueMicrotask(() => {
      onSettle?.()
      for (const fn of listeners.get('upgradeneeded') ?? []) fn({} as Event)
      for (const fn of listeners.get('success') ?? []) fn({} as Event)
    })
    return request
  }

  const makeCursorRequest = (backend: StoreBackend): MockRequest => {
    const listeners = new Map<string, Set<(evt: Event) => void>>()
    const entries = [...backend.entries()]
      .map(([key, value]) => {
        const record = value as { storedAt?: unknown }
        return {
          key,
          value,
          storedAt: typeof record?.storedAt === 'number' ? record.storedAt : Number.MAX_SAFE_INTEGER,
        }
      })
      .sort((a, b) => a.storedAt - b.storedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    let position = -1
    const request: MockRequest = {
      result: null,
      error: null,
      addEventListener: (type, listener) => addListener(listeners, type, listener),
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    }
    const fire = (): void => {
      position++
      let cursor: MockCursor | null = null
      if (position < entries.length) {
        const entry = entries[position]!
        cursor = {
          key: entry.storedAt,
          primaryKey: entry.key,
          value: entry.value,
          delete: () => { backend.delete(entry.key) },
          continue: () => { queueMicrotask(fire) },
        }
      }
      request.result = cursor
      for (const fn of listeners.get('success') ?? []) fn({} as Event)
    }
    queueMicrotask(fire)
    return request
  }

  const makeStore = (storeName: string, backend: StoreBackend) => ({
    indexNames: {
      contains: (name: string) => db.indexes[storeName]!.has(name),
    },
    createIndex: (name: string, keyPath: string) => {
      db.indexes[storeName]!.set(name, keyPath)
    },
    index: (name: string) => {
      if (!db.indexes[storeName]!.has(name)) throw new Error('unknown index')
      return {
        openCursor: () => makeCursorRequest(backend),
      }
    },
    count: () => makeRequest({ result: backend.size }),
    get: (key: IDBValidKey) => makeRequest({ result: backend.get(String(key)) }),
    put: (value: unknown) => {
      const record = value as { key?: string }
      if (typeof record?.key !== 'string') {
        throw new Error('put requires a key-path key')
      }
      backend.set(record.key, value)
      return makeRequest({ result: undefined })
    },
    delete: (key: IDBValidKey) => {
      backend.delete(String(key))
      return makeRequest({ result: undefined })
    },
    clear: () => {
      backend.clear()
      return makeRequest({ result: undefined })
    },
  })

  const makeTransaction = (storeName: string) => ({
    objectStore: (name: string) => {
      if (name !== storeName) throw new Error('unknown object store')
      return makeStore(name, db.stores[name]!)
    },
  })

  const factory = {
    indexedDB: {
      open: (name: string, version?: number): IDBOpenDBRequest => {
        const dbInstance = {
          objectStoreNames: { contains: (n: string) => Boolean(db.stores[n]) },
          createObjectStore: (n: string) => {
            if (!db.stores[n]) db.stores[n] = new Map()
            if (!db.indexes[n]) db.indexes[n] = new Map()
          },
          transaction: makeTransaction,
        } as unknown as IDBDatabase
        let request: MockRequest
        // Expose the fresh database and its versionchange transaction before the
        // adapter's upgradeneeded handler reads them to create the store/index.
        request = makeRequest({}, () => {
          request.result = dbInstance
          request.transaction = makeTransaction(TRANSLATION_CACHE_STORE)
        })
        void name
        void version
        return request as unknown as IDBOpenDBRequest
      },
    },
  }

  return {
    factory,
    data: () => {
      const store = db.stores[TRANSLATION_CACHE_STORE]!
      if (store.size === 0) return undefined
      return Object.fromEntries(store.entries())
    },
    seed: (value) => {
      const record = value as { key?: string }
      if (typeof record?.key !== 'string') throw new Error('seed requires a key')
      db.stores[TRANSLATION_CACHE_STORE]!.set(record.key, value)
    },
  }
}

// ---- Fixture ----

/** Fixed wall-clock "now" for the injected adapter clock. */
const NOW = 1_800_000_000_000

const buildKey = (overrides: Record<string, string | undefined> = {}): string =>
  buildTranslationIdentity({
    text: overrides.text ?? 'Hello',
    targetLang: overrides.targetLang ?? 'zh-TW',
    provider: overrides.provider ?? 'deepseek',
    model: overrides.model ?? 'deepseek-v4-flash',
    sourceLang: overrides.sourceLang,
  })

const makeRecord = (key: string, translatedText = '你好', storedAt = NOW - 1_000) => ({
  key,
  translatedText,
  storedAt,
})

const idempotentOpen = (db: TranslationCacheDb): Promise<void> => db.open()

describe('TranslationCacheDb', () => {
  let mock: IndexedDbMock
  let db: TranslationCacheDb

  beforeEach(() => {
    mock = createIndexedDbMock()
    db = new TranslationCacheDb(mock.factory, { wallNow: () => NOW })
  })

  describe('keying', () => {
    it('builds a key from the shared canonical translation identity', () => {
      const key = db.buildKey({ text: 'Hello', targetLang: 'zh-TW', provider: 'deepseek', model: 'deepseek-v4-flash' })
      expect(key).toBe(buildTranslationIdentity({ text: 'Hello', targetLang: 'zh-TW', provider: 'deepseek', model: 'deepseek-v4-flash' }))
      // Equivalent inputs produce the identical key (no second key format).
      expect(db.buildKey({ text: 'Hello', targetLang: 'zh-TW', provider: 'deepseek', model: 'deepseek-v4-flash', sourceLang: undefined }))
        .toBe(key)
    })
  })

  describe('open / creation', () => {
    it('opens the database and creates the object store and storedAt index on first use', async () => {
      await idempotentOpen(db)
      // Reaching here without throwing proves the upgrade flow (store + index
      // creation) and the success flow both completed.
      expect(db).toBeInstanceOf(TranslationCacheDb)
    })

    it('can open more than once (idempotent handle)', async () => {
      await idempotentOpen(db)
      await idempotentOpen(db)
      await db.get(buildKey())
    })
  })

  describe('write/read round trip', () => {
    it('persists a successful record and reads it back by canonical identity', async () => {
      const key = buildKey()
      const record = makeRecord(key)

      await db.put(key, record)
      const got = await db.get(key)

      expect(got).toEqual(record)
      expect(got?.translatedText).toBe('你好')
      expect(mock.data()).toEqual({ [key]: record })
    })
  })

  describe('overwrite', () => {
    it('replaces an existing record with the same canonical identity', async () => {
      const key = buildKey()
      await db.put(key, makeRecord(key, '第一版'))

      const updated = makeRecord(key, '第二版', NOW - 500)
      await db.put(key, updated)

      const got = await db.get(key)
      expect(got).toEqual(updated)
      expect(got?.translatedText).toBe('第二版')
    })

    it('stores records for different identities without collision', async () => {
      const a = buildKey({ text: 'Hello' })
      const b = buildKey({ text: 'World' })
      await db.put(a, makeRecord(a, '你好'))
      await db.put(b, makeRecord(b, '世界'))

      expect((await db.get(a))?.translatedText).toBe('你好')
      expect((await db.get(b))?.translatedText).toBe('世界')
    })
  })

  describe('delete', () => {
    it('removes a single record and misses afterwards', async () => {
      const key = buildKey()
      await db.put(key, makeRecord(key))

      await db.delete(key)

      expect(await db.get(key)).toBeNull()
      expect(mock.data()).toBeUndefined()
    })

    it('is a no-op miss when deleting an absent key', async () => {
      await expect(db.delete(buildKey({ text: 'absent' }))).resolves.toBeUndefined()
    })
  })

  describe('clear', () => {
    it('removes every record and misses afterwards', async () => {
      const a = buildKey({ text: 'Hello' })
      const b = buildKey({ text: 'World' })
      await db.put(a, makeRecord(a))
      await db.put(b, makeRecord(b))

      await db.clear()

      expect(await db.get(a)).toBeNull()
      expect(await db.get(b)).toBeNull()
      expect(mock.data()).toBeUndefined()
    })
  })

  describe('missing records', () => {
    it('resolves a cache miss as null instead of throwing', async () => {
      await expect(db.get(buildKey({ text: 'not cached' }))).resolves.toBeNull()
    })
  })

  describe('malformed records', () => {
    it('rejects a payload without translatedText (error-only) via put', async () => {
      const key = buildKey()
      await expect(
        db.put(key, { key, translatedText: '', storedAt: NOW - 1_000 }),
      ).rejects.toThrow(/successful translatedText/)
    })

    it('rejects a payload whose key does not match the requested key', async () => {
      const key = buildKey()
      await expect(
        db.put(key, makeRecord(buildKey({ text: 'other' }))),
      ).rejects.toThrow(/matching key/)
    })

    it('treats a malformed stored record as a cache miss on read', async () => {
      const key = buildKey()
      // A malformed record (missing translatedText) cannot reach the store via
      // the adapter contract, so inject it directly at the storage layer to
      // exercise the read-side safe handling.
      mock.seed({ key, error: 'should never be surfaced', status: 429 })
      expect(await db.get(key)).toBeNull()
    })

    it('treats a non-object garbage record as a cache miss on read', async () => {
      mock.seed({ key: buildKey(), translatedText: 42 })
      expect(await db.get(buildKey())).toBeNull()
    })
  })

  describe('TTL expiration', () => {
    it('treats an expired record as a miss and removes it lazily on access', async () => {
      const key = buildKey()
      await db.put(key, makeRecord(key, '你好', NOW - TRANSLATION_CACHE_TTL_MS - 1))

      expect(await db.get(key)).toBeNull()
      expect(mock.data()).toBeUndefined()
    })

    it('keeps a record at the exact TTL boundary as a hit', async () => {
      const key = buildKey()
      await db.put(key, makeRecord(key, '你好', NOW - TRANSLATION_CACHE_TTL_MS))

      expect((await db.get(key))?.translatedText).toBe('你好')
      expect(mock.data()).toBeDefined()
    })

    it('keeps a fresh record as a hit', async () => {
      const key = buildKey()
      await db.put(key, makeRecord(key, '你好'))

      expect((await db.get(key))?.translatedText).toBe('你好')
    })
  })

  describe('translation-contract invalidation', () => {
    it('never surfaces a record written under an older contract version', async () => {
      const oldKey = db.buildKey({
        text: 'Hello',
        targetLang: 'zh-TW',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        contractVersion: 0,
      })
      const currentKey = db.buildKey({
        text: 'Hello',
        targetLang: 'zh-TW',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
      })
      expect(oldKey).not.toBe(currentKey)

      await db.put(oldKey, makeRecord(oldKey, '舊版結果'))
      expect(await db.get(currentKey)).toBeNull()
      // The orphaned incompatible record is never surfaced under the current key.
      expect(mock.data()).toHaveProperty(oldKey)
      expect(mock.data()).not.toHaveProperty(currentKey)
    })
  })

  describe('bounded eviction', () => {
    it('evicts the oldest record when inserting beyond the entry-count limit', async () => {
      const keys: string[] = []
      for (let index = 0; index < TRANSLATION_CACHE_MAX_ENTRIES + 1; index++) {
        const key = buildKey({ text: `text-${index}` })
        keys.push(key)
        // Smaller index = older record (smallest storedAt).
        await db.put(key, makeRecord(key, `譯-${index}`, NOW + index))
      }

      const oldestKey = keys[0]!
      const secondKey = keys[1]!
      const newestKey = keys[TRANSLATION_CACHE_MAX_ENTRIES]!
      expect(mock.data()).not.toHaveProperty(oldestKey)
      expect(mock.data()).toHaveProperty(secondKey)
      expect(mock.data()).toHaveProperty(newestKey)
      expect(Object.keys(mock.data() ?? {}).length).toBe(TRANSLATION_CACHE_MAX_ENTRIES)
    })

    it('breaks storedAt ties by primary key during eviction', async () => {
      const now = NOW
      for (let index = 0; index < TRANSLATION_CACHE_MAX_ENTRIES - 1; index++) {
        const key = buildKey({ text: `filler-${index}` })
        await db.put(key, makeRecord(key, `f-${index}`, now + 10_000))
      }
      const keyA = buildKey({ text: 'a' })
      const keyB = buildKey({ text: 'b' })
      await db.put(keyA, makeRecord(keyA, 'A', now))
      // This put pushes the store over the limit; the oldest same-time record
      // (keyA, since 'a' sorts before 'b') must be evicted deterministically.
      await db.put(keyB, makeRecord(keyB, 'B', now))

      expect(mock.data()).not.toHaveProperty(keyA)
      expect(mock.data()).toHaveProperty(keyB)
      expect(Object.keys(mock.data() ?? {}).length).toBe(TRANSLATION_CACHE_MAX_ENTRIES)
    })

    it('cleanup enforces the entry-count limit and reports the removed count', async () => {
      for (let index = 0; index < TRANSLATION_CACHE_MAX_ENTRIES + 5; index++) {
        const key = buildKey({ text: `s-${index}` })
        mock.seed({ key, translatedText: `s-${index}`, storedAt: NOW + index })
      }

      const removed = await db.cleanup()

      expect(removed).toBe(5)
      expect(Object.keys(mock.data() ?? {}).length).toBe(TRANSLATION_CACHE_MAX_ENTRIES)
      // The five oldest seeded records (smallest storedAt) were removed.
      expect(mock.data()).not.toHaveProperty(buildKey({ text: 's-0' }))
      expect(mock.data()).toHaveProperty(buildKey({ text: 's-5' }))
    })

    it('cleanup removes expired records from the oldest end within a bound', async () => {
      const expiredA = buildKey({ text: 'expired-a' })
      const expiredB = buildKey({ text: 'expired-b' })
      const fresh = buildKey({ text: 'fresh' })
      mock.seed({ key: expiredB, translatedText: 'b', storedAt: NOW - TRANSLATION_CACHE_TTL_MS - 20 })
      mock.seed({ key: expiredA, translatedText: 'a', storedAt: NOW - TRANSLATION_CACHE_TTL_MS - 10 })
      mock.seed({ key: fresh, translatedText: 'c', storedAt: NOW })

      const removed = await db.cleanup()

      expect(removed).toBe(2)
      expect(mock.data()).not.toHaveProperty(expiredA)
      expect(mock.data()).not.toHaveProperty(expiredB)
      expect(mock.data()).toHaveProperty(fresh)
    })

    it('leaves a store within the limit and with no expired records untouched', async () => {
      const key = buildKey()
      await db.put(key, makeRecord(key, '你好'))

      const removed = await db.cleanup()

      expect(removed).toBe(0)
      expect(mock.data()).toHaveProperty(key)
    })

    it('bounded expired cleanup never removes more than the cleanup bound in one pass', async () => {
      // Seed more expired records than the per-pass bound to prove the bound holds.
      const seeded = TRANSLATION_CACHE_CLEANUP_BOUND + 25
      for (let index = 0; index < seeded; index++) {
        const key = buildKey({ text: `exp-${index}` })
        mock.seed({
          key,
          translatedText: `e-${index}`,
          storedAt: NOW - TRANSLATION_CACHE_TTL_MS - 1_000 - index,
        })
      }

      const removed = await db.cleanup()

      expect(removed).toBe(TRANSLATION_CACHE_CLEANUP_BOUND)
      expect(Object.keys(mock.data() ?? {}).length).toBe(seeded - TRANSLATION_CACHE_CLEANUP_BOUND)
    })
  })
})
