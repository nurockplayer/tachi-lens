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

  test('is positively applied and composited', async ({ context }) => {
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
    await new Promise((r) => setTimeout(r, 1000))

    const swAttributed = collectedErrors.filter(
      (e) => e.source === 'service-worker' && e.isExtensionAttributed,
    )
    const found = swAttributed.some((e) => e.text.includes('tachi-lens-test'))
    expect(found).toBe(true)

    await testInfo.attach('sw-attribution-test', {
      body: JSON.stringify({
        totalSwErrors: collectedErrors.filter((e) => e.source === 'service-worker').length,
        attributedSwErrors: swAttributed.length,
        deliberateErrorFound: found,
      }, null, 2),
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

    // Generate a deterministic page-origin error
    await page.evaluate(() => {
      const s = document.createElement('script')
      s.textContent = 'setTimeout(() => { console.error("[tachi-lens-test] deliberate page error for attribution"); }, 50)'
      document.head.appendChild(s)
    })
    await new Promise((r) => setTimeout(r, 1500))

    // The deliberate page error should be present and NOT attributed
    const deliberate = collectedErrors.filter(
      (e) => e.source === 'page' && e.text.includes('tachi-lens-test'),
    )
    expect(deliberate.length).toBeGreaterThan(0)
    for (const e of deliberate) {
      expect(e.isExtensionAttributed).toBe(false)
    }

    await testInfo.attach('page-attribution-test', {
      body: JSON.stringify({
        totalPageErrors: collectedErrors.filter((e) => e.source === 'page').length,
        deliberateErrorFound: deliberate.length,
        deliberateUnattributed: deliberate.every((e) => !e.isExtensionAttributed),
      }, null, 2),
      contentType: 'application/json',
    }).catch(() => undefined)
  })
})
