import { test as base, chromium, type BrowserContext, type Worker, type Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const DIST_DIR = path.join(PROJECT_ROOT, 'dist')

export interface ExtensionError {
  source: 'service-worker' | 'page'
  type: string
  text: string
}

// Shared error arrays keyed by BrowserContext — avoids per-test hacks
const contextErrors = new WeakMap<BrowserContext, ExtensionError[]>()

/**
 * Wake the MV3 Service Worker by opening a page.
 * MV3 SWs are event-driven — chrome.runtime.onInstalled fires when the
 * extension loads, which triggers the SW to start.
 */
const wakeServiceWorker = async (context: BrowserContext): Promise<void> => {
  const page: Page = await context.newPage()
  try {
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10_000 })
  } catch {
    // Navigation failure is non-fatal; SW may still start via onInstalled
  } finally {
    await page.close()
  }
}

export const test = base.extend<{
  context: BrowserContext
  serviceWorker: Worker
  extensionId: string
  collectedErrors: ExtensionError[]
}>({
  context: async ({}, use) => {
    const manifestPath = path.join(DIST_DIR, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `Extension build not found: ${DIST_DIR}/manifest.json is missing.\n` +
        'Run "pnpm build" to build the extension first.',
      )
    }

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tachi-lens-e2e-'))
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${DIST_DIR}`,
        `--load-extension=${DIST_DIR}`,
      ],
    })

    const errors: ExtensionError[] = []
    contextErrors.set(context, errors)

    // Attach console listeners to existing and future SWs
    const attachSwConsole = (worker: Worker): void => {
      worker.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          errors.push({ source: 'service-worker', type: msg.type(), text: msg.text })
        }
      })
    }
    for (const sw of context.serviceWorkers()) {
      attachSwConsole(sw)
    }
    context.on('serviceworker', (sw) => {
      attachSwConsole(sw)
    })

    // Attach error/console listeners to pages
    context.on('page', (page) => {
      page.on('pageerror', (err) => {
        errors.push({ source: 'page', type: 'pageerror', text: err.message })
      })
      page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          errors.push({ source: 'page', type: msg.type(), text: msg.text })
        }
      })
    })

    // Wake the MV3 Service Worker — it won't start automatically in headless
    await wakeServiceWorker(context)

    try {
      await use(context)
    } finally {
      contextErrors.delete(context)
      await context.close()
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        // Temp directory cleanup is best-effort
      }
    }
  },

  serviceWorker: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0]
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 15_000 })
    }
    await use(sw)
  },

  extensionId: async ({ serviceWorker }, use) => {
    const url = serviceWorker.url()
    const match = url.match(/^chrome-extension:\/\/([a-z]{32})\//)
    if (!match?.[1]) {
      throw new Error(
        `Cannot derive extensionId from SW URL: ${url}.\n` +
        'Expected chrome-extension://<32-char-id>/... format.',
      )
    }
    await use(match[1])
  },

  collectedErrors: async ({ context }, use) => {
    const errors = contextErrors.get(context) ?? []
    await use(errors)
  },
})
