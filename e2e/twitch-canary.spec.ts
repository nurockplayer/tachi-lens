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

// --- Module-level configuration validation ---
// All checks run before any Playwright context is created so the user gets
// a clear configuration error immediately.

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

// Provider hosts monitored during the canary — any attempted request fails the test.
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

/**
 * Optional defensive dismiss of Twitch consent overlay.
 * Each check is bounded and individually caught so a missing overlay is never
 * a failure. Scoped to specific known consent/age-verification dialog selectors.
 */
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

/**
 * Find the first container selector that has at least one matching element.
 */
async function findFirstMatchingContainer(page: Page): Promise<string | null> {
  for (const sel of FALLBACKS[CHAT_CONTAINER]) {
    if ((await page.locator(sel).count()) > 0) return sel
  }
  return null
}

test.describe('Real Twitch DOM compatibility canary', () => {
  test('Extension attaches, finds chat container and real messages, no provider', async ({
    context,
    serviceWorker,
    extensionId,
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

    // --- Seed settings: translation disabled, no API key, minTextLength: 1 ---
    await seedTestSettings(serviceWorker)

    // --- Collect Extension Service Worker errors only ---
    // Real Twitch pages produce third-party console noise, so the canary
    // limits error collection to the Extension's background worker.
    const swErrors: string[] = []
    const attachSwConsole = (worker: { on: (event: string, fn: (msg: { type: () => string; text: () => string }) => void) => void }): void => {
      worker.on('console', (msg) => {
        if (msg.type() === 'error') swErrors.push(msg.text())
      })
    }
    for (const sw of context.serviceWorkers()) {
      attachSwConsole(sw)
    }
    context.on('serviceworker', (sw) => {
      attachSwConsole(sw)
    })

    const selectorResults: SelectorMatch[] = []
    let page: Page | undefined

    try {
      page = await context.newPage()

      // --- Navigate to real Twitch ---
      await page.goto(CANARY_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })

      // Optional dismiss of known consent overlays
      await dismissOverlays(page)

      // --- Assertion 1: chat_container_ready diagnostic observed ---
      await expect(async () => {
        const events = await getDiagnosticsEvents(serviceWorker)
        expect(events.some((e) => e.stage === 'chat_container_ready')).toBe(true)
      }).toPass({ timeout: 25_000 })

      // --- Assertions 2-5: Full selector chain within one real message ---
      // Find the first matching container, then locate at least one message
      // root within it that also contains a username and body within that
      // same root. This proves the complete selector chain on a single real
      // Twitch chat message, not a mix of matches across different elements.
      const containerSel = await findFirstMatchingContainer(page)
      expect(containerSel, 'Expected at least one chat container selector to match').not.toBeNull()

      // Record container selector results
      for (const sel of FALLBACKS[CHAT_CONTAINER]) {
        const count = await page.locator(sel).count()
        selectorResults.push({ group: 'chat_container', selector: sel, matched: count > 0 })
      }

      // Bounded wait for a real message with full selector chain:
      // within the matching container, find a message root that has both
      // username and body via the production fallback selectors.
      const messageFallbacks = FALLBACKS[CHAT_MESSAGE]
      const usernameFallbacks = FALLBACKS[CHAT_USERNAME]
      const bodyFallbacks = FALLBACKS[CHAT_MESSAGE_BODY]
      const container = page.locator(containerSel!).first()

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
                if (text?.trim()) return // full chain proven
              }
            }
          }
        }
        expect(false).toBe(true) // no complete chain yet
      }).toPass({ timeout: 25_000 })

      // Record diagnostic selector mapping (may miss which fallback specifically,
      // but confirms at least one per group is present)
      for (const msgSel of messageFallbacks) {
        const count = await container.locator(msgSel).count()
        selectorResults.push({ group: 'chat_message', selector: msgSel, matched: count > 0 })
      }
      for (const uSel of usernameFallbacks) {
        const count = await page.locator(uSel).count()
        selectorResults.push({ group: 'chat_username', selector: uSel, matched: count > 0 })
      }
      for (const bSel of bodyFallbacks) {
        const count = await page.locator(bSel).count()
        selectorResults.push({ group: 'chat_body', selector: bSel, matched: count > 0 })
      }

      // --- Assertion: No provider requests were attempted ---
      expect(providerRequests).toEqual([])

      // --- Assertion: No Extension Service Worker errors ---
      expect(swErrors).toEqual([])
    } catch (err) {
      if (page) {
        await attachCanaryArtifacts(
          testInfo,
          page,
          serviceWorker,
          swErrors,
          selectorResults,
        )
      }
      throw err
    }
  })
})

/**
 * Privacy-conscious failure attachment for the canary.
 *
 * Attachments are limited to non-content artifacts:
 * - page URL
 * - selector match results (which fallback selectors matched)
 * - diagnostics (privacy-safe stage identifiers only)
 * - SW runtime errors (not Twitch page errors)
 *
 * Never includes: chat text, usernames, full DOM dumps, cookies,
 * browser profile, storage contents, or authorization headers.
 */
async function attachCanaryArtifacts(
  testInfo: TestInfo,
  page: Page,
  serviceWorker: { evaluate: <T>(fn: (args: void) => Promise<T>) => Promise<T> },
  swErrors: string[],
  selectorResults: SelectorMatch[],
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

  // Diagnostics from the privacy-safe event stream (no chat text or usernames)
  const events = await getDiagnosticsEvents(serviceWorker).catch((): [] => [])
  if (events.length > 0) {
    await testInfo
      .attach('diagnostics', {
        body: JSON.stringify(events, null, 2),
        contentType: 'application/json',
      })
      .catch(() => undefined)
  }

  // SW runtime errors only (no real Twitch page console noise)
  if (swErrors.length > 0) {
    await testInfo
      .attach('runtime-errors', {
        body: JSON.stringify(swErrors, null, 2),
        contentType: 'application/json',
      })
      .catch(() => undefined)
  }
}
