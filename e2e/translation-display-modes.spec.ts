/**
 * E2E test: translation display modes (below, hover, collapse).
 *
 * Verifies user-visible rendering semantics for all three display modes
 * using the packaged Extension, deterministic Twitch fixture, and the
 * mocked DeepSeek transport from #68.
 *
 * Each mode runs in a fresh isolated page context.
 */
import { expect } from '@playwright/test'
import type { BrowserContext, Page, Worker } from '@playwright/test'
import { test } from './fixtures/extension'
import {
  TWITCH_URL,
  seedDeepSeekTestSettings,
  getDiagnosticsEvents,
  attachDebugArtifacts,
} from './fixtures/twitch-page'
import { getTwitchChatHtml } from './fixtures/twitch-chat'
import { setupDeepSeekMock } from './fixtures/deepseek-mock'

const MESSAGE_TEXT = 'Hello world'
const TRANSLATED_TEXT = '你好，世界'

test.describe('Translation display modes', () => {
  /**
   * Shared setup for each display mode case:
   * 1. Seed settings with the given displayMode
   * 2. Route synthetic Twitch document
   * 3. Route deterministic DeepSeek mock
   * 4. Navigate and wait for Content Script readiness
   * 5. Append one chat message through real MutationObserver path
   */
  async function setupDisplayModeTest(
    context: BrowserContext,
    serviceWorker: Worker,
    displayMode: string,
  ): Promise<{ page: Page; calls: { requestId: string; messageText: string; serviceWorkerOwned: boolean }[] }> {
    await seedDeepSeekTestSettings(serviceWorker, displayMode)

    const html = getTwitchChatHtml()
    await context.route(TWITCH_URL, async (route) => {
      await route.fulfill({ body: html, contentType: 'text/html' })
    })

    const { calls } = await setupDeepSeekMock(context)

    const page = await context.newPage()
    await page.goto(TWITCH_URL, { waitUntil: 'domcontentloaded' })
    expect(page.url()).toBe(TWITCH_URL)

    // Wait for Content Script to report chat container ready
    await expect(async () => {
      const events = await getDiagnosticsEvents(serviceWorker)
      expect(events.some((e) => e.stage === 'chat_container_ready')).toBe(true)
    }).toPass({ timeout: 15_000 })

    // Append one chat message through the real MutationObserver path
    await page.evaluate(
      ({ text, username }: { text: string; username: string }) => {
        return (window as unknown as Record<string, unknown>).appendChatMessage(
          text,
          username,
        )
      },
      { text: MESSAGE_TEXT, username: 'e2e_user' },
    )

    return { page, calls }
  }

  test('below mode shows translation immediately after original text', async ({
    context,
    serviceWorker,
    collectedErrors,
  }, testInfo) => {
    testInfo.setTimeout(60_000)

    let page: Page | undefined
    try {
      const result = await setupDisplayModeTest(context, serviceWorker, 'below')
      page = result.page
      const calls = result.calls

      // --- Assert exactly one DeepSeek request ---
      await expect(async () => {
        expect(calls).toHaveLength(1)
      }).toPass({ timeout: 10_000 })

      await expect(calls[0]!.serviceWorkerOwned).toBe(true)

      // --- Assert original message body remains visible ---
      const message = page.locator('.chat-line__message').last()
      const messageBody = page.locator('[data-a-target="chat-line-message-body"]')
      await expect(messageBody).toBeVisible()
      await expect(message).toContainText(MESSAGE_TEXT)

      // --- Assert translated element is visible without interaction ---
      const translated = page.locator('[data-tachi-lens-translated]')
      await expect(translated).toHaveCount(1)
      await expect(translated).toBeVisible()
      await expect(translated).toHaveText(TRANSLATED_TEXT)

      // --- Assert translated element is a descendant of the same message root ---
      const translatedInside = message.locator('[data-tachi-lens-translated]')
      await expect(translatedInside).toHaveCount(1)

      // --- Assert translated text appears after original message body in DOM order ---
      await expect(messageBody).toHaveText(MESSAGE_TEXT)
      const bodyIndex = await message.evaluate((el) =>
        Array.from(el.children).indexOf(
          el.querySelector('[data-a-target="chat-line-message-body"]')!,
        ),
      )
      const translatedIndex = await message.evaluate((el) =>
        Array.from(el.children).indexOf(
          el.querySelector('[data-tachi-lens-translated]')!,
        ),
      )
      expect(translatedIndex).toBeGreaterThan(bodyIndex)

      // --- Assert clicking or hovering does not hide the original text ---
      await message.hover()
      await expect(messageBody).toBeVisible()
      await expect(messageBody).toHaveText(MESSAGE_TEXT)

      // --- Assert message root is marked processed ---
      await expect(message).toHaveAttribute('data-tachi-lens-processed', 'true')

      // --- Assert exactly one translated descendant ---
      await expect(translated).toHaveCount(1)

      // --- Assert no second provider call during stability window ---
      await page.waitForTimeout(6_000)
      expect(calls).toHaveLength(1)

      // --- Fail on any collected errors ---
      expect(collectedErrors).toEqual([])
    } catch (err) {
      if (page) {
        await attachDebugArtifacts(testInfo, page, serviceWorker, collectedErrors)
      }
      throw err
    }
  })

  test('hover mode shows translation only during pointer hover', async ({
    context,
    serviceWorker,
    collectedErrors,
  }, testInfo) => {
    testInfo.setTimeout(60_000)

    let page: Page | undefined
    try {
      const result = await setupDisplayModeTest(context, serviceWorker, 'hover')
      page = result.page
      const calls = result.calls

      // --- Assert exactly one DeepSeek request ---
      await expect(async () => {
        expect(calls).toHaveLength(1)
      }).toPass({ timeout: 10_000 })

      await expect(calls[0]!.serviceWorkerOwned).toBe(true)

      // --- Assert original message body remains visible ---
      const message = page.locator('.chat-line__message').last()
      const messageBody = page.locator('[data-a-target="chat-line-message-body"]')
      await expect(messageBody).toBeVisible()
      await expect(message).toContainText(MESSAGE_TEXT)

      // --- Assert translated element exists but is initially hidden ---
      const translated = page.locator('[data-tachi-lens-translated]')
      await expect(translated).toHaveCount(1)
      await expect(translated).toHaveCSS('display', 'none')

      // --- Assert hovering the message root makes the translated element visible ---
      await message.hover()
      await expect(translated).toHaveCSS('display', 'block')

      // --- Assert moving the pointer away hides it again ---
      await page.mouse.move(0, 0)
      await expect(translated).toHaveCSS('display', 'none')

      // --- Assert no duplicate translated element after repeated hover cycles ---
      await message.hover()
      await expect(translated).toHaveCSS('display', 'block')
      await expect(translated).toHaveCount(1)
      await page.mouse.move(0, 0)
      await expect(translated).toHaveCSS('display', 'none')
      await expect(translated).toHaveCount(1)

      // --- Assert translated text is correct on hover ---
      await message.hover()
      await expect(translated).toHaveText(TRANSLATED_TEXT)

      // --- Assert message root is marked processed ---
      await expect(message).toHaveAttribute('data-tachi-lens-processed', 'true')

      // --- Assert no second provider call ---
      expect(calls).toHaveLength(1)

      // --- Fail on any collected errors ---
      expect(collectedErrors).toEqual([])
    } catch (err) {
      if (page) {
        await attachDebugArtifacts(testInfo, page, serviceWorker, collectedErrors)
      }
      throw err
    }
  })

  test('collapse mode hides original text and toggles it through clicks', async ({
    context,
    serviceWorker,
    collectedErrors,
  }, testInfo) => {
    testInfo.setTimeout(60_000)

    let page: Page | undefined
    try {
      const result = await setupDisplayModeTest(context, serviceWorker, 'collapse')
      page = result.page
      const calls = result.calls

      // --- Assert exactly one DeepSeek request ---
      await expect(async () => {
        expect(calls).toHaveLength(1)
      }).toPass({ timeout: 10_000 })

      await expect(calls[0]!.serviceWorkerOwned).toBe(true)

      // --- Assert translated element is visible ---
      const translated = page.locator('[data-tachi-lens-translated]')
      await expect(translated).toHaveCount(1)
      await expect(translated).toBeVisible()
      await expect(translated).toHaveText(TRANSLATED_TEXT)

      // --- Assert original message body is hidden after translation injection ---
      const message = page.locator('.chat-line__message').last()
      const messageBody = message.locator('[data-a-target="chat-line-message-body"]')
      await expect(messageBody).not.toBeVisible()

      // --- Assert clicking the translated element reveals the original body ---
      await translated.click()
      await expect(messageBody).toBeVisible()
      await expect(messageBody).toHaveText(MESSAGE_TEXT)

      // --- Assert clicking the translated element again hides the original body ---
      await translated.click()
      await expect(messageBody).not.toBeVisible()

      // --- Assert translated text remains visible through both states ---
      await expect(translated).toBeVisible()
      await expect(translated).toHaveText(TRANSLATED_TEXT)

      // --- Assert the original body's previous inline display value is restored ---
      await translated.click()
      await expect(messageBody).toBeVisible()
      const originalDisplay = await messageBody.evaluate(
        (el) => (el as HTMLElement).style.display,
      )
      expect(originalDisplay).toBe('')

      // --- Assert message root is marked processed ---
      await expect(message).toHaveAttribute('data-tachi-lens-processed', 'true')

      // --- Assert exactly one translated descendant ---
      await expect(translated).toHaveCount(1)

      // --- Assert no second provider call ---
      expect(calls).toHaveLength(1)

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
