/**
 * E2E test: mocked DeepSeek end-to-end translation happy path.
 *
 * Proves the complete packaged Extension happy path in a real Chromium session:
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
 * Must not call the real DeepSeek API or require internet access.
 */
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { test } from './fixtures/extension'
import {
  TWITCH_URL,
  seedE2ETranslationSettings,
  getDiagnosticsEvents,
  attachDebugArtifacts,
} from './fixtures/twitch-page'
import { getTwitchChatHtml } from './fixtures/twitch-chat'
import { DeepSeekMock } from './fixtures/deepseek-mock'

test.describe('DeepSeek translation happy path', () => {
  test('translates a single chat message end-to-end through the real Extension, Service Worker, and mocked DeepSeek provider', async ({
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

      // --- Establish network isolation before any page navigation ---
      // Block unexpected provider requests at the context level. The
      // DeepSeekMock route (registered after these) handles its own
      // completions endpoint, so its specific route takes priority.
      for (const pattern of [
        'https://generativelanguage.googleapis.com/**',
        'https://api.openai.com/**',
        'https://api.anthropic.com/**',
      ]) {
        await context.route(pattern, async (route) => {
          await route.abort('blockedbyclient')
        })
      }

      // --- Seed settings with translation enabled and fake DeepSeek key ---
      await seedE2ETranslationSettings(serviceWorker)

      // --- Install the DeepSeek mock route (intercepts SW-owned requests) ---
      const deepseekMock = new DeepSeekMock('你好，世界')
      await deepseekMock.install(context)

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

      // --- Wait for the Content Script to process the message ---
      const message = page.locator('.chat-line__message').last()
      await expect(message).toHaveAttribute('data-tachi-lens-processed', 'true', {
        timeout: 15_000,
      })

      // --- Assert exactly one DeepSeek completion request was made ---
      expect(deepseekMock.callCount).toBe(1)

      // --- Assert original text remains visible ---
      const bodyElements = message.locator('[data-a-target="chat-line-message-body"]')
      await expect(bodyElements).toHaveText(messageText)

      // --- Assert the translated text is injected exactly once ---
      const translated = message.locator('[data-tachi-lens-translated="true"]')
      await expect(translated).toHaveCount(1)
      await expect(translated).toHaveText('你好，世界')

      // --- Assert no second provider call for the same untouched DOM node ---
      await page.waitForTimeout(2_000)
      expect(deepseekMock.callCount).toBe(1)

      // --- Assert diagnostics confirm the full happy path ---
      await expect(async () => {
        const events = await getDiagnosticsEvents(serviceWorker)
        expect(events.some((e) => e.stage === 'translation_requested')).toBe(true)
        expect(events.some((e) => e.stage === 'translation_received')).toBe(true)
        expect(events.some((e) => e.stage === 'translation_injected')).toBe(true)
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
