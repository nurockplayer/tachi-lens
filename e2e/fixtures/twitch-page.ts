/**
 * Reusable E2E helpers for testing the Content Script on a synthetic Twitch page.
 *
 * Storage setup belongs here, not in the test file.
 */

import type { Worker, TestInfo, Page } from '@playwright/test'
import type { ExtensionError } from './extension'
import { DEEPSEEK_MOCK_KEY } from './deepseek-mock'

export const TWITCH_URL = 'https://www.twitch.tv/tachi-lens-e2e'

const DEFAULT_FILTER_CONFIG = {
  skipEmotesOnly: true,
  skipCheermotes: true,
  skipSlashMe: true,
  skipWhispers: true,
  skipReplies: true,
  skipLinksOnly: true,
  skipNumbersOnly: true,
  skipSystemMessages: true,
}

/**
 * Seed chrome.storage.local with minimal userSettings from the SW context.
 *
 * - Uses default filter toggles (all enabled)
 * - Sets minTextLength to 1 so any non-empty text is processed
 * - Disables translation so no provider call or translated DOM is produced
 * - Does NOT expose or seed any API key
 */
export const seedTestSettings = async (serviceWorker: Worker): Promise<void> => {
  await serviceWorker.evaluate((config) => {
    return chrome.storage.local.set({
      userSettings: {
        ...config,
        selectedProvider: 'deepseek',
        selectedModel: 'deepseek-v4-flash',
        targetLanguage: 'zh-TW',
        displayMode: 'below',
        botNameBlacklist: [],
        minTextLength: 1,
        translationEnabled: false,
        filterConfig: config,
      },
    })
  }, DEFAULT_FILTER_CONFIG)
}

/**
 * Seed chrome.storage.local with settings and API key for the DeepSeek
 * translation happy-path E2E test.
 *
 * - Enables translation
 * - Seeds a fake DeepSeek API key (never a real credential)
 * - Sets minTextLength to 1 so any non-empty text is processed
 */
export const seedDeepSeekTestSettings = async (serviceWorker: Worker): Promise<void> => {
  await serviceWorker.evaluate(({ config, key }) => {
    return chrome.storage.local.set({
      userSettings: {
        ...config,
        selectedProvider: 'deepseek',
        selectedModel: 'deepseek-v4-flash',
        targetLanguage: 'zh-TW',
        displayMode: 'below',
        botNameBlacklist: [],
        minTextLength: 1,
        translationEnabled: true,
        filterConfig: config,
      },
      providerApiKeys: {
        deepseek: key,
      },
    })
  }, { config: DEFAULT_FILTER_CONFIG, key: DEEPSEEK_MOCK_KEY })
}

export interface DiagnosticEvent {
  id: string
  stage: string
  timestamp: number
  detail?: string
}

/**
 * Read stored diagnostic events from the Service Worker's session storage.
 */
export const getDiagnosticsEvents = async (serviceWorker: Worker): Promise<DiagnosticEvent[]> => {
  return serviceWorker.evaluate(async () => {
    const items = await chrome.storage.session.get('translationDiagnostics')
    return (items.translationDiagnostics as DiagnosticEvent[]) ?? []
  })
}

/**
 * Best-effort failure attachment. Collects page URL, chat container HTML,
 * diagnostics, and browser/SW errors. Never throws — the caller's original
 * error is the single truth. Call from a catch handler before re-throw.
 */
export const attachDebugArtifacts = async (
  testInfo: TestInfo,
  page: Page,
  serviceWorker: Worker,
  collectedErrors: ExtensionError[],
): Promise<void> => {
  const chatContainer = page.locator(
    '[data-test-selector="chat-scrollable-area__message-container"]',
  )

  const [chatHtml, diagnostics] = await Promise.all([
    chatContainer.evaluate((el) => (el as HTMLElement).innerHTML).catch(() => '<unavailable>'),
    getDiagnosticsEvents(serviceWorker).catch((): DiagnosticEvent[] => []),
  ])

  await Promise.all([
    testInfo.attach('page-url', { body: page.url(), contentType: 'text/plain' }).catch(() => undefined),
    testInfo.attach('chat-container-html', { body: chatHtml, contentType: 'text/html' }).catch(() => undefined),
    testInfo.attach('diagnostics', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' }).catch(() => undefined),
  ])

  // Attach all collected runtime errors (console.error + pageerror + SW errors)
  if (collectedErrors.length > 0) {
    await testInfo.attach('runtime-errors', { body: JSON.stringify(collectedErrors, null, 2), contentType: 'application/json' }).catch(() => undefined)
  }
}
