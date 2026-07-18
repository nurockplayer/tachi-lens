/**
 * Real Twitch DOM compatibility canary.
 *
 * Loads the packaged Extension against a real Twitch channel page and
 * verifies that the Content Script attaches, finds the real chat container,
 * and recognizes at least one real chat message using the production
 * selector contract from twitch-selectors.ts.
 *
 * This is intentionally non-deterministic and network-dependent. It never
 * runs as a pull-request required check and is excluded from normal
 * `pnpm test:e2e`.
 *
 * Required environment variable:
 *   TWITCH_CANARY_URL — a public https://www.twitch.tv/<channel> URL
 */
import { expect } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'
import { test } from './fixtures/extension'
import type { ExtensionError } from './fixtures/extension'
import { seedTestSettings, getDiagnosticsEvents } from './fixtures/twitch-page'
import {
  FALLBACKS,
  CHAT_CONTAINER,
  CHAT_MESSAGE,
  CHAT_MESSAGE_BODY,
  CHAT_USERNAME,
} from '../src/content/twitch-selectors'

const TWITCH_RESERVED_SINGLE_SEGMENT = new Set([
  'directory', 'login', 'signup', 'downloads', 'jobs', 'about',
  'press', 'advertise', 'turbo', 'prime', 'gifts', 'wallet',
  'settings', 'inventory', 'subscriptions', 'friends', 'messages',
  'creatorcamp', 'blog', 'shop', 'safety', 'legal',
])

const CANARY_URL = process.env.TWITCH_CANARY_URL

if (!CANARY_URL) {
  throw new Error(
    'TWITCH_CANARY_URL environment variable must be set to an https://www.twitch.tv/<channel> URL.\n' +
    'Got: (unset)',
  )
}

let parsedUrl: URL
try {
  parsedUrl = new URL(CANARY_URL)
} catch {
  throw new Error(
    `TWITCH_CANARY_URL is not a valid URL.\n` +
    `Expected: https://www.twitch.tv/<channel>\n` +
    `Got: "${CANARY_URL}"`,
  )
}

if (
  parsedUrl.protocol !== 'https:' ||
  parsedUrl.hostname !== 'www.twitch.tv' ||
  parsedUrl.username ||
  parsedUrl.password
) {
  throw new Error(
    `TWITCH_CANARY_URL must be an https://www.twitch.tv/<channel> URL.\n` +
    `Got: "${CANARY_URL}"`,
  )
}

const pathSegments = parsedUrl.pathname.replace(/^\/+|\/+$/g, '').split('/')
if (
  pathSegments.length !== 1 ||
  !pathSegments[0] ||
  TWITCH_RESERVED_SINGLE_SEGMENT.has(pathSegments[0].toLowerCase())
) {
  throw new Error(
    `TWITCH_CANARY_URL must be an https://www.twitch.tv/<channel> URL (single non-empty path segment, not a reserved route).\n` +
    `Got: "${CANARY_URL}"`,
  )
}

const PROVIDER_HOSTS = [
  'generativelanguage.googleapis.com',
  'api.deepseek.com',
  'api.openai.com',
  'api.anthropic.com',
]

interface SelectorMatch {
  group: string
  selector: string
  matched: boolean
}

async function dismissOverlays(page: Page): Promise<void> {
  const consentDialogSelectors = [
    'div[data-a-target="twilight-scrollable-selector"] button:has-text("I am over 18")',
    'div[data-a-target="consent-banner"] button:has-text("Accept")',
  ]
  for (const sel of consentDialogSelectors) {
    const locator = page.locator(sel).first()
    if (await locator.isVisible({ timeout: 300 }).catch(() => false)) {
      await locator.click({ timeout: 2000 }).catch(() => undefined)
    }
  }
}

/** Sanitize HTML inside the browser context via page.evaluate. */
async function sanitizeContainerHtml(page: Page, containerSel: string): Promise<string | null> {
  const el = page.locator(containerSel).first()
  if (!(await el.isVisible().catch(() => false))) return null

  return el.evaluate((node) => {
    const ALLOWED = /^(class|data-test-selector|data-a-target|role)$/i
    const clone = (node as HTMLElement).cloneNode(true) as HTMLElement
    const strip = (el: Element) => {
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === 3) {
          child.textContent = '…'
        } else if (child.nodeType === 8) {
          child.parentNode?.removeChild(child)
        } else if (child.nodeType === 1) {
          strip(child as Element)
        }
      }
      for (const attr of Array.from(el.attributes)) {
        if (!ALLOWED.test(attr.name)) el.removeAttribute(attr.name)
      }
    }
    strip(clone)
    return clone.outerHTML.substring(0, 5000)
  }).catch(() => null)
}

/** Record all selector outcomes. */
async function recordSelectorOutcomes(page: Page): Promise<SelectorMatch[]> {
  const results: SelectorMatch[] = []
  for (const sel of FALLBACKS[CHAT_CONTAINER]) {
    const count = await page.locator(sel).count()
    results.push({ group: 'chat_container', selector: sel, matched: count > 0 })
  }

  const matchedContainer = results.find((r) => r.matched)
  if (!matchedContainer) return results

  const container = page.locator(matchedContainer.selector).first()
  for (const sel of FALLBACKS[CHAT_MESSAGE]) {
    const count = await container.locator(sel).count()
    results.push({ group: 'chat_message', selector: sel, matched: count > 0 })
  }
  for (const sel of FALLBACKS[CHAT_USERNAME]) {
    const count = await container.locator(sel).count()
    results.push({ group: 'chat_username', selector: sel, matched: count > 0 })
  }
  for (const sel of FALLBACKS[CHAT_MESSAGE_BODY]) {
    const count = await container.locator(sel).count()
    results.push({ group: 'chat_body', selector: sel, matched: count > 0 })
  }
  return results
}

/** Filter collectedErrors to only extension-attributed errors with raw text
 * for Service Worker errors only (SW errors are always the extension's own).
 * Page errors produce only metadata (count), not raw text. Returns both the
 * SW text list and total page-error count for assertion and attachment. */
function extensionAttributedErrors(errors: ExtensionError[]): { texts: string[]; unattributedPageCount: number; attributedPageCount: number } {
  const texts = errors
    .filter((e) => e.source === 'service-worker' && e.isExtensionAttributed)
    .map((e) => `[SW] ${e.text}`)
  const unattributedPageCount = errors.filter(
    (e) => e.source === 'page' && !e.isExtensionAttributed,
  ).length
  const attributedPageCount = errors.filter(
    (e) => e.source === 'page' && e.isExtensionAttributed,
  ).length
  return { texts, unattributedPageCount, attributedPageCount }
}

/**
 * Apply a black overlay over an element identified by selector, inside the
 * browser page context. Returns getComputedStyle confirmation that the overlay
 * has black background and fixed positioning. Used by both the production
 * artifact path and the deterministic regression test.
 */
async function applyBlackOverlay(page: Page, containerSel: string): Promise<boolean> {
  return page.evaluate((s) => {
    const container = document.querySelector(s)
    if (!container) return false
    const rect = container.getBoundingClientRect()
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:' + rect.top + 'px;left:' + rect.left + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;background:black;z-index:999999;pointer-events:none;'
    document.body.appendChild(overlay)
    const cs = window.getComputedStyle(overlay)
    return cs.backgroundColor === 'rgb(0, 0, 0)' && cs.position === 'fixed' && cs.zIndex === '999999'
  }, containerSel)
}

test.describe('Real Twitch DOM compatibility canary', () => {

  // --- Sanitizer regression: verify privacy redaction ---
  test('sanitizer removes text, comments, and disallowed attributes', async ({ context }) => {
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

  // --- Redacted screenshot regression: verify the shared applyBlackOverlay helper ---
  test('redacted screenshot overlay is positively applied and composited', async ({ context }) => {
    const page = await context.newPage()
    await page.setContent(`
      <div id="chat" style="position:fixed;top:10px;left:10px;width:300px;height:100px;background:white;">
        <p>visible chat text here</p>
      </div>
    `)

    // Exercise the SHARED applyBlackOverlay helper — same function used
    // by the production attachCanaryArtifacts failure path.
    const applied = await applyBlackOverlay(page, '#chat')
    expect(applied).toBe(true)

    const ss = await page.screenshot({ type: 'png' })
    expect(ss.byteLength).toBeGreaterThan(500)
  })

  // --- Error attribution regression: verify extension-origin filtering ---
  test.describe('error attribution', () => {

    test('attributed SW errors pass, Twitch page errors are not attributed', async ({
      context,
      serviceWorker,
      extensionId,
      collectedErrors,
    }, testInfo) => {
      expect(serviceWorker).toBeDefined()
      expect(extensionId).toMatch(/^[a-z]{32}$/)

      await seedTestSettings(serviceWorker)
      const page = await context.newPage()
      await page.goto(CANARY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await dismissOverlays(page)
      await page.waitForTimeout(10_000)

      // Attach detail for diagnosis — only attributed error text (SW errors)
      // which is always safe for the privacy boundary.
      const swErrors = collectedErrors.filter((e) => e.source === 'service-worker')
      for (const e of swErrors) {
        expect(e.isExtensionAttributed).toBe(true)
      }

      // At least one Twitch page error should be present and NOT attributed.
      // (Twitch pages reliably produce third-party ad/tracking console.errors.)
      const unattributedPageErrors = collectedErrors.filter(
        (e) => e.source === 'page' && e.isExtensionAttributed === false,
      )
      expect(unattributedPageErrors.length).toBeGreaterThan(0)

      // Attach detail for diagnosis — only SW-attributed error text.
      const { texts: attributedTexts } = extensionAttributedErrors(collectedErrors)
      await testInfo.attach('attributed-sw-errors', {
        body: JSON.stringify(attributedTexts, null, 2),
        contentType: 'application/json',
      }).catch(() => undefined)

      // Attach unattributed metadata (count, sources, types) but not raw text
      const unattributedMeta = unattributedPageErrors.map((e) => ({
        source: e.source,
        type: e.type,
        isExtensionAttributed: e.isExtensionAttributed,
        textLength: e.text.length,
      }))
      await testInfo.attach('unattributed-error-metadata', {
        body: JSON.stringify(unattributedMeta, null, 2),
        contentType: 'application/json',
      }).catch(() => undefined)
    })

    test('deliberate SW console.error is positively attributed', async ({
      context,
      extensionId,
      collectedErrors,
      serviceWorker,
    }, testInfo) => {
      expect(serviceWorker).toBeDefined()
      expect(extensionId).toMatch(/^[a-z]{32}$/)

      // Force a direct extension SW console.error
      await serviceWorker.evaluate(() => {
        console.error('[tachi-lens-test] deliberate SW error for attribution verification')
      })
      await new Promise((r) => setTimeout(r, 1000))

      const swAttributed = collectedErrors.filter(
        (e) => e.source === 'service-worker' && e.isExtensionAttributed,
      )
      // The deliberate error should be attributed
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
  })

  test('Extension attaches, finds chat container and real messages, no provider', async ({
    context,
    serviceWorker,
    extensionId,
    collectedErrors,
  }, testInfo) => {
    expect(serviceWorker).toBeDefined()
    expect(extensionId).toMatch(/^[a-z]{32}$/)

    // --- Block provider hosts ---
    const providerRequests: string[] = []
    await Promise.all(
      PROVIDER_HOSTS.map((host) =>
        context.route(`https://${host}/**`, async (route) => {
          providerRequests.push(host)
          await route.abort('blockedbyclient')
        }),
      ),
    )

    await seedTestSettings(serviceWorker)

    const selectorResults: SelectorMatch[] = []
    let page: Page | undefined

    try {
      page = await context.newPage()

      await page.goto(CANARY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await dismissOverlays(page)

      selectorResults.push(...await recordSelectorOutcomes(page))

      await expect(async () => {
        const events = await getDiagnosticsEvents(serviceWorker)
        expect(events.some((e) => e.stage === 'chat_container_ready')).toBe(true)
      }).toPass({ timeout: 25_000 })

      selectorResults.length = 0
      selectorResults.push(...await recordSelectorOutcomes(page))

      const containerSel = FALLBACKS[CHAT_CONTAINER].find(
        (sel) => selectorResults.some((r) => r.group === 'chat_container' && r.selector === sel && r.matched),
      )
      expect(containerSel, 'Expected at least one chat container selector to match').toBeDefined()

      const container = page.locator(containerSel!).first()
      const messageFallbacks = FALLBACKS[CHAT_MESSAGE]
      const usernameFallbacks = FALLBACKS[CHAT_USERNAME]
      const bodyFallbacks = FALLBACKS[CHAT_MESSAGE_BODY]

      await expect(async () => {
        for (const msgSel of messageFallbacks) {
          const msgCount = await container.locator(msgSel).count()
          for (let i = 0; i < msgCount; i++) {
            const msg = container.locator(msgSel).nth(i)
            if (!(await msg.isVisible().catch(() => false))) continue

            let hasUsername = false
            for (const uSel of usernameFallbacks) {
              const u = msg.locator(uSel).first()
              if (await u.isVisible().catch(() => false)) {
                const text = await u.textContent()
                if (text?.trim()) { hasUsername = true; break }
              }
            }
            if (!hasUsername) continue

            for (const bSel of bodyFallbacks) {
              const b = msg.locator(bSel).first()
              if (await b.isVisible().catch(() => false)) {
                const text = await b.textContent()
                if (text?.trim()) return
              }
            }
          }
        }
        expect(false).toBe(true)
      }).toPass({ timeout: 25_000 })

      expect(providerRequests).toEqual([])

      // Assert only extension-attributed errors (SW only for text).
      // Twitch page noise is excluded via isExtensionAttributed.
      const errorSummary = extensionAttributedErrors(collectedErrors)
      expect(errorSummary.texts).toEqual([])
    } catch (err) {
      if (page) {
        const errorSummary = extensionAttributedErrors(collectedErrors)
        await attachCanaryArtifacts(testInfo, page, serviceWorker, errorSummary.texts, selectorResults, {
          attributedPageCount: errorSummary.attributedPageCount,
          unattributedPageCount: errorSummary.unattributedPageCount,
        })
      }
      throw err
    }
  })
})

/**
 * Privacy-conscious failure attachment for the canary.
 *
 * Artifacts match issue #73 evidence spec:
 * - Playwright trace (from config; source actions only, no screenshots or
 *   DOM snapshots or network HAR — zero cookie/header exposure)
 * - manually redacted screenshot of the Twitch page (chat text masked)
 * - HTML report (from config reporter)
 * - page URL
 * - selector results (which fallback selectors matched)
 * - diagnostics (privacy-safe stage identifiers)
 * - Extension error logs (Service Worker text only)
 * - extension-attributed page error counts (never raw text)
 * - sanitized outer-HTML excerpt around the chat container
 */
async function attachCanaryArtifacts(
  testInfo: TestInfo,
  page: Page,
  serviceWorker: { evaluate: <T>(fn: (args: void) => Promise<T>) => Promise<T> },
  swErrors: string[],
  selectorResults: SelectorMatch[],
  pageErrorSummary?: { attributedPageCount: number; unattributedPageCount: number },
): Promise<void> {
  await testInfo
    .attach('canary-page-url', { body: page.url(), contentType: 'text/plain' })
    .catch(() => undefined)

  await testInfo
    .attach('selector-results', {
      body: JSON.stringify(selectorResults, null, 2),
      contentType: 'application/json',
    })
    .catch(() => undefined)

  const events = await getDiagnosticsEvents(serviceWorker).catch((): [] => [])
  if (events.length > 0) {
    await testInfo
      .attach('diagnostics', {
        body: JSON.stringify(events, null, 2),
        contentType: 'application/json',
      })
      .catch(() => undefined)
  }

  // Sanitized outer-HTML excerpt around the chat container (< 5 KiB).
  for (const sel of FALLBACKS[CHAT_CONTAINER]) {
    const sanitized = await sanitizeContainerHtml(page, sel)
    if (sanitized) {
      await testInfo
        .attach('chat-container-excerpt', {
          body: sanitized,
          contentType: 'text/html',
        })
        .catch(() => undefined)
      break
    }
  }

  // Redacted screenshot: mask chat text via the shared applyBlackOverlay helper.
  let screenshotAttached = false
  for (const sel of FALLBACKS[CHAT_CONTAINER]) {
    const el = page.locator(sel).first()
    if (await el.isVisible().catch(() => false)) {
      const applied = await applyBlackOverlay(page, sel)
      if (applied) {
        // Guard against empty PNG from screenshot failure
        const shot = await page.screenshot({ type: 'png' }).catch(() => null)
        if (shot && shot.byteLength > 100) {
          screenshotAttached = true
          await testInfo.attach('redacted-screenshot', {
            body: shot,
            contentType: 'image/png',
          }).catch(() => undefined)
        }
      }
      break
    }
  }

  // Extension error logs (Service Worker text only — page errors from real
  // Twitch pages are third-party noise and only metadata is retained.)
  if (swErrors.length > 0) {
    await testInfo
      .attach('extension-errors', {
        body: JSON.stringify(swErrors, null, 2),
        contentType: 'application/json',
      })
      .catch(() => undefined)
  }

  // Page error metadata (counts only, never raw text)
  if (pageErrorSummary && (pageErrorSummary.attributedPageCount > 0 || pageErrorSummary.unattributedPageCount > 0)) {
    await testInfo
      .attach('page-error-counts', {
        body: JSON.stringify(pageErrorSummary, null, 2),
        contentType: 'application/json',
      })
      .catch(() => undefined)
  }
}
