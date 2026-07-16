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
          // Remove comment nodes
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

  // If no container found, deeper selectors can't be checked
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
    // Exercise the actual sanitizeContainerHtml function on a real page
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

    // --- Seed settings ---
    await seedTestSettings(serviceWorker)

    // --- Collect Service Worker errors only ---
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
      await dismissOverlays(page)

      // Record ALL selector outcomes early (so failure evidence captures
      // match status even on diagnostic timeout or container absence).
      selectorResults.push(...await recordSelectorOutcomes(page))

      // --- Assertion 1: chat_container_ready diagnostic observed ---
      await expect(async () => {
        const events = await getDiagnosticsEvents(serviceWorker)
        expect(events.some((e) => e.stage === 'chat_container_ready')).toBe(true)
      }).toPass({ timeout: 25_000 })

      // Refresh selector outcomes: by now Twitch chat has rendered and
      // the Content Script has recorded its diagnostic, so this snapshot
      // reflects the page at chain-assertion time.
      selectorResults.length = 0
      selectorResults.push(...await recordSelectorOutcomes(page))

      // --- Assertions 2-5: Full selector chain within one real message ---
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
                if (text?.trim()) return // full chain proven
              }
            }
          }
        }
        expect(false).toBe(true)
      }).toPass({ timeout: 25_000 })

      // --- Assertion: No provider requests ---
      expect(providerRequests).toEqual([])

      // --- Assertion: No SW errors ---
      expect(swErrors).toEqual([])
    } catch (err) {
      if (page) {
        await attachCanaryArtifacts(testInfo, page, serviceWorker, swErrors, selectorResults)
      }
      throw err
    }
  })
})

/**
 * Privacy-conscious failure attachment for the canary.
 *
 * Artifacts match issue #73 evidence spec:
 * - Playwright trace (from config; captures full page state on failure)
 * - screenshot (from config; captures visible page state on failure)
 * - HTML report (from config reporter)
 * - page URL
 * - selector results (which fallback selectors matched)
 * - diagnostics (privacy-safe stage identifiers)
 * - Service Worker error logs
 * - sanitized outer-HTML excerpt around the chat container
 *
 * Trace and screenshot are explicitly required by the issue for failure diagnosis
 * and may contain rendered chat text and network metadata — that is an accepted
 * trade-off. The privacy boundary prohibits upload of: cookies, browser profile,
 * storage dumps, full chat history beyond the sanitized excerpt, and
 * authorization headers. No such data is attached by this handler.
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

  // Diagnostics (privacy-safe — no chat text or usernames)
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
  // Sanitized inside the browser via page.evaluate, so text content
  // is stripped and only allowed attributes remain before truncation.
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

  if (swErrors.length > 0) {
    await testInfo
      .attach('sw-errors', {
        body: JSON.stringify(swErrors, null, 2),
        contentType: 'application/json',
      })
      .catch(() => undefined)
  }
}
