import { describe, expect, it } from 'vitest'
import { TranslationCache } from './cache'

describe('TranslationCache', () => {
  describe('buildKey', () => {
    it('builds a cache key from text and params', () => {
      const cache = new TranslationCache()
      const key = cache.buildKey('Hello', 'zh-TW', 'deepseek', 'deepseek-v4-flash')
      expect(key).toBe('Hello|zh-TW|deepseek|deepseek-v4-flash')
    })
  })

  describe('get/set', () => {
    it('stores and retrieves a batch item result', () => {
      const cache = new TranslationCache()
      const result = { id: 'msg1', translatedText: '你好' }

      cache.set('key1', result)
      expect(cache.get('key1')).toEqual(result)
    })

    it('returns undefined for a missing key', () => {
      const cache = new TranslationCache()
      expect(cache.get('nonexistent')).toBeUndefined()
    })

    it('overwrites an existing entry', () => {
      const cache = new TranslationCache()
      cache.set('key1', { id: 'msg1', translatedText: 'Hello' })
      cache.set('key1', { id: 'msg1', translatedText: 'Hi' })
      expect(cache.get('key1')).toEqual({ id: 'msg1', translatedText: 'Hi' })
    })

    it('stores a result with an error', () => {
      const cache = new TranslationCache()
      const result = { id: 'msg1', error: 'API error' }

      cache.set('key1', result)
      expect(cache.get('key1')).toEqual(result)
    })
  })

  describe('has', () => {
    it('returns true for a cached key', () => {
      const cache = new TranslationCache()
      cache.set('key1', { id: 'msg1', translatedText: '你好' })
      expect(cache.has('key1')).toBe(true)
    })

    it('returns false for a missing key', () => {
      const cache = new TranslationCache()
      expect(cache.has('key1')).toBe(false)
    })
  })

  describe('clear', () => {
    it('empties the cache', () => {
      const cache = new TranslationCache()
      cache.set('key1', { id: 'msg1', translatedText: '你好' })
      cache.set('key2', { id: 'msg2', translatedText: '再見' })
      cache.clear()
      expect(cache.has('key1')).toBe(false)
      expect(cache.has('key2')).toBe(false)
      expect(cache.size).toBe(0)
    })
  })

  describe('size', () => {
    it('reports the number of entries', () => {
      const cache = new TranslationCache()
      expect(cache.size).toBe(0)
      cache.set('key1', { id: 'msg1', translatedText: '你好' })
      expect(cache.size).toBe(1)
      cache.set('key2', { id: 'msg2', translatedText: '再見' })
      expect(cache.size).toBe(2)
    })
  })

  describe('LRU eviction', () => {
    it('evicts the oldest entry when max size is exceeded', () => {
      const cache = new TranslationCache(2)
      cache.set('key1', { id: 'msg1', translatedText: 'A' })
      cache.set('key2', { id: 'msg2', translatedText: 'B' })
      cache.set('key3', { id: 'msg3', translatedText: 'C' })
      expect(cache.has('key1')).toBe(false)
      expect(cache.has('key2')).toBe(true)
      expect(cache.has('key3')).toBe(true)
      expect(cache.size).toBe(2)
    })

    it('promotes an entry on get (LRU order update)', () => {
      const cache = new TranslationCache(2)
      cache.set('key1', { id: 'msg1', translatedText: 'A' })
      cache.set('key2', { id: 'msg2', translatedText: 'B' })
      // Access key1 so it becomes most recently used
      cache.get('key1')
      // key2 should be evicted now
      cache.set('key3', { id: 'msg3', translatedText: 'C' })
      expect(cache.has('key1')).toBe(true)
      expect(cache.has('key2')).toBe(false)
      expect(cache.has('key3')).toBe(true)
    })

    it('promotes an entry on has (LRU order update)', () => {
      const cache = new TranslationCache(2)
      cache.set('key1', { id: 'msg1', translatedText: 'A' })
      cache.set('key2', { id: 'msg2', translatedText: 'B' })
      // Check key1 so it becomes most recently used
      cache.has('key1')
      // key2 should be evicted now
      cache.set('key3', { id: 'msg3', translatedText: 'C' })
      expect(cache.has('key1')).toBe(true)
      expect(cache.has('key2')).toBe(false)
      expect(cache.has('key3')).toBe(true)
    })

    it('does not evict when under max size', () => {
      const cache = new TranslationCache(5)
      cache.set('key1', { id: 'msg1', translatedText: 'A' })
      cache.set('key2', { id: 'msg2', translatedText: 'B' })
      cache.set('key3', { id: 'msg3', translatedText: 'C' })
      expect(cache.size).toBe(3)
      expect(cache.has('key1')).toBe(true)
      expect(cache.has('key2')).toBe(true)
      expect(cache.has('key3')).toBe(true)
    })
  })
})
