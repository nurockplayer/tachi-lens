import type { BatchItemResult } from '@/providers/types'
import { buildTranslationIdentity } from '@/shared/translation-identity'

interface CacheEntry {
  result: BatchItemResult
}

export class TranslationCache {
  private cache: Map<string, CacheEntry>
  private maxSize: number

  constructor(maxSize = 500) {
    this.cache = new Map()
    this.maxSize = maxSize
  }

  /**
   * Build the canonical cache key for a translation request, delegating to
   * the shared translation identity so cache lookups and the in-flight /
   * deduplication layers always agree on equivalence.
   */
  buildKey(text: string, targetLang: string, provider: string, model: string, sourceLang?: string): string {
    return buildTranslationIdentity({ text, targetLang, provider, model, sourceLang })
  }

  get(key: string): BatchItemResult | undefined {
    const entry = this.cache.get(key)

    if (!entry) return undefined

    // Promote to most recently used
    this.cache.delete(key)
    this.cache.set(key, entry)

    return entry.result
  }

  set(key: string, result: BatchItemResult): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first inserted)
      const oldestKey = this.cache.keys().next().value

      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey)
      }
    }

    this.cache.set(key, { result })
  }

  has(key: string): boolean {
    if (!this.cache.has(key)) return false

    // Promote to most recently used
    const entry = this.cache.get(key)!

    this.cache.delete(key)
    this.cache.set(key, entry)

    return true
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }
}
