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
import type { Page, TestInfo, Worker } from '@playwright/test'
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

/** Install the non-evicting readiness listener on a Service Worker.
 *  The listener writes canary_chat_container_ready to chrome.storage.session
 *  so it survives ring eviction and SW replacement. */
async function installReadinessObserver(sw: Worker): Promise<void> {
  await sw.evaluate(async () => {
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
}

/** Reacquire the live SW and reinstall the readiness observer if the
 *  worker was replaced by Chromium. Returns the current SW. */
async function ensureReadinessObserver(context: { serviceWorkers: () => Worker[] }, currentSw: Worker): Promise<Worker> {
  const workers = context.serviceWorkers()
  const liveSw = workers.find((w) => w.url().startsWith('chrome-extension://'))
  if (liveSw && liveSw !== currentSw) {
    await installReadinessObserver(liveSw)
    return liveSw
  }
  return currentSw
}

/** Check a chat-container selector's visibility — at least one matching
 *  instance must be visible on screen. */
async function hasVisibleContainer(page: Page, sel: string): Promise<boolean> {
  const count = await page.locator(sel).count()
  if (count === 0) return false
  for (let i = 0; i < count; i++) {
    if (await page.locator(sel).nth(i).isVisible().catch(() => false)) return true
  }
  return false
}

/** Records which fallback selectors matched visible containers, iterating
 *  every visible container instance. Reports per-selector accuracy. */
async function recordSelectorOutcomes(page: Page): Promise<SelectorMatch[]> {
  const results: SelectorMatch[] = []

  for (const sel of FALLBACKS[CHAT_CONTAINER]) {
    const visible = await hasVisibleContainer(page, sel)
    results.push({ group: 'chat_container', selector: sel, matched: visible })
  }

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
    let currentSw: Worker = serviceWorker

    // Install on initial SW and on any replacement worker immediately.
    // The callback awaits the observer install so the listener is active
    // before the worker can process any runtime messages.
    await installReadinessObserver(currentSw)
    context.on('serviceworker', async (sw) => {
      if (sw.url().startsWith('chrome-extension://')) {
        await installReadinessObserver(sw).catch(() => undefined)
      }
    })

    try {
      page = await context.newPage()

      await page.goto(CANARY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await dismissOverlays(page)

      selectorResults.push(...await recordSelectorOutcomes(page))

      // --- Assertion: chat_container_ready diagnostic observed ---
      // The 20-entry ring can overflow. On each poll we reacquire the live
      // SW (Chromium may have terminated and restarted it) and reinstall the
      // observer, then check both the ring and the permanent storage flag.
      await expect(async () => {
        currentSw = await ensureReadinessObserver(context, currentSw)
        const events = await getDiagnosticsEvents(currentSw)
        const inRing = events.some((e) => e.stage === 'chat_container_ready')
        const flagged = await currentSw.evaluate(async () => {
          const data = await chrome.storage.session.get('canary_chat_container_ready')
          return data.canary_chat_container_ready === true
        })
        expect(inRing || flagged).toBe(true)
      }).toPass({ timeout: 30_000 })

      // Refresh selector snapshot
      selectorResults.length = 0
      selectorResults.push(...await recordSelectorOutcomes(page))

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
        await attachCanaryArtifacts(testInfo, page, currentSw, errorSummary.texts, selectorResults, {
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
