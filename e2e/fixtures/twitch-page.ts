/**
 * Reusable E2E helpers for testing the Content Script on a synthetic Twitch page.
 *
 * Storage setup belongs here, not in the test file.
 */

import type { Worker } from '@playwright/test'

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
