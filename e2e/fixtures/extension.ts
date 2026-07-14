import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test'
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

const contextErrors = new WeakMap<BrowserContext, ExtensionError[]>()

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
    let context: BrowserContext | undefined

    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        args: [
          `--disable-extensions-except=${DIST_DIR}`,
          `--load-extension=${DIST_DIR}`,
        ],
      })

      const errors: ExtensionError[] = []
      contextErrors.set(context, errors)

      const attachSwConsole = (worker: Worker): void => {
        worker.on('console', (msg) => {
          if (msg.type() === 'error') {
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

      context.on('page', (page) => {
        page.on('pageerror', (err) => {
          errors.push({ source: 'page', type: 'pageerror', text: err.message })
        })
        page.on('console', (msg) => {
          if (msg.type() === 'error') {
            errors.push({ source: 'page', type: msg.type(), text: msg.text })
          }
        })
      })

      await use(context)
    } finally {
      if (context) {
        contextErrors.delete(context)
        await context.close()
      }
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        // Temp directory cleanup is best-effort
      }
    }
  },

  serviceWorker: async ({ context }, use) => {
    let sw: Worker | undefined = context.serviceWorkers()[0]
    if (!sw) {
      try {
        sw = await context.waitForEvent('serviceworker', { timeout: 15_000 })
      } catch (waitError) {
        const collected = (contextErrors.get(context) ?? [])
          .map((e) => `  [${e.source}] ${e.type}: ${e.text}`)
          .join('\n')
        const originalMsg =
          waitError instanceof Error ? waitError.message : String(waitError)
        throw new Error(
          `Extension MV3 Service Worker did not start.\n` +
          `  Extension path: ${DIST_DIR}\n` +
          `  waitForEvent failed: ${originalMsg}\n` +
          (collected
            ? `  Collected startup errors:\n${collected}`
            : '  No startup errors were collected.'),
        )
      }
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
