// Versioned IndexedDB translation-cache adapter.
//
// This is the persistent-storage primitive behind the translation cache (#44).
// It deliberately knows nothing about the Translator request flow, TTL
// expiration, or eviction budgets: this module only owns a small, versioned
// IndexedDB object store keyed by the canonical translation identity (#54).
//
// Only successful translation payloads may be persisted. A record without a
// translatedText is treated as a cache miss so the read side never surfaces a
// failed provider attempt as if it were a cached result.
//
// IndexedDB is only reachable in trusted extension contexts (the Service
// Worker); content scripts and the popup never touch this module.

import { buildTranslationIdentity } from '@/shared/translation-identity'
import type { TranslationIdentityInput } from '@/shared/translation-identity'

/** IndexedDB database name for the persistent translation cache. */
export const TRANSLATION_CACHE_DB_NAME = 'tachi-lens-translation-cache' as const

/**
 * Database + record schema version. Bump when the record shape or lookup
 * semantics change in a way that requires recreating the object store.
 * This is independent of TRANSLATION_CONTRACT_VERSION, which is embedded in
 * each canonical translation identity and invalidates results on its own.
 */
export const TRANSLATION_CACHE_DB_VERSION = 1 as const

/** Name of the object store holding translation-cache records. */
export const TRANSLATION_CACHE_STORE = 'translations' as const

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
 * translation identity. Missing or malformed records resolve to `null`
 * (a normal cache miss) instead of throwing.
 */
export class TranslationCacheDb {
  private readonly factory: IndexedDbFactory
  private db: IDBDatabase | null = null
  private openPromise: Promise<IDBDatabase> | null = null

  constructor(factory: IndexedDbFactory = globalIndexedDbFactory) {
    this.factory = factory
  }

  /**
   * Build the canonical cache key for a translation request, delegating to
   * the shared translation identity so persistent and in-memory layers
   * always agree on equivalence.
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
        if (!db.objectStoreNames.contains(TRANSLATION_CACHE_STORE)) {
          db.createObjectStore(TRANSLATION_CACHE_STORE, { keyPath: 'key' })
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
   * Resolves to the record when a well-formed success record exists, otherwise
   * `null` (a normal cache miss). Malformed records — including persisted
   * error payloads that should never have been written — are rejected as a
   * miss rather than surfaced to the caller.
   */
  async get(key: string): Promise<TranslationCacheRecord | null> {
    const db = await this.getDb()
    return this.runRead(db, key)
  }

  /**
   * Persist a successful translation payload under the canonical identity.
   *
   * Only payloads carrying `translatedText` are accepted; anything else is
   * rejected so a failed provider attempt can never be cached as a success.
   */
  async put(key: string, result: TranslationCacheRecord): Promise<void> {
    this.assertValidRecord(result, key)
    const db = await this.getDb()
    return this.runWrite(db, TRANSLATION_CACHE_STORE, 'put', result)
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
