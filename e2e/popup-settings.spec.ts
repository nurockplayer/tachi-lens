/**
 * E2E test: packaged Popup render and settings persistence.
 *
 * Verifies that the production Popup (from the built manifest) renders its
 * primary controls, persists settings through the real UI, and masks the
 * API key on a reopened Popup.  No provider network request is made.
 *
 * This test does not navigate to Twitch or perform a translation.
 */
import { expect } from '@playwright/test'
import { test } from './fixtures/extension'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')
const DIST_DIR = path.join(PROJECT_ROOT, 'dist')

const POPUP_SECRET_KEY = 'e2e-popup-secret-key'
const EXPECTED_PREVIEW = 'e2e*************-key'

/** Provider API origins to block for network isolation. */
const PROVIDER_ORIGINS = [
  'https://api.deepseek.com',
  'https://generativelanguage.googleapis.com',
  'https://api.openai.com',
  'https://api.anthropic.com',
]

test.describe('Packaged Popup render and settings persistence', () => {
  test('renders controls, persists settings, masks API key on reopen', async ({
    context,
    serviceWorker,
    extensionId,
    collectedErrors,
  }) => {
    // --- Resolve the Popup URL from the built manifest ---
    const manifestPath = path.join(DIST_DIR, 'manifest.json')
    const raw = fs.readFileSync(manifestPath, 'utf-8')
    const manifest = JSON.parse(raw)
    const popupEntry = manifest.action?.default_popup
    expect(popupEntry).toBeTruthy()
    const popupUrl = `chrome-extension://${extensionId}/${popupEntry}`

    // --- Extension prerequisites ---
    expect(serviceWorker).toBeDefined()
    expect(extensionId).toMatch(/^[a-z]{32}$/)

    // --- Clear extension storage so the test starts from a known state ---
    await serviceWorker.evaluate(() => chrome.storage.local.clear())

    // --- Network isolation: block every provider origin ---
    const unwantedRequests: string[] = []
    await Promise.all(
      PROVIDER_ORIGINS.map((origin) =>
        context.route(`${origin}/**`, async (route) => {
          unwantedRequests.push(route.request().url())
          await route.abort('blockedbyclient')
        }),
      ),
    )

    // ===================================================================
    //  1. FIRST POPUP — initial assertions
    // ===================================================================
    let page = await context.newPage()
    await page.goto(popupUrl, { waitUntil: 'load' })

    // Wait for loading to finish (React mount → read settings)
    const heading = page.getByRole('heading', { level: 1, name: 'tachi-lens' })
    await expect(heading).toBeVisible()

    // Assert all primary controls are rendered (not hidden)
    await expect(page.locator('#provider-select')).toBeVisible()
    await expect(page.locator('#model-select')).toBeVisible()
    await expect(page.locator('#api-key-input')).toBeVisible()
    await expect(page.locator('#language-select')).toBeVisible()
    await expect(page.locator('#display-mode-select')).toBeVisible()
    await expect(page.locator('#min-length-input')).toBeVisible()

    // Save button — locale-independent: chrome.i18n picks browser locale
    const saveButton = page.getByRole('button', { name: /^(Save Settings|儲存設定)$/ })
    await expect(saveButton).toBeVisible()

    // ===================================================================
    //  2. CHANGE SETTINGS THROUGH UI
    // ===================================================================

    // Translation enabled → false (uncheck). Label is locale-dependent.
    const enableCheckbox = page.getByRole('checkbox', { name: /Enable Translation|啟用翻譯/ })
    await expect(enableCheckbox).toBeVisible()
    if (await enableCheckbox.isChecked()) {
      await enableCheckbox.click()
    }

    // Provider → deepseek (may already be default, select anyway)
    await page.locator('#provider-select').selectOption('deepseek')

    // Model → deepseek-v4-flash (set by provider change; select explicitly)
    await page.locator('#model-select').selectOption('deepseek-v4-flash')

    // API key → fill the secret (triggers save_api_key runtime message)
    const apiKeyInput = page.locator('#api-key-input')
    await apiKeyInput.fill(POPUP_SECRET_KEY)

    // Wait for the Service Worker to persist the key to storage
    await expect(async () => {
      const result = await serviceWorker.evaluate(() =>
        chrome.storage.local.get('providerApiKeys'),
      )
      expect((result.providerApiKeys as Record<string, string> | undefined)?.deepseek).toBe(
        POPUP_SECRET_KEY,
      )
    }).toPass({ timeout: 5_000 })

    // Target language → ja
    await page.locator('#language-select').selectOption('ja')

    // Display mode → hover
    await page.locator('#display-mode-select').selectOption('hover')

    // Minimum text length → 3
    await page.locator('#min-length-input').fill('3')

    // Save settings
    await saveButton.click()

    // Assert saved confirmation appears (locale-independent)
    await expect(page.getByText(/Settings saved|設定已儲存/)).toBeVisible()

    // Close the first Popup
    await page.close()

    // ===================================================================
    //  3. REOPEN POPUP — persistence assertions
    // ===================================================================
    page = await context.newPage()
    await page.goto(popupUrl, { waitUntil: 'load' })

    await expect(page.locator('h1')).toBeVisible()
    await expect(page.locator('h1')).toHaveText('tachi-lens')

    // Translation remains disabled
    const reloadedCheckbox = page.getByRole('checkbox', { name: /Enable Translation|啟用翻譯/ })
    await expect(reloadedCheckbox).not.toBeChecked()

    // Provider persisted
    await expect(page.locator('#provider-select')).toHaveValue('deepseek')

    // Model persisted
    await expect(page.locator('#model-select')).toHaveValue('deepseek-v4-flash')

    // Target language persisted
    await expect(page.locator('#language-select')).toHaveValue('ja')

    // Display mode persisted
    await expect(page.locator('#display-mode-select')).toHaveValue('hover')

    // Minimum length persisted
    await expect(page.locator('#min-length-input')).toHaveValue('3')

    // ===================================================================
    //  4. API KEY MASKING
    // ===================================================================

    // The field must contain the masked preview, not the plaintext secret
    const reopenedKeyInput = page.locator('#api-key-input')
    await expect(reopenedKeyInput).toHaveValue(EXPECTED_PREVIEW)

    // The plaintext key must never appear in the reopened Popup HTML or attributes
    const reopenedHtml = await page.content()
    expect(reopenedHtml).not.toContain(POPUP_SECRET_KEY)

    // ===================================================================
    //  5. STORAGE VERIFICATION via Service Worker
    // ===================================================================
    const stored = await serviceWorker.evaluate(() =>
      chrome.storage.local.get([
        'userSettings',
        'providerApiKeys',
        'providerApiKeyPreviews',
      ]),
    )

    const userSettings = stored.userSettings as Record<string, unknown> | undefined
    expect(userSettings?.translationEnabled).toBe(false)
    expect(userSettings?.selectedProvider).toBe('deepseek')
    expect(userSettings?.selectedModel).toBe('deepseek-v4-flash')
    expect(userSettings?.targetLanguage).toBe('ja')
    expect(userSettings?.displayMode).toBe('hover')
    expect(userSettings?.minTextLength).toBe(3)

    const apiKeys = stored.providerApiKeys as Record<string, string> | undefined
    expect(apiKeys?.deepseek).toBe(POPUP_SECRET_KEY)

    const previewKeys = stored.providerApiKeyPreviews as Record<string, string> | undefined
    expect(previewKeys?.deepseek).toBe(EXPECTED_PREVIEW)

    // ===================================================================
    //  6. NETWORK ISOLATION
    // ===================================================================
    expect(unwantedRequests).toEqual([])

    // ===================================================================
    //  7. NO RUNTIME ERRORS
    // ===================================================================
    expect(collectedErrors).toEqual([])
  })
})
