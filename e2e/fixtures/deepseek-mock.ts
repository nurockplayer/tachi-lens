/**
 * Deterministic DeepSeek API mock for E2E testing.
 *
 * Intercepts `https://api.deepseek.com/chat/completions` requests made by
 * the Extension Service Worker, validates the request shape, and returns a
 * deterministic response. A fallback route aborts any unmatched DeepSeek
 * requests for network isolation.
 */
import type { BrowserContext } from '@playwright/test'
import { resolveMockTranslation } from '../../src/test-utils/deepseek-mock-text'

export const DEEPSEEK_MOCK_KEY = 'e2e-deepseek-key'

export interface DeepSeekMockCall {
  requestId: string
  messageText: string
  serviceWorkerOwned: boolean
}

export interface DeepSeekMockOptions {
  /**
   * Map from source message text to translated text.
   * When provided, the mock accepts ONLY source texts present in the map
   * and returns the corresponding translation. Unmapped texts are rejected.
   * When omitted, the mock accepts ONLY the source text 'Hello world'
   * and returns the default translation '你好，世界'.
   */
  translations?: Record<string, string>
}

/**
 * Register the DeepSeek mock route handlers on the given BrowserContext.
 *
 * - A broad abort route catches any unmatched request to api.deepseek.com.
 * - A specific route handles `/chat/completions` with full request validation
 *   and a deterministic response that preserves the received request ID.
 *
 * Returns a `calls` array that the test can assert against.
 */
export const setupDeepSeekMock = async (
  context: BrowserContext,
  options?: DeepSeekMockOptions,
): Promise<{ calls: DeepSeekMockCall[] }> => {
  const calls: DeepSeekMockCall[] = []
  const translations = options?.translations

  // Fallback: abort any unmatched request to api.deepseek.com.
  // Registered first (lower priority); the specific handler registered later
  // takes precedence for /chat/completions.
  await context.route('https://api.deepseek.com/**', async (route) => {
    await route.abort('blockedbyclient')
  })

  // Specific mock for the chat completions endpoint (higher priority).
  await context.route('https://api.deepseek.com/chat/completions', async (route) => {
    const request = route.request()
    const method = request.method()
    const headers = request.headers()
    const sw = request.serviceWorker()

    // --- Validate method ---
    if (method !== 'POST') {
      await route.abort('blockedbyclient')
      throw new Error(`DeepSeek mock: expected POST, got ${method}`)
    }

    // --- Validate Authorization ---
    if (headers['authorization'] !== `Bearer ${DEEPSEEK_MOCK_KEY}`) {
      await route.abort('blockedbyclient')
      throw new Error(`DeepSeek mock: Authorization header mismatch (expected Bearer <mock-key>)`)
    }

    // --- Validate Content-Type ---
    if (!(headers['content-type'] ?? '').includes('application/json')) {
      await route.abort('blockedbyclient')
      throw new Error(`DeepSeek mock: expected Content-Type application/json, got ${headers['content-type']}`)
    }

    // --- Parse body ---
    let body: Record<string, unknown>
    try {
      body = JSON.parse(request.postData() ?? '{}')
    } catch {
      await route.abort('blockedbyclient')
      throw new Error('DeepSeek mock: failed to parse request body')
    }

    // --- Validate model and thinking ---
    if (body.model !== 'deepseek-v4-flash') {
      await route.abort('blockedbyclient')
      throw new Error(`DeepSeek mock: expected model deepseek-v4-flash, got ${body.model}`)
    }
    if ((body.thinking as Record<string, unknown>)?.type !== 'disabled') {
      await route.abort('blockedbyclient')
      throw new Error(`DeepSeek mock: expected thinking.type disabled, got ${JSON.stringify(body.thinking)}`)
    }

    // --- Validate messages ---
    const messages = (body.messages as Array<Record<string, unknown>>) ?? []
    const systemMsg = messages.find((m) => m.role === 'system')
    const userMsg = messages.find((m) => m.role === 'user')

    if (!systemMsg) {
      await route.abort('blockedbyclient')
      throw new Error('DeepSeek mock: no system message')
    }
    if (!userMsg) {
      await route.abort('blockedbyclient')
      throw new Error('DeepSeek mock: no user message')
    }

    // --- Parse user message JSON content ---
    let userContent: Record<string, unknown>
    try {
      userContent = JSON.parse(userMsg.content as string)
    } catch {
      await route.abort('blockedbyclient')
      throw new Error('DeepSeek mock: user message content is not valid JSON')
    }

    // --- Validate target language ---
    if (userContent.target_lang !== 'zh-TW') {
      await route.abort('blockedbyclient')
      throw new Error(`DeepSeek mock: expected target_lang zh-TW, got ${userContent.target_lang}`)
    }

    // --- Validate messages array in user content ---
    const contentMessages = (userContent.messages as Array<Record<string, unknown>>) ?? []
    if (contentMessages.length !== 1) {
      await route.abort('blockedbyclient')
      throw new Error(`DeepSeek mock: expected exactly 1 message in user content, got ${contentMessages.length}`)
    }

    const firstMsg = contentMessages[0]!
    const requestId = firstMsg.id as string
    const messageText = firstMsg.text as string

    if (typeof requestId !== 'string' || !requestId) {
      await route.abort('blockedbyclient')
      throw new Error(`DeepSeek mock: invalid or missing request ID: ${requestId}`)
    }

    if (typeof messageText !== 'string' || !messageText) {
      await route.abort('blockedbyclient')
      throw new Error(`DeepSeek mock: invalid or missing message text: ${messageText}`)
    }

    // --- Resolve translation (strict: rejects unmapped texts) ---
    const translatedText = resolveMockTranslation(messageText, translations)

    // --- Construct deterministic response preserving the received ID ---
    const responseBody = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify([
              { id: requestId, translated_text: translatedText },
            ]),
          },
        },
      ],
    })

    calls.push({
      requestId,
      messageText,
      serviceWorkerOwned: sw !== null,
    })

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: responseBody,
    })
  })

  return { calls }
}
