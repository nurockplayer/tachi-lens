import { beforeEach, describe, expect, it } from 'vitest'
import { TranslationCacheDb } from './translation-cache-db'
import { buildTranslationIdentity } from '@/shared/translation-identity'

// ---- Minimal in-memory IndexedDB mock ----
//
// The repository has no fake-indexeddb dependency and the vitest environment
// is `node`, so the adapter injects an IndexedDbFactory. These helpers
// implement just enough of the IDB surface the adapter touches:
//   open -> IDBOpenDBRequest (upgradeneeded then success)
//   transaction -> { objectStore() }
//   objectStore -> { get/put/delete/clear } -> IDBRequest (success)
//
// The mock mirrors the real upgrade flow: the object store is created during
// 'upgradeneeded' and the adapter resolves its db after 'success'.

type StoreBackend = Map<string, unknown>

interface MockDb {
  stores: Record<string, StoreBackend>
}

/** Mutable stand-in for IDBRequest so the mock can set result during upgrade. */
interface MockRequest {
  result: unknown
  error: DOMException | null
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

const createIndexedDbMock = (): IndexedDbMock => {
  const db: MockDb = { stores: { translations: new Map() } }

  const makeStore = (backend: StoreBackend) => ({
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
      return makeStore(db.stores[storeName]!)
    },
  })

  const makeRequest = (settled: { result?: unknown }, onUpgrade?: () => void): MockRequest => {
    const listeners = new Map<string, Set<(evt: Event) => void>>()
    const request: MockRequest = {
      result: settled.result,
      error: null,
      addEventListener: (type, listener) => {
        const set = listeners.get(type) ?? new Set()
        if (typeof listener === 'function') {
          set.add(listener)
        } else {
          set.add((evt) => listener.handleEvent(evt))
        }
        listeners.set(type, set)
      },
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    }
    // Mirror the real upgrade flow: prepare the fresh database, run the
    // upgradeneeded handlers (store creation), then resolve with success.
    queueMicrotask(() => {
      onUpgrade?.()
      for (const fn of listeners.get('upgradeneeded') ?? []) fn({} as Event)
      for (const fn of listeners.get('success') ?? []) fn({} as Event)
    })
    return request
  }

  const factory = {
    indexedDB: {
      open: (name: string, version?: number): IDBOpenDBRequest => {
        const dbInstance = {
          objectStoreNames: { contains: (n: string) => Boolean(db.stores[n]) },
          createObjectStore: (n: string) => {
            if (!db.stores[n]) db.stores[n] = new Map()
          },
          transaction: makeTransaction,
        } as unknown as IDBDatabase
        let request: MockRequest
        // Expose the fresh database to request.result before the adapter's
        // upgradeneeded handler reads it to create the object store.
        request = makeRequest({}, () => {
          request.result = dbInstance
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
      const store = db.stores.translations
      if (store === undefined || store.size === 0) return undefined
      return Object.fromEntries(store.entries())
    },
    seed: (value) => {
      const record = value as { key?: string }
      if (typeof record?.key !== 'string') throw new Error('seed requires a key')
      db.stores.translations!.set(record.key, value)
    },
  }
}

// ---- Fixture ----

const buildKey = (overrides: Record<string, string | undefined> = {}): string =>
  buildTranslationIdentity({
    text: overrides.text ?? 'Hello',
    targetLang: overrides.targetLang ?? 'zh-TW',
    provider: overrides.provider ?? 'deepseek',
    model: overrides.model ?? 'deepseek-v4-flash',
    sourceLang: overrides.sourceLang,
  })

const makeRecord = (key: string, translatedText = '你好', storedAt = 1700000000000) => ({
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
    db = new TranslationCacheDb(mock.factory)
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
    it('opens the database and creates the object store on first use', async () => {
      await idempotentOpen(db)
      // Reaching here without throwing proves the upgrade flow (store creation)
      // and the success flow both completed.
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

      const updated = makeRecord(key, '第二版', 1700000001000)
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
        db.put(key, { key, translatedText: '', storedAt: 1700000000000 }),
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
})
