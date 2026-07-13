// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_SETTINGS } from '@/storage/settings'
import { App } from './App'

describe('Popup Gemini quota profiles', () => {
  const localSet = vi.fn<(value: Record<string, unknown>) => Promise<void>>(async () => undefined)
  let localData: Record<string, unknown>
  let activeTabs: Array<{ url?: string }>

  beforeEach(() => {
    const userSettings = {
      ...DEFAULT_SETTINGS,
      selectedProvider: 'gemini' as const,
      selectedModel: 'gemini-2.5-pro',
      geminiQuota: { ...DEFAULT_SETTINGS.geminiQuota, requestsPerMinute: 2 },
      geminiQuotaProfiles: {
        'gemini-2.5-flash': { ...DEFAULT_SETTINGS.geminiQuota, requestsPerMinute: 5 },
        'gemini-2.5-pro': { ...DEFAULT_SETTINGS.geminiQuota, requestsPerMinute: 2 },
      },
    }
    localData = { userSettings }
    activeTabs = []
    localSet.mockClear()
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
        sendMessage: vi.fn(async (message: { type?: string }) =>
          message.type === 'get_api_key_preview'
            ? { type: 'api_key_preview', payload: {} }
            : { type: 'ok', payload: {} },
        ),
        onMessage: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      tabs: {
        query: vi.fn(async () => activeTabs),
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('edits and saves quota for the selected Gemini model without changing another model', async () => {
    const user = userEvent.setup()
    render(<App />)

    const rpm = await screen.findByLabelText('每分鐘請求上限 (RPM)')
    expect((rpm as HTMLInputElement).value).toBe('2')
    expect(screen.getByText('Gemini 模型配額: Gemini 2.5 Pro')).toBeTruthy()

    fireEvent.change(rpm, { target: { value: '7' } })
    await user.click(screen.getByRole('button', { name: '儲存設定' }))

    await waitFor(() => {
      expect(localSet).toHaveBeenCalledWith({
        userSettings: expect.objectContaining({
          geminiQuotaProfiles: expect.objectContaining({
            'gemini-2.5-flash': expect.objectContaining({ requestsPerMinute: 5 }),
            'gemini-2.5-pro': expect.objectContaining({ requestsPerMinute: 7 }),
          }),
        }),
      })
    })
  })

  it('persists quota globally when channel-specific settings are enabled', async () => {
    activeTabs = [{ url: 'https://www.twitch.tv/example_channel' }]
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByLabelText('使用此頻道的專用設定'))
    fireEvent.change(screen.getByLabelText('每分鐘請求上限 (RPM)'), { target: { value: '9' } })
    await user.click(screen.getByRole('button', { name: '儲存設定' }))

    await waitFor(() => {
      expect(localSet).toHaveBeenCalledWith({
        userSettings: expect.objectContaining({
          geminiQuotaProfiles: expect.objectContaining({
            'gemini-2.5-pro': expect.objectContaining({ requestsPerMinute: 9 }),
          }),
        }),
      })
    })
    const channelWrite = localSet.mock.calls
      .map(([value]) => value as Record<string, unknown>)
      .find((value) => 'perChannelSettings' in value)
    const perChannel = channelWrite?.perChannelSettings as Record<string, Record<string, unknown>>
    expect(perChannel.example_channel).not.toHaveProperty('geminiQuota')
    expect(perChannel.example_channel).not.toHaveProperty('geminiQuotaProfiles')
  })

  it('keeps the legacy quota mirror aligned when switching models without editing a field', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.selectOptions(await screen.findByLabelText('模型'), 'gemini-2.5-flash')
    await user.click(screen.getByRole('button', { name: '儲存設定' }))

    await waitFor(() => {
      expect(localSet).toHaveBeenCalledWith({
        userSettings: expect.objectContaining({
          selectedModel: 'gemini-2.5-flash',
          geminiQuota: expect.objectContaining({ requestsPerMinute: 5 }),
        }),
      })
    })
  })
})
