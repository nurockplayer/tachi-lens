/**
 * Shared helpers for E2E privacy regression and canary tests.
 *
 * These are used by both e2e/privacy-regression.spec.ts and
 * e2e/twitch-canary.spec.ts, ensuring the deterministic regression
 * tests exercise the exact same helper code as the failure artifacts.
 */
import type { Page } from '@playwright/test'
import type { ExtensionError } from './extension'

/** Sanitize HTML inside the browser context via page.evaluate. */
export async function sanitizeContainerHtml(page: Page, containerSel: string): Promise<string | null> {
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

/**
 * Apply a black overlay over every visible non-zero element matching a selector.
 * Skips hidden and zero-sized elements. Assigns collision-safe unique data
 * attributes to each target. Returns the number of elements successfully masked
 * (0 = nothing was masked).
 */
export async function applyBlackOverlay(page: Page, containerSel: string): Promise<number> {
  return page.evaluate((sel) => {
    const targets = document.querySelectorAll(sel)
    let maskedCount = 0
    for (let i = 0; i < targets.length; i++) {
      const el = targets[i] as HTMLElement
      // Skip hidden / zero-sized / visibility-hidden elements
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const cs = window.getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue

      // Assign a unique marker on the target (reuse existing or create new)
      const uid = 'tachi-overlay-' + i + '-' + Date.now()
      el.setAttribute('data-tachi-overlay', uid)

      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:fixed;top:' + rect.top + 'px;left:' + rect.left + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;background:black;z-index:999999;pointer-events:none;'
      document.body.appendChild(overlay)
      maskedCount++
    }
    return maskedCount
  }, containerSel)
}

/** Filter collectedErrors to extension-attributed SW error text +
 * page-error counts (never raw text). */
export function extensionAttributedErrors(errors: ExtensionError[]): { texts: string[]; unattributedPageCount: number; attributedPageCount: number } {
  const texts = errors
    .filter((e) => e.source === 'service-worker' && e.isExtensionAttributed)
    .map((e) => `[SW] ${e.text}`)
  const unattributedPageCount = errors.filter(
    (e) => e.source === 'page' && !e.isExtensionAttributed,
  ).length
  const attributedPageCount = errors.filter(
    (e) => e.source === 'page' && e.isExtensionAttributed,
  ).length
  return { texts, unattributedPageCount, attributedPageCount }
}
