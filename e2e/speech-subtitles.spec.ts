/**
 * E2E test: Twitch speech subtitle overlay (v0.3, Spec §6/§10).
 *
 * Deterministic — no live provider, no real tabCapture. Settings are seeded via
 * chrome.storage.local (mirroring twitch-page.ts), provider HTTP is routed to
 * abort (no network), and speech messages are pushed from the SW context into
 * the real content script via chrome.tabs.sendMessage (the same mechanism the
 * packaged service-worker.ts uses in broadcastToContentScripts).
 *
 * Asserts:
 *   - the shadow-root overlay mounts on document.body
 *   - interim → final flips opacity/class
 *   - the error chip shows only the sanitized fixed i18n key and auto-hides
 *   - the overlay is removed on idle
 */
import { expect } from '@playwright/test'
import type { Page, Worker } from '@playwright/test'
import { test } from './fixtures/extension'
import {
  TWITCH_URL,
  getDiagnosticsEvents,
  attachDebugArtifacts,
} from './fixtures/twitch-page'
import { getTwitchChatHtml } from './fixtures/twitch-chat'

const HOST_SELECTOR = '[data-tachi-lens-subtitle-overlay]'

/** Seed speech settings so the overlay starts with captionMaxLines=2, opacity=100. */
const seedSpeechSettings = async (serviceWorker: Worker): Promise<void> => {
  await serviceWorker.evaluate(() => {
    return chrome.storage.local.set({
      userSettings: {
        selectedProvider: 'deepseek',
        selectedModel: 'deepseek-v4-flash',
        targetLanguage: 'zh-TW',
        displayMode: 'below',
        botNameBlacklist: [],
        minTextLength: 1,
        translationEnabled: false,
        speechConfig: {
          speechEnabled: true,
          speechProvider: 'gemini',
          speechModel: 'gemini-2.5-flash',
          speechTargetLanguage: 'zh-TW',
          captionMaxLines: 2,
          captionOpacity: 100,
          maxSessionMinutes: 30,
        },
      },
    })
  })
}

/**
 * Push a message from the SW context to every content script tab, mirroring the
 * packaged broadcastToContentScripts pattern (service-worker.ts).
 */
const broadcastFromSw = async (serviceWorker: Worker, message: unknown): Promise<void> => {
  await serviceWorker.evaluate(async (msg) => {
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        await chrome.tabs.sendMessage(tab.id, msg).catch(() => undefined)
      }
    }
  }, message)
}

test.describe('Speech subtitle overlay', () => {
  test('renders captions, flips interim→final, sanitizes errors, and clears on idle', async ({
    context,
    serviceWorker,
    extensionId,
    collectedErrors,
  }, testInfo) => {
    let page: Page | undefined

    try {
      testInfo.setTimeout(60_000)

      expect(serviceWorker).toBeDefined()
      expect(extensionId).toMatch(/^[a-z]{32}$/)

      // --- Seed speech settings (no API key, translation disabled) ---
      await seedSpeechSettings(serviceWorker)

      // --- Route synthetic Twitch page + abort any provider HTTP ---
      const html = getTwitchChatHtml()
      await context.route(TWITCH_URL, async (route) => {
        await route.fulfill({ body: html, contentType: 'text/html' })
      })
      await context.route('https://generativelanguage.googleapis.com/**', async (route) => {
        await route.abort('blockedbyclient')
      })
      await context.route('https://api.deepseek.com/**', async (route) => {
        await route.abort('blockedbyclient')
      })

      page = await context.newPage()
      await page.goto(TWITCH_URL, { waitUntil: 'domcontentloaded' })
      expect(page.url()).toBe(TWITCH_URL)

      // --- Wait for Content Script readiness (chat container observed) ---
      await expect(async () => {
        const events = await getDiagnosticsEvents(serviceWorker)
        expect(events.some((e) => e.stage === 'chat_container_ready')).toBe(true)
      }).toPass({ timeout: 15_000 })

      const overlayHost = page.locator(HOST_SELECTOR)

      // --- Overlay mounts on speech_state capturing ---
      await broadcastFromSw(serviceWorker, {
        type: 'speech_state',
        payload: { state: 'capturing' },
      })
      await expect(overlayHost).toHaveCount(1, { timeout: 10_000 })
      expect(await overlayHost.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')

      // --- Interim caption renders untranslated at reduced opacity ---
      await broadcastFromSw(serviceWorker, {
        type: 'speech_caption',
        payload: { id: 'c-int', text: 'draft subtitle', interim: true },
      })
      const interimRow = page.locator(
        `${HOST_SELECTOR} .tachi-lens-caption-row`,
      )
      await expect(interimRow).toHaveCount(1, { timeout: 10_000 })
      await expect(interimRow).toHaveText('draft subtitle')
      await expect(interimRow).toHaveClass(/interim/)
      expect(await interimRow.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.55')

      // --- Final caption flips the same row to final styling / full opacity ---
      await broadcastFromSw(serviceWorker, {
        type: 'speech_caption',
        payload: { id: 'c-fin', text: '已翻譯字幕', interim: false },
      })
      await expect(interimRow).toHaveCount(1, { timeout: 10_000 })
      await expect(interimRow).toHaveText('已翻譯字幕')
      await expect(interimRow).toHaveClass(/final/)
      expect(await interimRow.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')

      // --- Error chip shows only the sanitized fixed i18n key, then auto-hides ---
      await broadcastFromSw(serviceWorker, {
        type: 'speech_state',
        payload: { state: 'error', errorKey: 'speechErrorAuth' },
      })
      const errorChip = page.locator(
        `${HOST_SELECTOR} .tachi-lens-error-chip`,
      )
      await expect(errorChip).toHaveCount(1, { timeout: 10_000 })

      // The chip resolves the fixed key through chrome.i18n (locale-dependent,
      // default en). Compare against the SW-resolved value so the assertion is
      // deterministic regardless of the browser locale.
      const expectedErrorText = await serviceWorker.evaluate(() => {
        return chrome.i18n.getMessage('speechErrorAuth')
      })
      expect(typeof expectedErrorText).toBe('string')
      expect((expectedErrorText as string).length).toBeGreaterThan(0)
      await expect(errorChip).toHaveText(expectedErrorText as string, { timeout: 10_000 })
      await expect(errorChip).not.toHaveClass(/hidden/)

      // No raw provider text or transcript ever appears in the overlay DOM.
      const overlayText = await overlayHost.evaluate((el) => el.shadowRoot?.textContent ?? '')
      expect(overlayText).not.toContain('draft subtitle')

      await broadcastFromSw(serviceWorker, {
        type: 'speech_state',
        payload: { state: 'capturing' },
      })
      await expect(errorChip).toHaveClass(/hidden/, { timeout: 10_000 })

      // --- idle removes the overlay entirely ---
      await broadcastFromSw(serviceWorker, {
        type: 'speech_state',
        payload: { state: 'idle' },
      })
      await expect(overlayHost).toHaveCount(0, { timeout: 10_000 })

      // --- Fail on any collected errors ---
      expect(collectedErrors).toEqual([])
    } catch (err) {
      if (page) {
        await attachDebugArtifacts(testInfo, page, serviceWorker, collectedErrors)
      }
      throw err
    }
  })
})
