// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { App } from './App'

const diagnosticEvent = {
  id: 'd1',
  stage: 'translation_injected',
  timestamp: 1_700_000_000_000,
}

describe('Popup diagnostics', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
        },
      },
      runtime: {
        sendMessage: vi.fn(async (message: { type: string }) => {
          if (message.type === 'get_diagnostics') {
            return { type: 'diagnostics_snapshot', payload: { events: [diagnosticEvent] } }
          }
          if (message.type === 'get_api_key_preview') {
            return { type: 'api_key_preview', payload: { preview: '' } }
          }
          return undefined
        }),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      tabs: { query: vi.fn(async () => []) },
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows the retained diagnostic stage from the service worker', async () => {
    render(<App />)

    expect(await screen.findByRole('heading', { name: '診斷' })).toBeTruthy()
    expect(screen.getByText('翻譯已顯示於聊天室')).toBeTruthy()
  })
})
