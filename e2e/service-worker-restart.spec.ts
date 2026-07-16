/**
 * E2E test: translation recovers after MV3 Service Worker termination.
 *
 * Verifies that the packaged Content Script can translate a new message
 * after Chromium terminates and restarts the Extension Service Worker.
 *
 * This is NOT simulated restart — the test uses CDP to close the actual
 * SW target, then proves the next chat message wakes a functional worker.
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
import { setupDeepSeekMock, DEEPSEEK_MOCK_KEY } from './fixtures/deepseek-mock'
import { terminateExtensionServiceWorker } from './fixtures/service-worker'

test.describe('Service Worker restart recovery', () => {
  test('translation succeeds before and after SW termination via CDP', async ({
    context,
    serviceWorker: initialSw,
    extensionId,
    collectedErrors,
  }, testInfo) => {
    testInfo.setTimeout(90_000)

    let page: Page | undefined

    try {
      // --- Extension readiness ---
      expect(initialSw).toBeDefined()
      expect(extensionId).toMatch(/^[a-z]{32}$/)

      // --- Seed DeepSeek settings and fake key ---
      await seedDeepSeekTestSettings(initialSw)

      // --- Register route handlers ---

      // Synthetic Twitch document
      const html = getTwitchChatHtml()
      await context.route(TWITCH_URL, async (route) => {
        await route.fulfill({ body: html, contentType: 'text/html' })
      })

      // DeepSeek mock returning different translations per message
      const { calls } = await setupDeepSeekMock(context, {
        translations: {
          'before restart': '重新啟動前',
          'after restart': '重新啟動後',
        },
      })

      // --- Navigate to synthetic Twitch page ---
      page = await context.newPage()
      await page.goto(TWITCH_URL, { waitUntil: 'domcontentloaded' })

      expect(page.url()).toBe(TWITCH_URL)

      // --- Wait for Content Script to report chat container ready ---
      await expect(async () => {
        const events = await getDiagnosticsEvents(initialSw)
        expect(events.some((e) => e.stage === 'chat_container_ready')).toBe(true)
      }).toPass({ timeout: 15_000 })

      // ================================================================
      //  PHASE 1: First translation (before SW termination)
      // ================================================================

      // --- Append first source message ---
      await page.evaluate(
        ({ text }: { text: string; username: string }) => {
          return (window as unknown as Record<string, unknown>).appendChatMessage(
            text,
            'e2e_user',
          )
        },
        { text: 'before restart', username: 'e2e_user' },
      )

      // --- Assert exactly one provider call ---
      await expect(async () => {
        expect(calls).toHaveLength(1)
      }).toPass({ timeout: 10_000 })

      await expect(calls[0]!.serviceWorkerOwned).toBe(true)

      // --- Assert original body text remains visible ---
      const firstMessage = page.locator('.chat-line__message').first()
      await expect(firstMessage).toContainText('before restart')

      // --- Assert first translated DOM is injected ---
      const translated = page.locator('[data-tachi-lens-translated]')
      await expect(translated).toHaveCount(1)
      await expect(translated.first()).toHaveText('重新啟動前')

      // --- Assert the first translated element is inside its message root ---
      const translatedFirstInside = firstMessage.locator('[data-tachi-lens-translated]')
      await expect(translatedFirstInside).toHaveCount(1)

      // --- Assert first message is marked processed ---
      await expect(firstMessage).toHaveAttribute('data-tachi-lens-processed', 'true')

      // ================================================================
      //  PHASE 2: Terminate the Service Worker via CDP
      // ================================================================

      await terminateExtensionServiceWorker(context, extensionId, page)

      // --- Assert prior translated DOM remains on the page ---
      await expect(translated).toHaveCount(1)
      await expect(translated.first()).toHaveText('重新啟動前')

      // ================================================================
      //  PHASE 3: Second translation (after SW restart)
      // ================================================================

      // --- Append second source message without reloading the page ---
      await page.evaluate(
        ({ text }: { text: string; username: string }) => {
          return (window as unknown as Record<string, unknown>).appendChatMessage(
            text,
            'e2e_user',
          )
        },
        { text: 'after restart', username: 'e2e_user' },
      )

      // --- Allow chrome.runtime.sendMessage to wake the SW ---
      // The second translation succeeding proves the SW restarted
      // and reused persisted settings + API key without reseeding.

      // --- Assert second translated text is injected ---
      await expect(async () => {
        expect(calls).toHaveLength(2)
      }).toPass({ timeout: 15_000 })

      // Verify both translated elements exist
      await expect(translated).toHaveCount(2)

      // --- Assert both messages have correct translations ---
      await expect(translated.first()).toHaveText('重新啟動前')
      await expect(translated.last()).toHaveText('重新啟動後')

      // --- Assert both message roots are present ---
      const messages = page.locator('.chat-line__message')
      await expect(messages).toHaveCount(2)

      // --- Assert both messages are marked processed ---
      await expect(messages.nth(0)).toHaveAttribute('data-tachi-lens-processed', 'true')
      await expect(messages.nth(1)).toHaveAttribute('data-tachi-lens-processed', 'true')

      // --- Assert each message has exactly one translated descendant ---
      await expect(messages.nth(0).locator('[data-tachi-lens-translated]')).toHaveCount(1)
      await expect(messages.nth(1).locator('[data-tachi-lens-translated]')).toHaveCount(1)

      // ================================================================
      //  PHASE 4: Verify persistence and no errors
      // ================================================================

      // --- Assert total provider calls is exactly 2 ---
      expect(calls).toHaveLength(2)

      // --- Assert settings and API key persisted without reseeding ---
      // After restart the new SW should still have the original settings
      await expect(async () => {
        for (const sw of context.serviceWorkers()) {
          try {
            const stored = await sw.evaluate(() =>
              chrome.storage.local.get(['userSettings', 'providerApiKeys']),
            )
            const userSettings = stored.userSettings as Record<string, unknown> | undefined
            const apiKeys = stored.providerApiKeys as Record<string, string> | undefined
            expect(userSettings?.translationEnabled).toBe(true)
            expect(userSettings?.selectedProvider).toBe('deepseek')
            expect(userSettings?.selectedModel).toBe('deepseek-v4-flash')
            expect(apiKeys?.deepseek).toBe(DEEPSEEK_MOCK_KEY)
            return // success
          } catch {
            // SW may still be starting — try next worker
          }
        }
        throw new Error('No responsive Service Worker found with persisted settings')
      }).toPass({ timeout: 10_000 })

      // --- Fail on any collected errors ---
      expect(collectedErrors).toEqual([])
    } catch (err) {
      if (page) {
        await attachDebugArtifacts(testInfo, page, initialSw, collectedErrors)
        // Attach provider request history on failure
        await testInfo
          .attach('provider-calls', {
            body: JSON.stringify(calls, null, 2),
            contentType: 'application/json',
          })
          .catch(() => undefined)
      }
      throw err
    }
  })
})
