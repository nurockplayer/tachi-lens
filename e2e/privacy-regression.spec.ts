/**
 * Deterministic privacy and diagnostic regression tests for the Extension.
 *
 * These tests verify the privacy-redaction, screenshot-masking, and error-attribution
 * helpers used by the real-Twitch canary. They run as part of the default E2E suite
 * so pull requests cannot silently break them.
 *
 * All helpers are imported from e2e/fixtures/canary-helpers.ts — the same code
 * used by twitch-canary.spec.ts failure artifacts.
 */
import { expect } from '@playwright/test'
import { test } from './fixtures/extension'
import { sanitizeContainerHtml, applyBlackOverlay, extensionAttributedErrors } from './fixtures/canary-helpers'

// --- Tests ---

test.describe('Privacy regression: sanitizer', () => {

  test('removes text, comments, and disallowed attributes', async ({ context }) => {
    const page = await context.newPage()
    await page.setContent(`
      <div class="test" data-test-selector="keep" aria-label="user: chattext" style="color:red"
           data-userid="12345">
        visible text
        <!-- sensitive comment -->
        <span class="inner" data-a-target="body">username text</span>
      </div>
    `)
    const result = await sanitizeContainerHtml(page, '.test')

    expect(result).not.toBeNull()
    expect(result!).toContain('class="test"')
    expect(result!).toContain('data-test-selector="keep"')
    expect(result!).toContain('data-a-target="body"')
    expect(result!).not.toContain('aria-label')
    expect(result!).not.toContain('style')
    expect(result!).not.toContain('data-userid')
    expect(result!).not.toContain('visible text')
    expect(result!).not.toContain('username text')
    expect(result!).not.toContain('sensitive comment')
    expect(result!).not.toContain('<!--')
    expect(result!).toContain('>…<')
  })
})

test.describe('Privacy regression: redacted screenshot overlay', () => {

  test('masks one visible element via applyBlackOverlay', async ({ context }) => {
    const page = await context.newPage()
    await page.setContent(`
      <div id="chat" style="position:fixed;top:10px;left:10px;width:300px;height:100px;background:white;">
        <p>visible chat text here</p>
      </div>
    `)

    const masked = await applyBlackOverlay(page, '#chat')
    expect(masked).toBe(1)

    const ss = await page.screenshot({ type: 'png' })
    expect(ss.byteLength).toBeGreaterThan(500)
  })

  test('masks two distinct containers matched by different selectors', async ({ context }) => {
    const page = await context.newPage()
    await page.setContent(`
      <div class="container-a" style="position:fixed;top:10px;left:10px;width:100px;height:50px;background:white;">text a</div>
      <div class="container-b" style="position:fixed;top:80px;left:10px;width:100px;height:50px;background:white;">text b</div>
    `)

    const masked = await applyBlackOverlay(page, '.container-a, .container-b')
    expect(masked).toBe(2)

    // Each target should have a unique data-tachi-overlay attribute
    const dataAttrs: string[] = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-tachi-overlay]')).map(el => el.getAttribute('data-tachi-overlay') || '')
    })
    expect(dataAttrs.length).toBe(2)
    expect(dataAttrs[0]).not.toBe(dataAttrs[1])

    // Count overlay divs — the style is set as inline CSS via style.cssText
    const overlayCount = await page.evaluate(() => {
      const divs = document.querySelectorAll('div')
      let n = 0
      for (const d of divs) {
        // The overlay has pointer-events:none and z-index:999999
        if (d.style?.zIndex === '999999' && d.style?.pointerEvents === 'none') n++
      }
      return n
    })
    expect(overlayCount).toBe(2)
  })

  test('skips hidden elements', async ({ context }) => {
    const page = await context.newPage()
    await page.setContent(`
      <div id="visible" style="position:fixed;top:10px;left:10px;width:100px;height:50px;background:white;">visible</div>
      <div id="hidden" style="display:none;">hidden</div>
    `)

    const masked = await applyBlackOverlay(page, '#visible, #hidden')
    expect(masked).toBe(1) // only the visible one

    const attrCount = await page.evaluate(() => document.querySelectorAll('[data-tachi-overlay]').length)
    expect(attrCount).toBe(1) // only one element marked
  })
})

test.describe('Error attribution regression', () => {

  test('deliberate SW console.error is positively attributed — verified via extensionAttributedErrors', async ({
    context,
    serviceWorker,
    extensionId,
    collectedErrors,
  }, testInfo) => {
    expect(serviceWorker).toBeDefined()
    expect(extensionId).toMatch(/^[a-z]{32}$/)

    await serviceWorker.evaluate(() => {
      console.error('[tachi-lens-test] deliberate SW error for attribution verification')
    })
    await expect(async () => {
      const { texts } = extensionAttributedErrors(collectedErrors)
      expect(texts.some((t) => t.includes('tachi-lens-test'))).toBe(true)
    }).toPass({ timeout: 5_000 })

    const { texts, unattributedPageCount, attributedPageCount } = extensionAttributedErrors(collectedErrors)
    expect(texts.some((t) => t.includes('tachi-lens-test'))).toBe(true)

    await testInfo.attach('sw-attribution-test', {
      body: JSON.stringify({ texts, unattributedPageCount, attributedPageCount }, null, 2),
      contentType: 'application/json',
    }).catch(() => undefined)
  })

  test('deliberate page console.error is unattributed — verified via extensionAttributedErrors', async ({
    context,
    serviceWorker,
    collectedErrors,
  }, testInfo) => {
    expect(serviceWorker).toBeDefined()

    const page = await context.newPage()
    await page.goto('about:blank')

    const tag = 'tachi-lens-test-page-' + Date.now()
    await page.evaluate((t) => {
      const s = document.createElement('script')
      s.textContent = 'setTimeout(() => { console.error("[' + t + '] deliberate page error for attribution"); }, 50)'
      document.head.appendChild(s)
    }, tag)

    await expect(async () => {
      const tagged = collectedErrors.filter(
        (e) => e.source === 'page' && e.text.includes(tag),
      )
      expect(tagged.length).toBeGreaterThan(0)
      for (const e of tagged) {
        expect(e.isExtensionAttributed).toBe(false)
      }
    }).toPass({ timeout: 5_000 })

    const { texts, unattributedPageCount, attributedPageCount } = extensionAttributedErrors(collectedErrors)
    expect(texts.some((t) => t.includes(tag))).toBe(false)
    expect(unattributedPageCount).toBeGreaterThan(0)
    expect(attributedPageCount).toBe(0)

    await testInfo.attach('page-attribution-test', {
      body: JSON.stringify({ tag, texts, unattributedPageCount, attributedPageCount }, null, 2),
      contentType: 'application/json',
    }).catch(() => undefined)
  })
})
