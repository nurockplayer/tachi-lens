import { expect } from '@playwright/test'
import { test } from './fixtures/extension'
import { terminateExtensionServiceWorker } from './fixtures/service-worker'
import { readFileSync } from 'node:fs'
const policySeed = JSON.parse(readFileSync(new URL('../public/model-policy.json', import.meta.url), 'utf8')) as { revision: number; issuedAt: string; expiresAt: string; policies: Array<{ provider: string; workload: string; recommended: string; models: Array<{ id: string; configuration: string }> }> }

const POLICY_URL = 'https://raw.githubusercontent.com/nurockplayer/tachi-lens/main/public/model-policy.json'

const candidatePolicy = () => {
  const policy = structuredClone(policySeed)
  policy.revision = 2
  policy.issuedAt = new Date(Date.now() - 60000).toISOString()
  policy.expiresAt = new Date(Date.now() + 86400000).toISOString()
  const chat = policy.policies.find(entry => entry.provider === 'gemini' && entry.workload === 'chat')!
  chat.models.push({ id: 'gemini-4.0-flash', configuration: 'gemini-low-thinking' })
  chat.recommended = 'gemini-4.0-flash'
  return policy
}

test('packaged Auto resolves remote request options and cache/quota identity; a concrete pin survives promotion', async ({ context, serviceWorker, extensionId }) => {
  const policy = candidatePolicy()
  const calls: Array<{ model: string; configuration: unknown }> = []
  await context.route(POLICY_URL, route => route.fulfill({ json: policy }))
  await context.route('https://generativelanguage.googleapis.com/**', async route => {
    const body = route.request().postDataJSON() as { contents: Array<{ parts: Array<{ text: string }> }>; generationConfig?: unknown }
    const prompt = JSON.parse(body.contents[0]!.parts[0]!.text) as { messages: Array<{ id: string }> }
    calls.push({ model: route.request().url().split('/models/')[1]!.split(':')[0]!, configuration: body.generationConfig })
    await route.fulfill({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify(prompt.messages.map(message => ({ id: message.id, translated_text: 'こんにちは' }))) }] } }] } })
  })
  await serviceWorker.evaluate(() => chrome.storage.local.set({ userSettings: { selectedProvider: 'gemini', selectedModel: 'auto', targetLanguage: 'ja' }, providerApiKeys: { gemini: 'synthetic-e2e-key' } }))
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
  await page.locator('#providers-button').click()
  await expect(page.locator('#model-select option[value="auto"]')).toHaveText(/gemini-4.0-flash/)
  const translate = (id: string) => page.evaluate(messageId => chrome.runtime.sendMessage({ type: 'translate_request', payload: { messageId, text: 'Synthetic model policy fixture' } }), id)
  expect(await translate('automatic')).toMatchObject({ payload: { translatedText: 'こんにちは' } })
  expect(calls).toEqual([{ model: 'gemini-4.0-flash', configuration: { thinkingConfig: { thinkingLevel: 'low' } } }])
  const quota = await serviceWorker.evaluate(() => chrome.storage.local.get('geminiQuotaUsage'))
  expect(Object.keys(quota.geminiQuotaUsage.buckets)).toContain('gemini-4.0-flash')

  await page.locator('#model-select').selectOption('gemini-2.5-flash')
  await page.getByRole('button', { name: /^(Save Settings|儲存設定)$/ }).click()
  expect(await translate('pinned')).toMatchObject({ payload: { translatedText: 'こんにちは' } })
  expect(calls[1]).toEqual({ model: 'gemini-2.5-flash', configuration: undefined })
  await page.reload()
  await page.locator('#providers-button').click()
  await expect(page.locator('#model-select')).toHaveValue('gemini-2.5-flash')
  const diagnostics = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'get_model_policy', payload: {} }))
  expect(diagnostics.payload.resolutions.some((record: { model: string; selection: string }) => record.model === 'gemini-2.5-flash' && record.selection === 'pinned')).toBe(true)
  expect(JSON.stringify(diagnostics)).not.toContain('Synthetic model policy fixture')
  expect(JSON.stringify(diagnostics)).not.toContain('synthetic-e2e-key')
})

test('packaged worker uses cached policy offline and adopts a higher-revision rollback without a rebuild', async ({ context, serviceWorker, extensionId }) => {
  let remote = candidatePolicy()
  await context.route(POLICY_URL, route => route.fulfill({ json: remote }))
  await serviceWorker.evaluate(policy => chrome.storage.local.set({ modelPolicyState: { manifest: policy, attemptedAt: Date.now() }, userSettings: { selectedProvider: 'gemini', selectedModel: 'auto' } }), remote)
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
  await expect(async () => {
    const snapshot = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'get_model_policy', payload: {} }))
    expect(snapshot.payload.source).toBe('cached')
    expect(snapshot.payload.manifest.revision).toBe(2)
  }).toPass()
  remote = structuredClone(remote)
  remote.revision = 3
  remote.policies.find(entry => entry.provider === 'gemini' && entry.workload === 'chat')!.recommended = 'gemini-3.8-flash'
  await serviceWorker.evaluate(async () => {
    const state = await chrome.storage.local.get('modelPolicyState')
    await chrome.storage.local.set({ modelPolicyState: { ...state.modelPolicyState, attemptedAt: 0 } })
  })
  await terminateExtensionServiceWorker(context, extensionId, page)
  await page.reload()
  await page.locator('#providers-button').click()
  await expect(page.locator('#model-select option[value="auto"]')).toHaveText(/gemini-3.8-flash/)
  await expect(async () => {
    const snapshot = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'get_model_policy', payload: {} }))
    expect(snapshot.payload.manifest.revision).toBe(3)
    expect(snapshot.payload.source).toBe('remote')
  }).toPass()
})

test('packaged invalid remote and expired cache safely use the bundled policy', async ({ context, serviceWorker, extensionId }) => {
  await context.route(POLICY_URL, route => route.fulfill({ json: { ...candidatePolicy(), schemaVersion: 999, executable: 'not allowed' } }))
  const expired = candidatePolicy()
  expired.issuedAt = new Date(Date.now() - 2 * 86400000).toISOString()
  expired.expiresAt = new Date(Date.now() - 86400000).toISOString()
  await serviceWorker.evaluate(policy => chrome.storage.local.set({ modelPolicyState: { manifest: policy, attemptedAt: 0 } }), expired)
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
  await expect(async () => {
    const snapshot = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'get_model_policy', payload: {} }))
    expect(snapshot.payload.source).toBe('bundled')
    expect(snapshot.payload.manifest.revision).toBe(1)
  }).toPass()
})
