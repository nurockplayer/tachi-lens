// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '@/storage/settings'
import { App } from './App'

describe('Popup dashboard layout (#173)', () => {
  let localData: Record<string, unknown>
  let localSet: Mock<(value: Record<string, unknown>) => Promise<void>>
  let sendMessage: Mock<(message: { type?: string; payload?: unknown }) => Promise<unknown>>
  let activeTabs: Array<{ url?: string }>

  const stubChrome = (): void => {
    activeTabs = activeTabs ?? []
    localSet = vi.fn<(value: Record<string, unknown>) => Promise<void>>(async () => undefined)
    sendMessage = vi.fn(async (message: { type?: string }) =>
      message.type === 'get_api_key_preview'
        ? { type: 'api_key_preview', payload: {} }
        : { type: 'ok', payload: {} },
    )
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: localData[key] })),
          set: vi.fn(async (value: Record<string, unknown>) => {
            Object.assign(localData, value)
            await localSet(value)
          }),
        },
      },
      runtime: {
        sendMessage,
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      tabs: {
        query: vi.fn(async () => activeTabs),
      },
    })
    localData = { userSettings: { ...DEFAULT_SETTINGS } }
  }

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const expand = (title: string): void => {
    fireEvent.click(screen.getByRole('button', { name: title }))
  }

  it('opens on a dashboard primary view: header + quick controls + advanced sections', async () => {
    stubChrome()
    render(<App />)

    // Header: product identity + concise live status.
    await screen.findByRole('heading', { level: 1, name: 'tachi-lens' })
    expect(screen.getByText('啟用中')).toBeTruthy()

    // Quick controls sit on the primary surface.
    expect(screen.getByRole('checkbox', { name: '啟用翻譯' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '目標語言' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '顯示模式' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '啟用語音字幕' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '語音目標語言' })).toBeTruthy()

    // Advanced controls are grouped into named collapsible sections.
    for (const title of ['提供者與 API Key', '訊息過濾', 'Gemini 配額健康狀態', '診斷', '頻道專屬設定', '語音與字幕']) {
      expect(screen.getByRole('button', { name: title })).toBeTruthy()
    }
  })

  it('collapses advanced sections by default and reveals content on expand', async () => {
    stubChrome()
    render(<App />)

    await screen.findByRole('button', { name: '提供者與 API Key' })

    // Collapsed: provider/key controls are not in the accessibility tree.
    expect(screen.queryByRole('combobox', { name: '翻譯提供者' })).toBeNull()

    expand('提供者與 API Key')
    expect(screen.getByRole('combobox', { name: '翻譯提供者' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '模型' })).toBeTruthy()
    expect(screen.getByLabelText('API Key')).toBeTruthy()
  })

  it('shows the active channel and provider → target summary in the header', async () => {
    activeTabs = [{ url: 'https://www.twitch.tv/example_channel' }]
    stubChrome()
    render(<App />)

    await screen.findByRole('heading', { level: 1, name: 'tachi-lens' })
    const header = screen.getByRole('banner')
    expect(within(header).getByText('頻道：')).toBeTruthy()
    expect(within(header).getByText('example_channel')).toBeTruthy()
    // Provider display name + target label appear in the status summary.
    expect(within(header).getByText(/DeepSeek → 繁體中文/)).toBeTruthy()
  })
})
