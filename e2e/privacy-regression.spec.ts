/**
 * Deterministic privacy and diagnostic regression tests for the Extension.
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

  test('masks visible on-screen element', async ({ context }) => {
    const page = await context.newPage()
    await page.setContent(`
      <div id="chat" style="position:fixed;top:10px;left:10px;width:300px;height:100px;background:white;">
        <p>visible chat text here</p>
      </div>
    `)

    const results = await applyBlackOverlay(page, '#chat')
    expect(results.length).toBe(1)

    const r = results[0]!
    expect(r.overlayBg).toBe('rgb(0, 0, 0)')
    expect(r.overlayTop).toBe(r.targetRect.top)
    expect(r.overlayLeft).toBe(r.targetRect.left)
    expect(r.overlayWidth).toBe(r.targetRect.width)
    expect(r.overlayHeight).toBe(r.targetRect.height)
  })

  test('skips element scrolled out of viewport', async ({ context }) => {
    const page = await context.newPage()

    // Set viewport to 800x600, place the element far below
    await page.setViewportSize({ width: 800, height: 600 })
    await page.setContent(`
      <div id="offscreen" style="position:absolute;top:5000px;left:10px;width:100px;height:50px;background:white;">offscreen</div>
      <div id="onscreen" style="position:fixed;top:10px;left:10px;width:100px;height:50px;background:white;">onscreen</div>
    `)

    const results = await applyBlackOverlay(page, '#offscreen, #onscreen')
    expect(results.length).toBe(1) // only onscreen

    const r = results[0]!
    expect(r.overlayBg).toBe('rgb(0, 0, 0)')
    // Verify it is the onscreen element
    const onscreenAttr = await page.evaluate(() => document.querySelector('#onscreen')?.getAttribute('data-tachi-overlay'))
    expect(onscreenAttr).toBe(r.targetAttr)
  })

  test('masks two distinct containers with unique attrs and black bg', async ({ context }) => {
    const page = await context.newPage()
    await page.setContent(`
      <div class="container-a" style="position:fixed;top:10px;left:10px;width:100px;height:50px;background:white;">text a</div>
      <div class="container-b" style="position:fixed;top:80px;left:10px;width:100px;height:50px;background:white;">text b</div>
    `)

    const results = await applyBlackOverlay(page, '.container-a, .container-b')
    expect(results.length).toBe(2)

    for (const r of results) {
      expect(r.overlayBg).toBe('rgb(0, 0, 0)')
      expect(r.overlayTop).toBe(r.targetRect.top)
      expect(r.overlayLeft).toBe(r.targetRect.left)
      expect(r.overlayWidth).toBe(r.targetRect.width)
      expect(r.overlayHeight).toBe(r.targetRect.height)
    }

    expect(results[0]!.targetAttr).not.toBe(results[1]!.targetAttr)

    for (const r of results) {
      const exists = await page.evaluate((attr) => {
        return document.querySelector('[data-tachi-overlay="' + attr + '"]') !== null
      }, r.targetAttr)
      expect(exists).toBe(true)
    }
  })

  test('skips hidden elements', async ({ context }) => {
    const page = await context.newPage()
    await page.setContent(`
      <div id="visible" style="position:fixed;top:10px;left:10px;width:100px;height:50px;background:white;">visible</div>
      <div id="hidden" style="display:none;">hidden</div>
      <div id="visibility-hidden" style="visibility:hidden;position:fixed;top:200px;left:10px;width:100px;height:50px;">vis-hidden</div>
    `)

    const results = await applyBlackOverlay(page, '#visible, #hidden, #visibility-hidden')
    expect(results.length).toBe(1) // only #visible
    expect(results[0]!.overlayBg).toBe('rgb(0, 0, 0)')

    const attrCount = await page.evaluate(() => document.querySelectorAll('[data-tachi-overlay]').length)
    expect(attrCount).toBe(1)
  })
})

test.describe('Error attribution regression', () => {

  test('deliberate SW console.error is positively attributed', async ({
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

  test('deliberate page console.error is unattributed', async ({
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
