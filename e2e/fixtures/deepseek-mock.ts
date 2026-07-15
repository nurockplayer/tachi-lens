/**
 * Deterministic DeepSeek completion endpoint mock for E2E testing.
 *
 * Registers a BrowserContext route that intercepts Service Worker-owned
 * requests to https://api.deepseek.com/chat/completions and returns a
 * pre-determined translated response that preserves dynamically generated
 * request IDs from the user-message content.
 *
 * Assertions are NOT made inside the route handler — call data is recorded
 * and the test validates inline, so a failed assertion never corrupts
 * the intercept.
 */
import type { BrowserContext } from '@playwright/test'

export interface DeepSeekMockCall {
  /** Whether the request reports a Service Worker owner. */
  isServiceWorker: boolean
  /** HTTP method. */
  method: string
  /** Authorization header value. */
  authorization: string | null
  /** Content-Type header value. */
  contentType: string | null
  /** Parsed JSON body (null if parse fails). */
  body: Record<string, unknown> | null
  /** Received request IDs from the parsed user message. */
  receivedIds: string[]
  /** Message texts from the parsed user message. */
  messageTexts: string[]
  /** The user content's target_lang. */
  targetLang: string | null
}

export class DeepSeekMock {
  /** Number of matched completion requests intercepted. */
  callCount = 0

  /** Record of each intercepted call's parsed fields. */
  calls: DeepSeekMockCall[] = []

  private readonly translatedText: string

  constructor(translatedText?: string) {
    this.translatedText = translatedText ?? '你好，世界'
  }

  async install(context: BrowserContext): Promise<void> {
    const translatedText = this.translatedText
    const mock = this

    await context.route(
      'https://api.deepseek.com/chat/completions',
      (route) => {
        mock.callCount++
        const request = route.request()

        const call: DeepSeekMockCall = {
          isServiceWorker: Boolean(request.serviceWorker()),
          method: request.method(),
          authorization: request.headers()['authorization'] ?? null,
          contentType: request.headers()['content-type'] ?? null,
          body: null,
          receivedIds: [],
          messageTexts: [],
          targetLang: null,
        }

        // Parse body (best-effort — never throw)
        try {
          const rawBody = request.postData() ?? ''
          const body = JSON.parse(rawBody) as Record<string, unknown>
          call.body = body

          const messages = body.messages as Array<Record<string, unknown>> | undefined
          if (messages?.[1]?.content) {
            const userContent = JSON.parse(messages[1].content as string) as Record<string, unknown>
            call.targetLang = (userContent.target_lang as string | null) ?? null
            const msgList = userContent.messages as Array<Record<string, string>> | undefined
            if (msgList) {
              call.receivedIds = msgList.map((m) => m.id)
              call.messageTexts = msgList.map((m) => m.text)
            }
          }
        } catch {
          // Body parsing failure recorded as null
        }

        mock.calls.push(call)

        // Build dynamic response preserving received IDs
        const responseItems = call.receivedIds.map((id: string) => ({
          id,
          translated_text: translatedText,
        }))

        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(responseItems),
                },
              },
            ],
          }),
        })
      },
    )
  }
}
