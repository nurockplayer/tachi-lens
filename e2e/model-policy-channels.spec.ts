import { expect } from '@playwright/test'
import { test } from './fixtures/extension'
import { terminateExtensionServiceWorker } from './fixtures/service-worker'
import { getTwitchChatHtml } from './fixtures/twitch-chat'
import { readFileSync } from 'node:fs'

const POLICY_URL = 'https://raw.githubusercontent.com/nurockplayer/tachi-lens/main/public/model-policy.json'

test('channel Auto and pin govern requests, cache and quota across promotion, rollback and worker restart', async ({ context, serviceWorker, extensionId }) => {
  const bundle = JSON.parse(readFileSync(new URL('../public/model-policy.json', import.meta.url), 'utf8'))
  let remote = {
    ...bundle, revision: bundle.revision + 1,
    issuedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    policies: bundle.policies.map((entry: { provider: string; workload: string }) => entry.provider === 'gemini' && entry.workload === 'chat'
      ? { ...entry, recommended: 'gemini-test-flash', fallbacks: ['gemini-2.5-pro'], models: [{ id: 'gemini-test-flash', configuration: 'gemini-low-thinking' }, { id: 'gemini-test-rollback', configuration: 'default' }, { id: 'gemini-2.5-pro', configuration: 'default' }] }
      : entry),
  }
  const calls: Array<{ model: string; ids: string[] }> = []
  await context.route(POLICY_URL, route => route.fulfill({ json: remote }))
  await context.route('https://generativelanguage.googleapis.com/**', async route => {
    const body = route.request().postDataJSON()
    const messages = JSON.parse(body.contents[0].parts[0].text).messages as Array<{ id: string }>
    const model = route.request().url().split('/models/')[1]!.split(':')[0]!
    calls.push({ model, ids: messages.map(message => message.id) })
    await route.fulfill({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify(messages.map(message => ({ id: message.id, translated_text: model }))) }] } }] } })
  })
  await context.route('https://www.twitch.tv/**', route => route.fulfill({ body: getTwitchChatHtml(), contentType: 'text/html' }))
  await serviceWorker.evaluate(() => chrome.storage.local.set({
    userSettings: { selectedProvider: 'gemini', selectedModel: 'gemini-2.5-flash', targetLanguage: 'ja', minTextLength: 1, botNameBlacklist: [], translationEnabled: true },
    perChannelSettings: { pinned: { selectedModel: 'gemini-2.5-pro' }, automatic: { selectedModel: 'auto' } },
    providerApiKeys: { gemini: 'synthetic-channel-key' },
  }))
  const pinned = await context.newPage()
  const automatic = await context.newPage()
  await pinned.goto('https://www.twitch.tv/pinned')
  await automatic.goto('https://www.twitch.tv/automatic')
  const append = async (page: typeof pinned, text: string) => {
    await page.evaluate(text => (window as unknown as { appendChatMessage: (text: string, name: string) => void }).appendChatMessage(text, 'synthetic'), text)
    await expect(page.locator('[data-tachi-lens-translated]').last()).toBeVisible({ timeout: 15000 })
    return page.locator('[data-tachi-lens-translated]').last().textContent()
  }
  expect(await append(pinned, 'Shared synthetic chat')).toBe('gemini-2.5-pro')
  expect(await append(automatic, 'Shared synthetic chat')).toBe('gemini-test-flash')
  expect(calls.map(call => call.model)).toEqual(['gemini-2.5-pro', 'gemini-test-flash'])

  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
  remote = { ...remote, revision: remote.revision + 1, policies: remote.policies.map((entry: { provider: string; workload: string }) => entry.provider === 'gemini' && entry.workload === 'chat'
    ? { ...entry, recommended: 'gemini-test-rollback', fallbacks: ['gemini-test-flash'] } : entry) }
  await popup.evaluate(async () => {
    const state = await chrome.storage.local.get('modelPolicyState')
    await chrome.storage.local.set({ modelPolicyState: { ...state.modelPolicyState, attemptedAt: 0 } })
  })
  await terminateExtensionServiceWorker(context, extensionId, popup)
  await popup.reload()
  await pinned.reload()
  await automatic.reload()
  expect(await append(pinned, 'Shared synthetic chat after rollback')).toBe('gemini-2.5-pro')
  expect(await append(automatic, 'Shared synthetic chat after rollback')).toBe('gemini-test-rollback')
  expect(calls.map(call => call.model)).toEqual(['gemini-2.5-pro', 'gemini-test-flash', 'gemini-2.5-pro', 'gemini-test-rollback'])
  const state = await popup.evaluate(() => chrome.storage.local.get(['perChannelSettings', 'userSettings', 'geminiQuotaUsage']))
  expect(state.perChannelSettings).toEqual({ pinned: { selectedModel: 'gemini-2.5-pro' }, automatic: { selectedModel: 'auto' } })
  expect(state.userSettings.selectedModel).toBe('gemini-2.5-flash')
  expect(Object.keys(state.geminiQuotaUsage.buckets)).toEqual(expect.arrayContaining(['gemini-2.5-pro', 'gemini-test-flash', 'gemini-test-rollback']))
})
