// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_SETTINGS } from '@/storage/settings'
import { App } from './App'

describe('Popup speech settings', () => {
  let localData: Record<string, unknown>
  let localSet: Mock<(value: Record<string, unknown>) => Promise<void>>
  let sendMessage: Mock<(message: { type?: string; payload?: unknown }) => Promise<unknown>>
  let activeTabs: Array<{ url?: string }>

  beforeEach(() => {
    localSet = vi.fn<(value: Record<string, unknown>) => Promise<void>>(async () => undefined)
    sendMessage = vi.fn(async () => ({ type: 'ok', payload: {} }))
    activeTabs = []
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
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const getMessageTypes = (): string[] =>
    sendMessage.mock.calls.map(([message]) => (message as { type?: string }).type ?? '')

  // Speech quick controls (toggle + target language) live on the dashboard;
  // the deep speech config lives in the collapsed "語音與字幕" accordion
  // (progressive disclosure, #173). Expand it before role-based queries.
  const waitForSpeechControls = async (): Promise<void> => {
    await screen.findByRole('checkbox', { name: '啟用語音字幕' })
    fireEvent.click(screen.getByRole('button', { name: '語音與字幕' }))
  }

  it('renders the speech subtitles section with all controls', async () => {
    render(<App />)

    await waitForSpeechControls()
    expect(screen.getByRole('checkbox', { name: '啟用語音字幕' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '語音提供者' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '語音模型' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: '語音目標語言' })).toBeTruthy()
    expect(screen.getByRole('spinbutton', { name: '字幕最大行數' })).toBeTruthy()
    expect(screen.getByRole('spinbutton', { name: '字幕不透明度 (%)' })).toBeTruthy()
    expect(screen.getByRole('spinbutton', { name: '單次語音時段上限 (分鐘)' })).toBeTruthy()
  })

  it('defaults the speech provider select to Gemini only', async () => {
    render(<App />)

    await waitForSpeechControls()
    const providerSelect = screen.getByRole('combobox', { name: '語音提供者' })
    const options = Array.from(providerSelect.querySelectorAll('option')).map((o) => o.value)
    expect(options).toEqual(['gemini'])
    expect((providerSelect as HTMLSelectElement).value).toBe('gemini')
  })

  it('shows that speech inherits the shared provider key without fetching full key material', async () => {
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { providerId?: string; scope?: string } }
      if (request.type === 'get_api_key_preview' && request.payload?.providerId === 'gemini') {
        return {
          type: 'api_key_preview',
          payload: { preview: request.payload.scope === 'speech' ? '' : 'gem***red' },
        }
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    expect(await screen.findByText('此提供者已設定共用 API Key')).toBeTruthy()
    const requests = sendMessage.mock.calls.map(([message]) => message as { type?: string; payload?: unknown })
    expect(requests).toContainEqual(expect.objectContaining({
      type: 'get_api_key_preview',
      payload: { providerId: 'gemini', scope: 'speech' },
    }))
    expect(JSON.stringify(requests)).not.toContain('gemini-real-key')
  })

  it('saves a deliberate speech override through the Service Worker and removes only that override', async () => {
    const user = userEvent.setup()
    render(<App />)

    await waitForSpeechControls()
    const overrideToggle = screen.getByRole('checkbox', { name: '使用語音專用 API Key' })
    await user.click(overrideToggle)
    const overrideField = await screen.findByLabelText('語音專用 API Key')
    fireEvent.change(overrideField, { target: { value: 'fixture-speech-override' } })

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'save_api_key',
        payload: { providerId: 'gemini', apiKey: 'fixture-speech-override', scope: 'speech' },
      })
    })

    await user.click(overrideToggle)
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'delete_api_key',
        payload: { providerId: 'gemini', scope: 'speech' },
      })
    })
    expect(sendMessage).not.toHaveBeenCalledWith({
      type: 'delete_api_key',
      payload: { providerId: 'gemini' },
    })
  })

  it('persists speech config and broadcasts speech_settings_updated on save', async () => {
    const user = userEvent.setup()
    render(<App />)

    await waitForSpeechControls()
    // First enable shows the consent panel; the confirm click grants consent
    // and persists speechEnabled (the checkbox alone never enables capture).
    await user.click(screen.getByRole('checkbox', { name: '啟用語音字幕' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '啟用並開始' }))
    await user.selectOptions(screen.getByRole('combobox', { name: '語音模型' }), 'gemini-2.5-pro')
    await user.selectOptions(screen.getByRole('combobox', { name: '語音目標語言' }), 'en')
    fireEvent.change(screen.getByRole('spinbutton', { name: '字幕最大行數' }), { target: { value: '3' } })
    await user.click(screen.getByRole('button', { name: '儲存設定' }))

    await waitFor(() => {
      expect(localSet).toHaveBeenCalledWith({
        userSettings: expect.objectContaining({
          speechConfig: expect.objectContaining({
            speechEnabled: true,
            speechModel: 'gemini-2.5-pro',
            speechTargetLanguage: 'en',
            captionMaxLines: 3,
          }),
        }),
      })
    })
    await waitFor(() => {
      expect(getMessageTypes()).toContain('speech_settings_updated')
    })
    const speechBroadcast = sendMessage.mock.calls
      .map(([message]) => message as { type?: string; payload?: unknown })
      .filter((message) => message.type === 'speech_settings_updated')
      .at(-1)
    expect(speechBroadcast?.payload).toMatchObject({
      speechEnabled: true,
      speechModel: 'gemini-2.5-pro',
      speechTargetLanguage: 'en',
      captionMaxLines: 3,
    })
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'settings_updated' }),
    )
  })

  it('changing speech config does not alter chat provider, model, or target language', async () => {
    const user = userEvent.setup()
    render(<App />)

    await waitForSpeechControls()
    await user.selectOptions(screen.getByRole('combobox', { name: '語音模型' }), 'gemini-2.5-pro')
    await user.selectOptions(screen.getByRole('combobox', { name: '語音目標語言' }), 'ja')
    await user.click(screen.getByRole('button', { name: '儲存設定' }))

    await waitFor(() => {
      expect(localSet).toHaveBeenCalledWith({
        userSettings: expect.objectContaining({
          selectedProvider: 'deepseek',
          selectedModel: 'auto',
          targetLanguage: 'zh-TW',
          speechConfig: expect.objectContaining({
            speechModel: 'gemini-2.5-pro',
            speechTargetLanguage: 'ja',
          }),
        }),
      })
    })
  })

  it('does not put speech config in the per-channel override', async () => {
    activeTabs = [{ url: 'https://www.twitch.tv/example_channel' }]
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByLabelText('使用此頻道的專用設定'))
    await user.click(screen.getByRole('checkbox', { name: '啟用語音字幕' }))
    await user.click(screen.getByRole('button', { name: '儲存設定' }))

    await waitFor(() => {
      const channelWrite = localSet.mock.calls
        .map(([value]) => value as Record<string, unknown>)
        .find((value) => 'perChannelSettings' in value)
      const perChannel = channelWrite?.perChannelSettings as Record<string, Record<string, unknown>>
      expect(perChannel.example_channel).not.toHaveProperty('speechConfig')
    })
  })
})
