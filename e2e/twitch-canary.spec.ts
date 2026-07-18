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

/** Records which fallback selectors matched, iterating every container instance.
 *  Reports per-selector accuracy (not group-level). */
async function recordSelectorOutcomes(page: Page): Promise<SelectorMatch[]> {
  const results: SelectorMatch[] = []

  // Container selectors — count all matching instances
  for (const sel of FALLBACKS[CHAT_CONTAINER]) {
    const count = await page.locator(sel).count()
    results.push({ group: 'chat_container', selector: sel, matched: count > 0 })
  }

  // Per-selector dedup across ALL container instances
  const seenMessagesBySel = new Map<string, Set<string>>()
  const seenUsernamesBySel = new Map<string, Set<string>>()
  const seenBodiesBySel = new Map<string, Set<string>>()
  for (const sel of FALLBACKS[CHAT_MESSAGE]) seenMessagesBySel.set(sel, new Set())
  for (const sel of FALLBACKS[CHAT_USERNAME]) seenUsernamesBySel.set(sel, new Set())
  for (const sel of FALLBACKS[CHAT_MESSAGE_BODY]) seenBodiesBySel.set(sel, new Set())

  for (const containerSel of FALLBACKS[CHAT_CONTAINER]) {
    const containerCount = await page.locator(containerSel).count()
    for (let ci = 0; ci < containerCount; ci++) {
      const container = page.locator(containerSel).nth(ci)
      if (!(await container.isVisible().catch(() => false))) continue

      for (const [msgSel, set] of seenMessagesBySel) {
        const snippets: string[] = await container.locator(msgSel).evaluateAll(
          (els) => els.map((el) => (el as HTMLElement).outerHTML?.substring(0, 200) || ''),
        )
        for (const s of snippets) { if (s) set.add(s) }
      }
      for (const [uSel, set] of seenUsernamesBySel) {
        const texts: (string | null)[] = await container.locator(uSel).evaluateAll(
          (els) => els.map((el) => el.textContent?.trim() || null),
        )
        for (const t of texts) { if (t) set.add(t) }
      }
      for (const [bSel, set] of seenBodiesBySel) {
        const texts: (string | null)[] = await container.locator(bSel).evaluateAll(
          (els) => els.map((el) => el.textContent?.trim() || null),
        )
        for (const t of texts) { if (t) set.add(t) }
      }
    }
  }

  for (const sel of FALLBACKS[CHAT_MESSAGE]) {
    results.push({ group: 'chat_message', selector: sel, matched: (seenMessagesBySel.get(sel)?.size ?? 0) > 0 })
  }
  for (const sel of FALLBACKS[CHAT_USERNAME]) {
    results.push({ group: 'chat_username', selector: sel, matched: (seenUsernamesBySel.get(sel)?.size ?? 0) > 0 })
  }
  for (const sel of FALLBACKS[CHAT_MESSAGE_BODY]) {
    results.push({ group: 'chat_body', selector: sel, matched: (seenBodiesBySel.get(sel)?.size ?? 0) > 0 })
  }
  return results
}

test.describe('Real Twitch DOM compatibility canary', () => {

  test('Extension attaches, finds chat container, one real message with processed+username+body across all containers', async ({
    context,
    serviceWorker,
    extensionId,
    collectedErrors,
  }, testInfo) => {
    expect(serviceWorker).toBeDefined()
    expect(extensionId).toMatch(/^[a-z]{32}$/)

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

    // Install a non-evicting diagnostic observer in the Service Worker
    // BEFORE navigation. The 20-entry ring can overflow; this writes a
    // permanent flag to chrome.storage.session that never ages out.
    await serviceWorker.evaluate(async () => {
      chrome.runtime.onMessage.addListener((message: unknown) => {
        if (
          typeof message === 'object' && message !== null &&
          (message as Record<string, unknown>).type === 'diagnostic_event'
        ) {
          const payload = (message as Record<string, unknown>).payload as Record<string, unknown> | undefined
          if (payload?.stage === 'chat_container_ready') {
            void chrome.storage.session.set({ canary_chat_container_ready: true })
          }
        }
      })
    })

    try {
      page = await context.newPage()

      await page.goto(CANARY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await dismissOverlays(page)

      // Snapshot selector outcomes early (for failure evidence)
      selectorResults.push(...await recordSelectorOutcomes(page))

      // --- Assertion: chat_container_ready diagnostic observed ---
      // We check BOTH the 20-entry ring AND the permanent storage flag.
      await expect(async () => {
        const events = await getDiagnosticsEvents(serviceWorker)
        const inRing = events.some((e) => e.stage === 'chat_container_ready')
        const flagged = await serviceWorker.evaluate(async () => {
          const data = await chrome.storage.session.get('canary_chat_container_ready')
          return data.canary_chat_container_ready === true
        })
        expect(inRing || flagged).toBe(true)
      }).toPass({ timeout: 30_000 })

      // Refresh selector snapshot (chat may have rendered)
      selectorResults.length = 0
      selectorResults.push(...await recordSelectorOutcomes(page))

      // --- Unified assertion: processed + username + body on the SAME message,
      // across ALL visible container instances.
      const usernameFallbacks = FALLBACKS[CHAT_USERNAME]
      const bodyFallbacks = FALLBACKS[CHAT_MESSAGE_BODY]

      await expect(async () => {
        for (const containerSel of FALLBACKS[CHAT_CONTAINER]) {
          const containerCount = await page.locator(containerSel).count()
          for (let ci = 0; ci < containerCount; ci++) {
            const container = page.locator(containerSel).nth(ci)
            if (!(await container.isVisible().catch(() => false))) continue

            for (const msgSel of FALLBACKS[CHAT_MESSAGE]) {
              const msgCount = await container.locator(msgSel).count()
              for (let i = 0; i < msgCount; i++) {
                const msg = container.locator(msgSel).nth(i)
                if (!(await msg.isVisible().catch(() => false))) continue

                const processed = await msg.getAttribute('data-tachi-lens-processed').catch(() => null)
                if (processed !== 'true') continue

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
          }
        }
        expect(false).toBe(true)
      }).toPass({ timeout: 25_000 })

      expect(providerRequests).toEqual([])

      const errorSummary = extensionAttributedErrors(collectedErrors)
      expect(errorSummary.texts).toEqual([])
      expect(errorSummary.attributedPageCount).toBe(0)
    } catch (err) {
      if (page && !page.isClosed()) {
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
 * - Playwright trace (source actions only, no screenshots/DOM snapshots/network HAR)
 * - manually redacted screenshot of the Twitch page (chat text masked)
 * - HTML report
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

  // Redacted screenshot: mask chat via applyBlackOverlay on container
  // selectors. Only attempt if the page is still open.
  if (page && !page.isClosed()) {
    const results = await applyBlackOverlay(page, FALLBACKS[CHAT_CONTAINER].join(',')).catch((): import('./fixtures/canary-helpers').OverlayResult[] => [])
    if (results.length > 0) {
      const shot = await page.screenshot({ type: 'png' }).catch(() => null)
      if (shot && shot.byteLength > 100) {
        await testInfo.attach('redacted-screenshot', {
          body: shot,
          contentType: 'image/png',
        }).catch(() => undefined)
      }
    }
  }

  // Extension error logs (Service Worker text only — redacted to
  // 120 chars per entry, never uploaded raw.)
  if (swErrors.length > 0) {
    const redacted = swErrors.map((s) => s.length > 120 ? s.substring(0, 120) + '…' : s)
    await testInfo
      .attach('extension-errors', {
        body: JSON.stringify(redacted, null, 2),
        contentType: 'application/json',
      })
      .catch(() => undefined)
  }

  if (pageErrorSummary && (pageErrorSummary.attributedPageCount > 0 || pageErrorSummary.unattributedPageCount > 0)) {
    await testInfo
      .attach('page-error-counts', {
        body: JSON.stringify(pageErrorSummary, null, 2),
        contentType: 'application/json',
      })
      .catch(() => undefined)
  }
}
