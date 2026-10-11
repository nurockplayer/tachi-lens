import { expect } from '@playwright/test'
import { test } from './fixtures/extension'
import { getTwitchChatHtml } from './fixtures/twitch-chat'
import { getDiagnosticsEvents, seedDeepSeekTestSettings, TWITCH_URL } from './fixtures/twitch-page'

test('mixed adjacent results recover automatically and exhausted failures can retry once manually', async ({
  context, serviceWorker, collectedErrors,
}) => {
  test.setTimeout(90_000)
  await seedDeepSeekTestSettings(serviceWorker)
  await context.route(TWITCH_URL, route => route.fulfill({ body: getTwitchChatHtml(), contentType: 'text/html' }))
  const attempts = new Map<string, number>()
  let recoverTerminal = false
  const source = ['Synthetic stable message', 'Synthetic intermittent message', 'Synthetic exhausted message']
  const output = ['合成成功訊息', '合成恢復訊息', '合成手動恢復訊息']
  const ownership: boolean[] = []
  await context.route('https://api.deepseek.com/**', route => route.abort('blockedbyclient'))
  await context.route('https://api.deepseek.com/chat/completions', async route => {
    ownership.push(route.request().serviceWorker() !== null)
    const request = route.request().postDataJSON() as { messages: { role: string; content: string }[] }
    const payload = JSON.parse(request.messages.find(item => item.role === 'user')!.content) as {
      messages: { id: string; text: string }[]
    }
    const results = payload.messages.map(item => {
      const index = source.indexOf(item.text)
      if (index < 0) throw new Error('Unexpected synthetic source')
      const count = (attempts.get(item.text) ?? 0) + 1
      attempts.set(item.text, count)
      const empty = (index === 1 && count === 1) || (index === 2 && !recoverTerminal)
      return { id: item.id, translated_text: empty ? '' : output[index] }
    })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      choices: [{ message: { content: JSON.stringify(results) } }],
    }) })
  })
  const page = await context.newPage()
  await page.goto(TWITCH_URL, { waitUntil: 'domcontentloaded' })
  await expect(async () => {
    expect((await getDiagnosticsEvents(serviceWorker)).some(event => event.stage === 'chat_container_ready')).toBe(true)
  }).toPass({ timeout: 15_000 })
  await page.evaluate(texts => {
    const append = (window as unknown as { appendChatMessage: (text: string, username: string) => void }).appendChatMessage
    texts.forEach(text => append(text, 'synthetic_viewer'))
  }, source)
  const rows = page.locator('.chat-line__message')
  await expect(rows.nth(0).locator('[data-tachi-lens-translated]:not([data-tachi-lens-error])')).toHaveText(output[0]!)
  await expect(rows.nth(1).locator('[data-tachi-lens-translated]:not([data-tachi-lens-error])')).toHaveText(output[1]!, { timeout: 20_000 })
  const failed = rows.nth(2)
  const retry = failed.getByRole('button', { name: /retry/i })
  await expect(retry).toBeVisible({ timeout: 25_000 })
  expect(attempts.get(source[2]!)).toBe(3)
  expect(attempts.get(source[0]!)).toBe(1)
  await expect(failed).not.toHaveAttribute('data-tachi-lens-processed', 'true')
  await expect(failed.locator('[data-tachi-lens-translated]:not([data-tachi-lens-error])')).toHaveCount(0)
  recoverTerminal = true
  await retry.click()
  await expect(failed.locator('[data-tachi-lens-translated]:not([data-tachi-lens-error])')).toHaveText(output[2]!, { timeout: 10_000 })
  await expect(failed.getByRole('button', { name: /retry/i })).toHaveCount(0)
  await expect(page.locator('[data-tachi-lens-translated]:not([data-tachi-lens-error])')).toHaveCount(3)
  for (let index = 0; index < source.length; index++) {
    await expect(rows.nth(index).locator('[data-a-target="chat-line-message-body"]')).toHaveText(source[index]!)
  }
  expect(attempts.get(source[1]!)).toBe(2)
  expect(attempts.get(source[2]!)).toBe(4)
  expect(ownership.every(Boolean)).toBe(true)
  expect(collectedErrors).toEqual([])

  // Twitch can retain Lens children when recycling a connected row. A new
  // successful result must replace the stale child and settle exactly once.
  source.push('Synthetic recycled message')
  output.push('合成回收訊息')
  await page.evaluate(text => {
    const body = document.querySelector('.chat-line__message [data-a-target="chat-line-message-body"]')!
    body.textContent = text
  }, source[3]!)
  await expect(rows.nth(0).locator('[data-tachi-lens-translated]:not([data-tachi-lens-error])')).toHaveText(output[3]!, { timeout: 10_000 })
  await expect(rows.nth(0)).toHaveAttribute('data-tachi-lens-processed', 'true')
  await page.waitForTimeout(10_500) // Observe two five-second retry scans.
  expect(attempts.get(source[3]!)).toBe(1)
  await expect(rows.nth(0).locator('[data-tachi-lens-translated]')).toHaveCount(1)
  await expect(page.locator('[data-tachi-lens-translated]:not([data-tachi-lens-error])')).toHaveCount(3)
  expect(collectedErrors).toEqual([])
})
