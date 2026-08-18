// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'

const diagnosticEvent = {
  id: 'd1',
  stage: 'translation_injected',
  timestamp: 1_700_000_000_000,
}

describe('Popup diagnostics', () => {
  const stubChrome = (diagnosticsResponse: unknown): void => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
        },
      },
      runtime: {
        sendMessage: vi.fn(async (message: { type: string }) => {
          if (message.type === 'get_diagnostics') {
            return diagnosticsResponse
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
  }

  beforeEach(() => {
    stubChrome({ type: 'diagnostics_snapshot', payload: { events: [diagnosticEvent] } })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows the retained diagnostic stage from the service worker', async () => {
    render(<App />)

    const sectionButton = await screen.findByRole('button', { name: '診斷' })
    fireEvent.click(sectionButton)
    const region = screen.getByRole('region', { name: '診斷' })
    const list = within(region).getByRole('list')
    expect(within(list).getByText('翻譯已顯示於聊天室')).toBeTruthy()
    expect(within(list).getByText(new Date(diagnosticEvent.timestamp).toLocaleString())).toBeTruthy()
    const timestamp = region.querySelector('time')
    expect(timestamp?.getAttribute('dateTime')).toBe(new Date(diagnosticEvent.timestamp).toISOString())
  })

  it('renders a privacy-safe counter event as a stage label and aggregate count', async () => {
    const counterEvent = {
      id: 'c1',
      stage: 'queue_overflow_drop',
      timestamp: 1_700_000_000_000,
      count: 7,
    }
    stubChrome({ type: 'diagnostics_snapshot', payload: { events: [counterEvent] } })

    render(<App />)

    // The counter stage label is shown, and the aggregate count is rendered
    // as a compact badge — never chat text, usernames, or provider bodies.
    const sectionButton = await screen.findByRole('button', { name: '診斷' })
    fireEvent.click(sectionButton)
    const region = screen.getByRole('region', { name: '診斷' })
    expect(within(region).getByText('佇列溢位已丟棄')).toBeTruthy()
    expect(within(region).getByText('×7')).toBeTruthy()
  })

  it('marks warning and danger stages while keeping normal stages neutral', async () => {
    stubChrome({
      type: 'diagnostics_snapshot',
      payload: {
        events: [
          { id: 'normal', stage: 'message_detected', timestamp: 1_700_000_000_000 },
          { id: 'warning', stage: 'message_not_ready', timestamp: 1_700_000_001_000 },
          { id: 'danger', stage: 'translation_failed', timestamp: 1_700_000_002_000 },
        ],
      },
    })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '診斷' }))
    const list = within(screen.getByRole('region', { name: '診斷' })).getByRole('list')
    const normalItem = within(list).getByText('偵測到聊天室訊息').closest('li')
    const warningItem = within(list).getByText('訊息尚未完成載入').closest('li')
    const dangerItem = within(list).getByText('翻譯失敗').closest('li')

    expect(normalItem?.className).not.toContain('diag-item--warning')
    expect(normalItem?.className).not.toContain('diag-item--danger')
    expect(warningItem?.className).toContain('diag-item--warning')
    expect(dangerItem?.className).toContain('diag-item--danger')
  })

  it('presents only the five newest events in the structured list', async () => {
    stubChrome({
      type: 'diagnostics_snapshot',
      payload: {
        events: [
          { id: 'oldest', stage: 'message_detected', timestamp: 1_700_000_000_000 },
          { id: 'new-1', stage: 'chat_container_ready', timestamp: 1_700_000_001_000 },
          { id: 'new-2', stage: 'translation_requested', timestamp: 1_700_000_002_000 },
          { id: 'new-3', stage: 'translation_received', timestamp: 1_700_000_003_000 },
          { id: 'new-4', stage: 'translation_injected', timestamp: 1_700_000_004_000 },
          { id: 'new-5', stage: 'message_skipped', timestamp: 1_700_000_005_000 },
        ],
      },
    })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '診斷' }))
    const list = within(screen.getByRole('region', { name: '診斷' })).getByRole('list')
    expect(within(list).getAllByRole('listitem')).toHaveLength(5)
    expect(within(list).queryByText('偵測到聊天室訊息')).toBeNull()
  })

  it('does not render raw diagnostic detail in the compact row', async () => {
    const secretDetail = 'RAW_CHAT_TEXT provider-body API_KEY'
    stubChrome({
      type: 'diagnostics_snapshot',
      payload: {
        events: [{ ...diagnosticEvent, detail: secretDetail }],
      },
    })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '診斷' }))
    const region = screen.getByRole('region', { name: '診斷' })
    expect(region.textContent).not.toContain(secretDetail)
  })

  it('shows a loading state while diagnostics are being read', async () => {
    let resolveDiagnostics: ((value: unknown) => void) | undefined
    const diagnosticsResponse = new Promise<unknown>((resolve) => {
      resolveDiagnostics = resolve
    })
    stubChrome(diagnosticsResponse)
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '診斷' }))
    const region = screen.getByRole('region', { name: '診斷' })
    expect(region.textContent).toContain('載入中...')

    resolveDiagnostics?.({ type: 'diagnostics_snapshot', payload: { events: [] } })
    await waitFor(() => expect(region.textContent).toContain('目前沒有可顯示的診斷活動。'))
  })

  it('shows a neutral empty state when there are no diagnostics', async () => {
    stubChrome({ type: 'diagnostics_snapshot', payload: { events: [] } })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '診斷' }))
    const region = screen.getByRole('region', { name: '診斷' })
    expect(region.textContent).toContain('目前沒有可顯示的診斷活動。')
  })
})
