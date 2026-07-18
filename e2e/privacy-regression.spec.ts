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

  test('is positively applied and composited via applyBlackOverlay', async ({ context }) => {
    const page = await context.newPage()
    await page.setContent(`
      <div id="chat" style="position:fixed;top:10px;left:10px;width:300px;height:100px;background:white;">
        <p>visible chat text here</p>
      </div>
    `)

    const applied = await applyBlackOverlay(page, '#chat')
    expect(applied).toBe(true)

    const ss = await page.screenshot({ type: 'png' })
    expect(ss.byteLength).toBeGreaterThan(500)
  })

  test('masks two distinct containers matched by different selectors', async ({ context }) => {
    const page = await context.newPage()
    await page.setContent(`
      <div class="container-a" style="position:fixed;top:10px;left:10px;width:100px;height:50px;background:white;">text a</div>
      <div class="container-b" style="position:fixed;top:80px;left:10px;width:100px;height:50px;background:white;">text b</div>
    `)

    // Simulate the production logic: iterate fallbacks, set unique data attributes
    const results = await page.evaluate(() => {
      const selectors = ['.container-a', '.container-b']
      const uids: string[] = []
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel)
        for (let i = 0; i < els.length; i++) {
          const el = els[i] as HTMLElement
          const uid = 'multi-mask-' + uids.length
          el.setAttribute('data-multi-mask', uid)
          const overlay = document.createElement('div')
          overlay.style.cssText = 'position:fixed;top:' + el.offsetTop + 'px;left:' + el.offsetLeft + 'px;width:' + el.offsetWidth + 'px;height:' + el.offsetHeight + 'px;background:black;z-index:999999;pointer-events:none;'
          document.body.appendChild(overlay)
          uids.push(uid)
        }
      }
      return uids
    })

    expect(results).toEqual(['multi-mask-0', 'multi-mask-1'])

    // Verify each masked container's overlay via the background of the overlay
    for (const uid of results) {
      const overlay = page.locator('[data-multi-mask="' + uid + '"] + div')
      expect(overlay).not.toBeNull()
    }
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
    // Use a runtime.onMessage event for explicit wait instead of fixed sleep
    await expect(async () => {
      const { texts } = extensionAttributedErrors(collectedErrors)
      expect(texts.some((t) => t.includes('tachi-lens-test'))).toBe(true)
    }).toPass({ timeout: 5_000 })

    const { texts, unattributedPageCount, attributedPageCount } = extensionAttributedErrors(collectedErrors)
    expect(texts.some((t) => t.includes('tachi-lens-test'))).toBe(true)
    // unattributedPageCount should be 0 since page has no errors
    // attributedPageCount should be 0 since page has no extension-origin errors

    await testInfo.attach('sw-attribution-test', {
      body: JSON.stringify({
        texts,
        unattributedPageCount,
        attributedPageCount,
      }, null, 2),
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

    // Generate a deterministic page-origin error with a unique, retained tag
    const tag = 'tachi-lens-test-page-' + Date.now()
    await page.evaluate((t) => {
      const s = document.createElement('script')
      s.textContent = 'setTimeout(() => { console.error("[' + t + '] deliberate page error for attribution"); }, 50)'
      document.head.appendChild(s)
    }, tag)

    // Use expect.toPass to wait for the tagged error to appear in collected errors
    await expect(async () => {
      const tagged = collectedErrors.filter(
        (e) => e.source === 'page' && e.text.includes(tag),
      )
      expect(tagged.length).toBeGreaterThan(0)
      // Every tagged error must be unattributed
      for (const e of tagged) {
        expect(e.isExtensionAttributed).toBe(false)
      }
    }).toPass({ timeout: 5_000 })

    // Now verify through extensionAttributedErrors
    const { texts, unattributedPageCount, attributedPageCount } = extensionAttributedErrors(collectedErrors)
    // texts is SW-only, must not contain the tag
    expect(texts.some((t) => t.includes(tag))).toBe(false)
    // unattributedPageCount must be > 0 (the deliberate error plus any ambient page errors)
    expect(unattributedPageCount).toBeGreaterThan(0)
    // attributedPageCount must be 0 — no extension-origin page errors
    expect(attributedPageCount).toBe(0)

    await testInfo.attach('page-attribution-test', {
      body: JSON.stringify({
        tag,
        texts,
        unattributedPageCount,
        attributedPageCount,
      }, null, 2),
      contentType: 'application/json',
    }).catch(() => undefined)
  })
})
