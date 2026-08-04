// Versioned IndexedDB translation-cache adapter.
//
// This is the persistent-storage primitive behind the translation cache (#44).
// It deliberately knows nothing about the Translator request flow: this module
// only owns a small, versioned IndexedDB object store keyed by the canonical
// translation identity (#54), plus the persistent-cache lifetime and
// storage-bound policy for that store (TTL, bounded deterministic eviction,
// and translation-contract invalidation, #103).
//
// Only successful translation payloads may be persisted. A record without a
// translatedText is treated as a cache miss so the read side never surfaces a
// failed provider attempt as if it were a cached result.
//
// IndexedDB is only reachable in trusted extension contexts (the Service
// Worker); content scripts and the popup never touch this module.

import { buildTranslationIdentity } from '@/shared/translation-identity'
import type { TranslationIdentityInput } from '@/shared/translation-identity'
import { createSystemClock, type Clock } from './clock'

/** IndexedDB database name for the persistent translation cache. */
export const TRANSLATION_CACHE_DB_NAME = 'tachi-lens-translation-cache' as const

/**
 * Database + record schema version. Bump when the record shape or lookup
 * semantics change in a way that requires recreating the object store.
 * This is independent of TRANSLATION_CONTRACT_VERSION, which is embedded in
 * each canonical translation identity and invalidates results on its own.
 *
 * v2 adds the `storedAt` index so eviction can walk records in deterministic
 * oldest-first order (ties broken by primary key) without loading the store.
 */
export const TRANSLATION_CACHE_DB_VERSION = 2 as const

/** Name of the object store holding translation-cache records. */
export const TRANSLATION_CACHE_STORE = 'translations' as const

/** Name of the index ordering records by persisted time (for eviction). */
export const TRANSLATION_CACHE_STORED_AT_INDEX = 'storedAt' as const

/**
 * Lifetime of a successful persistent translation record. Expired records are
 * treated as a cache miss on access and removed lazily, and are evicted from
 * the oldest end by the bounded cleanup path.
 */
export const TRANSLATION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Finite entry-count budget for the persistent store. Inserting beyond this
 * limit evicts the oldest records (by `storedAt`, then by key) until the
 * store is back within budget.
 */
export const TRANSLATION_CACHE_MAX_ENTRIES = 500

/**
 * Upper bound on expired records removed by a single cleanup pass, so cleanup
 * work never scans or loads the whole store. Remaining expired records are
 * removed on a later access or by a later cleanup pass.
 */
export const TRANSLATION_CACHE_CLEANUP_BOUND = 50

/**
 * A translation result that succeeded and is safe to persist. The canonical
 * identity is the record's primary key; the stored value is only the minimal
 * successful payload plus the metadata needed for later TTL/invalidation.
 */
export interface TranslationCacheRecord {
  key: string
  /** Persisted when the provider returned a successful translation. */
  translatedText: string
  /** Unix epoch milliseconds at write time (for future TTL/invalidation). */
  storedAt: number
}

/**
 * The minimal subset of the IDB API this adapter depends on, so tests can
 * inject a small in-memory implementation without adding fake-indexeddb.
 */
export interface IndexedDbFactory {
  readonly indexedDB: {
    open(name: string, version?: number): IDBOpenDBRequest
  }
}

const globalIndexedDbFactory: IndexedDbFactory = {
  indexedDB: globalThis.indexedDB,
}

/**
 * Versioned IndexedDB translation-cache adapter.
 *
 * Owns open/get/put/delete/clear primitives keyed by the shared canonical
 * translation identity, plus the persistent-cache policy for that store:
 * expired records are never returned, records written under an older
 * translation contract version are never surfaced, and the store is kept
 * within a finite entry-count budget via deterministic oldest-first eviction.
 * Missing or malformed records resolve to `null` (a normal cache miss)
 * instead of throwing.
 */
export class TranslationCacheDb {
  private readonly factory: IndexedDbFactory
  private readonly clock: Pick<Clock, 'wallNow'>
  private db: IDBDatabase | null = null
  private openPromise: Promise<IDBDatabase> | null = null

  constructor(
    factory: IndexedDbFactory = globalIndexedDbFactory,
    clock: Pick<Clock, 'wallNow'> = createSystemClock(),
  ) {
    this.factory = factory
    this.clock = clock
  }

  /**
   * Build the canonical cache key for a translation request, delegating to
   * the shared translation identity so persistent and in-memory layers
   * always agree on equivalence. The embedded translation-contract version
   * makes a contract change produce a different key, so records written under
   * an older contract version can never be returned as hits.
   */
  buildKey(input: TranslationIdentityInput): string {
    return buildTranslationIdentity(input)
  }

  /** Resolve the open database, opening it on first use. */
  private async getDb(): Promise<IDBDatabase> {
    if (this.db) return this.db
    if (this.openPromise) return this.openPromise

    this.openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.indexedDB.open(
        TRANSLATION_CACHE_DB_NAME,
        TRANSLATION_CACHE_DB_VERSION,
      )

      request.addEventListener('upgradeneeded', () => {
        const db = request.result
        const transaction = request.transaction
        if (!db.objectStoreNames.contains(TRANSLATION_CACHE_STORE)) {
          db.createObjectStore(TRANSLATION_CACHE_STORE, { keyPath: 'key' })
        }
        const store = transaction?.objectStore(TRANSLATION_CACHE_STORE)
        if (store && !store.indexNames.contains(TRANSLATION_CACHE_STORED_AT_INDEX)) {
          store.createIndex(TRANSLATION_CACHE_STORED_AT_INDEX, 'storedAt')
        }
      })

      request.addEventListener('success', () => {
        const db = request.result
        this.db = db
        this.openPromise = null
        resolve(db)
      })

      request.addEventListener('error', () => {
        this.openPromise = null
        reject(request.error ?? new Error('Failed to open IndexedDB'))
      })
    })

    return this.openPromise
  }

  /** Open the database eagerly so callers can surface open failures early. */
  async open(): Promise<void> {
    await this.getDb()
  }

  /**
   * Read a cached successful translation by canonical identity.
   *
   * Resolves to the record when a well-formed, non-expired success record
   * exists, otherwise `null` (a normal cache miss). Expired records are
   * removed lazily (a single bounded delete) and malformed records — including
   * persisted error payloads that should never have been written — are
   * rejected as a miss rather than surfaced to the caller.
   */
  async get(key: string): Promise<TranslationCacheRecord | null> {
    const db = await this.getDb()
    const record = await this.runRead(db, key)
    if (!record) return null
    if (this.clock.wallNow() - record.storedAt > TRANSLATION_CACHE_TTL_MS) {
      await this.runWrite(db, TRANSLATION_CACHE_STORE, 'delete', key)
      return null
    }
    return record
  }

  /**
   * Persist a successful translation payload under the canonical identity.
   *
   * Only payloads carrying `translatedText` are accepted; anything else is
   * rejected so a failed provider attempt can never be cached as a success.
   * After the write, the bounded cleanup path enforces the entry-count budget.
   */
  async put(key: string, result: TranslationCacheRecord): Promise<void> {
    this.assertValidRecord(result, key)
    const db = await this.getDb()
    await this.runWrite(db, TRANSLATION_CACHE_STORE, 'put', result)
    await this.enforceLimits(db)
  }

  /** Remove one record by canonical identity. */
  async delete(key: string): Promise<void> {
    const db = await this.getDb()
    return this.runWrite(db, TRANSLATION_CACHE_STORE, 'delete', key)
  }

  /** Remove every cached record from the object store. */
  async clear(): Promise<void> {
    const db = await this.getDb()
    return this.runWrite(db, TRANSLATION_CACHE_STORE, 'clear')
  }

  /**
   * Run the bounded cleanup path: enforce the entry-count budget and remove
   * expired records from the oldest end. Callers (e.g. the Service Worker on
   * idle) can invoke this directly; `put` already runs it after each write.
   * Returns the number of records removed.
   */
  async cleanup(): Promise<number> {
    const db = await this.getDb()
    return this.enforceLimits(db)
  }

  /**
   * Enforce the persistent-cache storage bound. Computes the overflow against
   * the finite entry-count limit, then evicts records in deterministic
   * oldest-first order. Because all expired records have smaller `storedAt`
   * than any live record, the scan starting at the oldest end removes expired
   * records first, bounded by TRANSLATION_CACHE_CLEANUP_BOUND.
   */
  private async enforceLimits(db: IDBDatabase): Promise<number> {
    const count = await this.runCount(db)
    const mustDelete = Math.max(0, count - TRANSLATION_CACHE_MAX_ENTRIES)
    return this.runEvictOldest(db, mustDelete)
  }

  private runCount(db: IDBDatabase): Promise<number> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(TRANSLATION_CACHE_STORE, 'readonly')
      const store = transaction.objectStore(TRANSLATION_CACHE_STORE)
      const request = store.count()

      request.addEventListener('success', () => {
        resolve(request.result)
      })
      request.addEventListener('error', () => {
        reject(request.error ?? new Error('IndexedDB count failed'))
      })
    })
  }

  /**
   * Walk the storedAt index from the oldest record, deleting records until the
   * overflow budget is met and no more expired records remain within the
   * cleanup bound. Ties on `storedAt` are broken by primary key (ascending),
   * matching IndexedDB index ordering, so eviction is fully deterministic.
   */
  private runEvictOldest(db: IDBDatabase, mustDelete: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(TRANSLATION_CACHE_STORE, 'readwrite')
      const store = transaction.objectStore(TRANSLATION_CACHE_STORE)
      const request = store.index(TRANSLATION_CACHE_STORED_AT_INDEX).openCursor()
      const now = this.clock.wallNow()
      let deleted = 0

      const step = (): void => {
        const cursor = request.result
        if (!cursor) {
          resolve(deleted)
          return
        }
        const record = cursor.value as TranslationCacheRecord | undefined
        const expired = typeof record?.storedAt === 'number' &&
          now - record.storedAt > TRANSLATION_CACHE_TTL_MS
        if (!expired && deleted >= mustDelete) {
          resolve(deleted)
          return
        }
        if (expired && deleted >= mustDelete + TRANSLATION_CACHE_CLEANUP_BOUND) {
          resolve(deleted)
          return
        }
        cursor.delete()
        deleted++
        cursor.continue()
      }

      request.addEventListener('success', step)
      request.addEventListener('error', () => {
        reject(request.error ?? new Error('IndexedDB eviction failed'))
      })
    })
  }

  /**
   * Validate that a record carries the shape the adapter contract accepts.
   * Rejecting here keeps malformed or error-only payloads out of storage.
   */
  private assertValidRecord(record: TranslationCacheRecord, key: string): void {
    if (
      typeof record.key !== 'string' ||
      record.key !== key ||
      typeof record.translatedText !== 'string' ||
      record.translatedText.length === 0 ||
      typeof record.storedAt !== 'number'
    ) {
      throw new TypeError('translation-cache record must carry a matching key and a successful translatedText')
    }
  }

  private isWellFormed(record: unknown): record is TranslationCacheRecord {
    if (typeof record !== 'object' || record === null) return false
    const candidate = record as Record<string, unknown>
    return (
      typeof candidate.key === 'string' &&
      typeof candidate.translatedText === 'string' &&
      candidate.translatedText.length > 0 &&
      typeof candidate.storedAt === 'number'
    )
  }

  private runRead(db: IDBDatabase, key: string): Promise<TranslationCacheRecord | null> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(TRANSLATION_CACHE_STORE, 'readonly')
      const store = transaction.objectStore(TRANSLATION_CACHE_STORE)
      const request = store.get(key)

      request.addEventListener('success', () => {
        const value = request.result
        resolve(this.isWellFormed(value) ? value : null)
      })
      request.addEventListener('error', () => {
        reject(request.error ?? new Error('IndexedDB get failed'))
      })
    })
  }

  private runWrite(
    db: IDBDatabase,
    storeName: string,
    mode: 'put' | 'delete' | 'clear',
    value?: unknown,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      let request: IDBRequest | undefined

      if (mode === 'put') {
        request = store.put(value)
      } else if (mode === 'delete') {
        request = store.delete(value as IDBValidKey)
      } else {
        request = store.clear()
      }

      request.addEventListener('success', () => resolve())
      request.addEventListener('error', () => {
        reject(request?.error ?? new Error('IndexedDB write failed'))
      })
    })
  }
}
