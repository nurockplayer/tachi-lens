/**
 * E2E test: DeepSeek translation happy path.
 *
 * Verifies the complete packaged Extension flow in a real Chromium session:
 *
 *   synthetic Twitch DOM
 *     -> packaged Content Script
 *     -> chrome.runtime messaging
 *     -> packaged MV3 Service Worker
 *     -> Translator batching
 *     -> DeepSeek provider HTTP request
 *     -> mocked provider response
 *     -> translated DOM injection
 *
 * Does not call the real DeepSeek API. Network isolation guarantees no
 * uncontrolled requests.
 */
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { test } from './fixtures/extension'
import {
  TWITCH_URL,
  seedDeepSeekTestSettings,
  getDiagnosticsEvents,
  attachDebugArtifacts,
} from './fixtures/twitch-page'
import { getTwitchChatHtml } from './fixtures/twitch-chat'
import { setupDeepSeekMock } from './fixtures/deepseek-mock'

test.describe('DeepSeek translation happy path', () => {
  test('full Extension pipeline translates a chat message via mocked DeepSeek', async ({
    context,
    serviceWorker,
    extensionId,
    collectedErrors,
  }, testInfo) => {
    let page: Page | undefined

    try {
      // --- Extension readiness ---
      expect(serviceWorker).toBeDefined()
      expect(extensionId).toMatch(/^[a-z]{32}$/)

      // --- Seed settings and fake API key ---
      await seedDeepSeekTestSettings(serviceWorker)

      // --- Register route handlers before navigation ---

      // Synthetic Twitch document from #67
      const html = getTwitchChatHtml()
      await context.route(TWITCH_URL, async (route) => {
        await route.fulfill({ body: html, contentType: 'text/html' })
      })

      // DeepSeek mock with request validation
      const { calls } = await setupDeepSeekMock(context)

      // --- Navigate to synthetic Twitch page ---
      page = await context.newPage()
      await page.goto(TWITCH_URL, { waitUntil: 'domcontentloaded' })

      expect(page.url()).toBe(TWITCH_URL)

      // --- Wait for Content Script to report chat container ready ---
      await expect(async () => {
        const events = await getDiagnosticsEvents(serviceWorker)
        expect(events.some((e) => e.stage === 'chat_container_ready')).toBe(true)
      }).toPass({ timeout: 15_000 })

      // --- Append a chat message ---
      const messageText = 'Hello world'
      await page.evaluate(
        ({ text, username }: { text: string; username: string }) => {
          return (window as unknown as Record<string, unknown>).appendChatMessage(
            text,
            username,
          )
        },
        { text: messageText, username: 'e2e_user' },
      )

      // --- Assert exactly one DeepSeek request was made ---
      await expect(async () => {
        expect(calls).toHaveLength(1)
      }).toPass({ timeout: 10_000 })

      // --- Assert the request is Service Worker-owned ---
      expect(calls[0]!.serviceWorkerOwned).toBe(true)

      // --- Assert the original body text remains visible ---
      const message = page.locator('.chat-line__message').last()
      await expect(message).toContainText('Hello world')

      // --- Assert translated DOM is injected ---
      const translated = page.locator('[data-tachi-lens-translated]')
      await expect(translated).toHaveCount(1)
      await expect(translated).toHaveText('你好，世界')

      // --- Assert the translated element is inside the chat message root ---
      const translatedInside = message.locator('[data-tachi-lens-translated]')
      await expect(translatedInside).toHaveCount(1)

      // --- Assert the message is marked processed ---
      await expect(message).toHaveAttribute('data-tachi-lens-processed', 'true')

      // --- Assert no second provider call occurs for the same untouched DOM node ---
      // Wait through a full retry-timer cycle (5 s) using auto-waiting.
      await expect(async () => {
        expect(calls).toHaveLength(1)
      }).toPass({ timeout: 7_000 })

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
