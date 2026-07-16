/**
 * CDP-based helper to terminate the MV3 Extension Service Worker.
 *
 * Uses the Chromium DevTools Protocol to find and close the Service Worker
 * target directly, simulating MV3 idle termination without waiting for
 * natural suspension.
 */
import type { BrowserContext, Page } from '@playwright/test'

/**
 * Terminate the Extension Service Worker via CDP.
 *
 * 1. Opens a CDP session on the given page.
 * 2. Calls `Target.getTargets` to list all browser targets.
 * 3. Finds the Service Worker target whose URL starts with
 *    `chrome-extension://<extensionId>/`.
 * 4. Calls `Target.closeTarget` to terminate it.
 * 5. Throws a clear error when no matching target exists.
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

    const result: { success: boolean } = await cdpSession.send('Target.closeTarget', {
      targetId: swTarget.targetId,
    })

    if (!result.success) {
      throw new Error(
        `Target.closeTarget returned success: false for SW target ${swTarget.targetId}`,
      )
    }
  } finally {
    await cdpSession.detach().catch(() => undefined)
  }
}
