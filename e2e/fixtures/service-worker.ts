/**
 * CDP-based helper to terminate the MV3 Extension Service Worker.
 *
 * Uses the Chromium DevTools Protocol to find and close the Service Worker
 * target directly, simulating MV3 idle termination without waiting for
 * natural suspension.
 *
 * After issuing Target.closeTarget, the helper polls Target.getTargets until
 * the captured target ID is gone, providing an unambiguous completion barrier.
 */
import type { BrowserContext, Page } from '@playwright/test'

const TERMINATION_POLL_INTERVAL_MS = 200
const TERMINATION_TIMEOUT_MS = 10_000

/**
 * Terminate the Extension Service Worker via CDP and wait for completion.
 *
 * 1. Opens a CDP session on the given page.
 * 2. Calls `Target.getTargets` to list all browser targets.
 * 3. Finds the Service Worker target whose URL starts with
 *    `chrome-extension://<extensionId>/`.
 * 4. Calls `Target.closeTarget` to terminate it.
 * 5. Polls `Target.getTargets` until the captured target ID disappears.
 * 6. Throws a clear error on timeout or when no matching target exists.
 *
 * The Twitch page and Content Script remain loaded — only the background
 * Service Worker is terminated.
 */
export const terminateExtensionServiceWorker = async (
  context: BrowserContext,
  extensionId: string,
  page: Page,
): Promise<void> => {
  const cdpSession = await context.newCDPSession(page)

  try {
    const { targetInfos } = await cdpSession.send('Target.getTargets')

    const swTarget = targetInfos.find(
      (t: { type: string; targetId: string; url: string }) =>
        t.type === 'service_worker' &&
        t.url.startsWith(`chrome-extension://${extensionId}/`),
    )

    if (!swTarget) {
      const available = targetInfos.map(
        (t: { type: string; url: string }) => ({ type: t.type, url: t.url }),
      )
      throw new Error(
        `No Service Worker target found for extension ${extensionId}.\n` +
        `Available targets: ${JSON.stringify(available, null, 2)}`,
      )
    }

    // Close the target.
    const result: { success: boolean } = await cdpSession.send('Target.closeTarget', {
      targetId: swTarget.targetId,
    })

    if (!result.success) {
      throw new Error(
        `Target.closeTarget returned success: false for SW target ${swTarget.targetId}`,
      )
    }

    // Poll until the captured target ID is gone (completion barrier).
    const deadline = Date.now() + TERMINATION_TIMEOUT_MS
    while (Date.now() < deadline) {
      const pollResult: { targetInfos: Array<{ targetId: string }> } =
        await cdpSession.send('Target.getTargets')

      const stillExists = pollResult.targetInfos.some(
        (t) => t.targetId === swTarget.targetId,
      )

      if (!stillExists) return // unambiguous completion

      await new Promise((r) => setTimeout(r, TERMINATION_POLL_INTERVAL_MS))
    }

    throw new Error(
      `Timeout waiting for Service Worker target ${swTarget.targetId} to be destroyed ` +
      `after ${TERMINATION_TIMEOUT_MS}ms polling period. ` +
      `The target may not have been fully closed by Chromium.`,
    )
  } finally {
    await cdpSession.detach().catch(() => undefined)
  }
}
