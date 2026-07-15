/**
 * E2E test: Content Script injection and chat message processing.
 *
 * Verifies that the packaged Content Script is injected by Chromium on a
 * synthetic Twitch page, observes a newly inserted chat message, obtains
 * settings through the real MV3 Service Worker, and marks the message as
 * processed without injecting translated DOM (translation disabled).
 *
 * Failure diagnostics (page URL, chat HTML, diagnostics, console errors) are
 * attached reliably via try/catch before the original error is re-thrown.
 */
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { test } from './fixtures/extension'
import {
  TWITCH_URL,
  seedTestSettings,
  getDiagnosticsEvents,
  attachDebugArtifacts,
} from './fixtures/twitch-page'
import { getTwitchChatHtml } from './fixtures/twitch-chat'

test.describe('Content Script injection smoke test', () => {
  test('loads on Twitch origin, observes chat, marks processed without translated DOM', async ({
    context,
    serviceWorker,
    extensionId,
    collectedErrors,
  }, testInfo) => {
    let page: Page | undefined

    try {
      // Verify the extension is up before proceeding
      expect(serviceWorker).toBeDefined()
      expect(extensionId).toMatch(/^[a-z]{32}$/)

      // --- Seed settings ---
      await seedTestSettings(serviceWorker)

      // --- Route the synthetic Twitch URL ---
      const html = getTwitchChatHtml()
      await context.route(TWITCH_URL, async (route) => {
        await route.fulfill({ body: html, contentType: 'text/html' })
      })

      // --- Open a page on the synthetic URL ---
      page = await context.newPage()
      await page.goto(TWITCH_URL, { waitUntil: 'domcontentloaded' })

      // Verify the synthetic URL is preserved
      expect(page.url()).toBe(TWITCH_URL)

      // --- Wait for Content Script to report chat container ready ---
      await expect(async () => {
        const events = await getDiagnosticsEvents(serviceWorker)
        expect(events.some((e) => e.stage === 'chat_container_ready')).toBe(true)
      }).toPass({ timeout: 15_000 })

      // --- Append a chat message via the page helper ---
      const messageText = 'Hello tachi-lens!'
      await page.evaluate(
        ({ text, username }: { text: string; username: string }) => {
          return (window as unknown as Record<string, unknown>).appendChatMessage(
            text,
            username,
          )
        },
        { text: messageText, username: 'e2e_user' },
      )

      // --- Assert the Content Script marks the message as processed ---
      const message = page.locator('.chat-line__message').last()
      await expect(message).toHaveAttribute('data-tachi-lens-processed', 'true', {
        timeout: 10_000,
      })

      // --- Assert no translated DOM element is inserted ---
      const translated = page.locator('[data-tachi-lens-translated]')
      await expect(translated).toHaveCount(0)

      // --- Assert diagnostics confirm the translation-disabled skip path ---
      await expect(async () => {
        const events = await getDiagnosticsEvents(serviceWorker)
        expect(events.some((e) => e.stage === 'message_skipped' && e.detail === '翻譯功能已關閉')).toBe(true)
        expect(events.some((e) => e.stage === 'translation_requested')).toBe(false)
        expect(events.some((e) => e.stage === 'translation_failed')).toBe(false)
      }).toPass({ timeout: 10_000 })

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
