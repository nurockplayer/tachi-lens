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
import { seedTestSettings, getDiagnosticsEvents } from './fixtures/twitch-page'
import { sanitizeContainerHtml, applyBlackOverlay, extensionAttributedErrors } from './fixtures/canary-helpers'
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

/** Sanitize HTML inside the browser context via page.evaluate.
 * Imported from e2e/fixtures/canary-helpers.ts — shared with privacy-regression.spec.ts. */
// sanitizeContainerHtml is imported from canary-helpers. No local declaration needed.

/** Record all selector outcomes across every matched container. */
async function recordSelectorOutcomes(page: Page): Promise<SelectorMatch[]> {
  const results: SelectorMatch[] = []

  // Container selectors
  for (const sel of FALLBACKS[CHAT_CONTAINER]) {
    const count = await page.locator(sel).count()
    results.push({ group: 'chat_container', selector: sel, matched: count > 0 })
  }

  // Message/username/body across all matching containers, using evaluate
  // to deduplicate by innerHTML hash (avoids ElementHandle/Locator mismatch).
  const matched: string[] = []
  const matchedUsernames: string[] = []
  const matchedBodies: string[] = []

  for (const containerSel of FALLBACKS[CHAT_CONTAINER]) {
    const containerLoc = page.locator(containerSel).first()
    if (!(await containerLoc.isVisible().catch(() => false))) continue

    const seen = new Set<string>()
    for (const msgSel of FALLBACKS[CHAT_MESSAGE]) {
      const snippets: string[] = await containerLoc.locator(msgSel).evaluateAll(
        (els) => els.map((el) => (el as HTMLElement).outerHTML?.substring(0, 200) || ''),
      )
      for (const s of snippets) {
        if (!seen.has(s)) { seen.add(s); matched.push(msgSel) }
      }
    }

    for (const uSel of FALLBACKS[CHAT_USERNAME]) {
      const texts: (string | null)[] = await containerLoc.locator(uSel).evaluateAll(
        (els) => els.map((el) => el.textContent?.trim() || null),
      )
      for (const t of texts) {
        if (t) matchedUsernames.push(uSel)
      }
    }

    for (const bSel of FALLBACKS[CHAT_MESSAGE_BODY]) {
      const texts: (string | null)[] = await containerLoc.locator(bSel).evaluateAll(
        (els) => els.map((el) => el.textContent?.trim() || null),
      )
      for (const t of texts) {
        if (t) matchedBodies.push(bSel)
      }
    }
  }

  for (const sel of FALLBACKS[CHAT_MESSAGE]) {
    results.push({ group: 'chat_message', selector: sel, matched: matched.includes(sel) })
  }
  for (const sel of FALLBACKS[CHAT_USERNAME]) {
    results.push({ group: 'chat_username', selector: sel, matched: matchedUsernames.includes(sel) })
  }
  for (const sel of FALLBACKS[CHAT_MESSAGE_BODY]) {
    results.push({ group: 'chat_body', selector: sel, matched: matchedBodies.includes(sel) })
  }
  return results
}

/** Filter collectedErrors to only extension-attributed errors with raw text
 * for Service Worker errors only (SW errors are attributed by extension URL).
 * Page errors produce only metadata (count), not raw text. Returns both the
 * SW text list and total page-error count for assertion and attachment.
 *
 * Imported from e2e/fixtures/canary-helpers.ts — shared with privacy-regression.spec.ts. */

/** Test helper: generate a deterministic page-origin console.error and
 * return the resulting unattributed error entry. */
async function emitPageConsoleError(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = document.createElement('script')
    s.textContent = 'setTimeout(() => { console.error("[tachi-lens-test] deliberate page error for attribution"); }, 50)'
    document.head.appendChild(s)
  })
  await new Promise((r) => setTimeout(r, 1500))
}

/**
 * Apply a black overlay over an element identified by selector, inside the
 * browser page context. Returns getComputedStyle confirmation.
 * Imported from e2e/fixtures/canary-helpers.ts — shared with privacy-regression.spec.ts. */
// applyBlackOverlay is imported from canary-helpers. No local declaration needed.

test.describe('Real Twitch DOM compatibility canary', () => {

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

      // Also verify the extension processed the matched message
      // by checking for the tachi-lens processed attribute.
      await expect(async () => {
        for (const msgSel of FALLBACKS[CHAT_MESSAGE]) {
          const msgCount = await container.locator(msgSel).count()
          for (let i = 0; i < msgCount; i++) {
            const msg = container.locator(msgSel).nth(i)
            if (!(await msg.isVisible().catch(() => false))) continue
            const processed = await msg.getAttribute('data-tachi-lens-processed').catch(() => null)
            if (processed === 'true') { return }
          }
        }
        expect(false).toBe(true)
      }).toPass({ timeout: 25_000 })

      await expect(async () => {
        for (const msgSel of FALLBACKS[CHAT_MESSAGE]) {
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
      // Twitch page noise is excluded via isExtensionAttributed;
      // extension page errors would also be caught here.
      const errorSummary = extensionAttributedErrors(collectedErrors)
      expect(errorSummary.texts).toEqual([])
      expect(errorSummary.attributedPageCount).toBe(0)
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
