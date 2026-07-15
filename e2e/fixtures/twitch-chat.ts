/**
 * Deterministic Twitch-compatible HTML fixture for E2E testing.
 *
 * Provides a minimal DOM that matches `src/content/twitch-selectors.ts`
 * and exposes `window.appendChatMessage(text, username?)` on the page
 * to exercise the real Content Script MutationObserver path.
 */

export const getTwitchChatHtml = (): string => `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>tachi-lens-e2e</title></head>
<body>
  <section data-test-selector="chat-scrollable-area__message-container"></section>
  <script>
    window.appendChatMessage = (text, username) => {
      const container = document.querySelector(
        '[data-test-selector="chat-scrollable-area__message-container"]'
      )
      if (!container) throw new Error('chat container not found')

      const message = document.createElement('div')
      message.className = 'chat-line__message'

      const badge = document.createElement('span')
      badge.className = 'chat-author__display-name'
      badge.textContent = username || 'testuser'
      message.appendChild(badge)

      const body = document.createElement('span')
      body.setAttribute('data-a-target', 'chat-line-message-body')
      body.textContent = text
      message.appendChild(body)

      container.appendChild(message)
      return message
    }
  </script>
</body>
</html>`
