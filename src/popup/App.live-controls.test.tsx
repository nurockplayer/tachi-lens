// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_SETTINGS } from '@/storage/settings'
import { App } from './App'

type RuntimeMessage = { type?: string; payload?: unknown }

describe('Popup live translation controls (#174)', () => {
  let localData: Record<string, unknown>
  let localSet: Mock<(value: Record<string, unknown>) => Promise<void>>
  let sendMessage: Mock<(message: RuntimeMessage) => Promise<unknown>>
  let activeTabs: Array<{ url?: string }>
  let rejectUserSettingsWrites: boolean
  let holdFirstUserSettingsWrite: boolean
  let holdSecondUserSettingsWrite: boolean
  let firstUserSettingsWriteStarted: Promise<void>
  let resolveFirstUserSettingsWriteStarted: () => void
  let releaseFirstUserSettingsWrite: () => void
  let secondUserSettingsWriteStarted: Promise<void>
  let resolveSecondUserSettingsWriteStarted: () => void
  let releaseSecondUserSettingsWrite: () => void
  let userSettingsWriteCount: number

  const createUserSettings = (overrides: Partial<typeof DEFAULT_SETTINGS> = {}) => ({
    ...DEFAULT_SETTINGS,
    speechConfig: { ...DEFAULT_SETTINGS.speechConfig },
    ...overrides,
  })

  beforeEach(() => {
    activeTabs = []
    rejectUserSettingsWrites = false
    holdFirstUserSettingsWrite = false
    holdSecondUserSettingsWrite = false
    userSettingsWriteCount = 0
    firstUserSettingsWriteStarted = new Promise((resolve) => {
      resolveFirstUserSettingsWriteStarted = resolve
    })
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstUserSettingsWrite = resolve
    })
    secondUserSettingsWriteStarted = new Promise((resolve) => {
      resolveSecondUserSettingsWriteStarted = resolve
    })
    const secondWriteGate = new Promise<void>((resolve) => {
      releaseSecondUserSettingsWrite = resolve
    })
    localData = { userSettings: createUserSettings() }
    localSet = vi.fn(async (value: Record<string, unknown>) => {
      if (rejectUserSettingsWrites && 'userSettings' in value) {
        throw new Error('storage unavailable')
      }
      if ('userSettings' in value) {
        userSettingsWriteCount += 1
        if (holdFirstUserSettingsWrite && userSettingsWriteCount === 1) {
          resolveFirstUserSettingsWriteStarted()
          await firstWriteGate
        }
        if (holdSecondUserSettingsWrite && userSettingsWriteCount === 2) {
          resolveSecondUserSettingsWriteStarted()
          await secondWriteGate
        }
      }
      Object.assign(localData, value)
    })
    sendMessage = vi.fn(async (message: RuntimeMessage) =>
      message.type === 'get_api_key_preview'
        ? { type: 'api_key_preview', payload: {} }
        : { type: 'ok', payload: {} },
    )

    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: localData[key] })),
          set: localSet,
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
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  const settingsBroadcasts = (): RuntimeMessage[] => sendMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === 'settings_updated')

  const speechBroadcasts = (): RuntimeMessage[] => sendMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === 'speech_settings_updated')

  it('persists and broadcasts chat quick controls without pressing Save Settings', async () => {
    const user = userEvent.setup()
    render(<App />)

    const translationToggle = await screen.findByRole('checkbox', { name: '啟用翻譯' })
    await user.click(translationToggle)
    await user.selectOptions(screen.getByRole('combobox', { name: '目標語言' }), 'en')
    await user.selectOptions(screen.getByRole('combobox', { name: '顯示模式' }), 'hover')

    await waitFor(() => {
      expect(localData.userSettings).toMatchObject({
        translationEnabled: false,
        targetLanguage: 'en',
        displayMode: 'hover',
      })
    })

    expect(translationToggle).toHaveProperty('checked', false)
    expect(settingsBroadcasts().map((message) => message.payload)).toEqual(expect.arrayContaining([
      { translationEnabled: false },
      { targetLanguage: 'en' },
      { displayMode: 'hover' },
    ]))
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'speech_settings_updated' }))
  })

  it('does not let the retained Save action overwrite a pending live chat update', async () => {
    holdFirstUserSettingsWrite = true
    holdSecondUserSettingsWrite = true
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('checkbox', { name: '啟用翻譯' }))
    await firstUserSettingsWriteStarted

    await user.click(screen.getByRole('button', { name: '儲存設定' }))
    releaseFirstUserSettingsWrite()
    await secondUserSettingsWriteStarted
    const savedSettings = localSet.mock.calls[1]?.[0]?.userSettings as typeof DEFAULT_SETTINGS
    expect(savedSettings.translationEnabled).toBe(false)
    releaseSecondUserSettingsWrite()

    await waitFor(() => {
      expect(localData.userSettings).toMatchObject({ translationEnabled: false })
    })
  })

  it('persists and broadcasts speech live controls and safe caption presentation without Save Settings', async () => {
    localData.userSettings = createUserSettings({
      speechConfig: {
        ...DEFAULT_SETTINGS.speechConfig,
        speechEnabled: true,
        speechConsentGranted: true,
      },
    })
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('checkbox', { name: '啟用語音字幕' })
    await user.click(screen.getByRole('checkbox', { name: '啟用語音字幕' }))
    await user.selectOptions(screen.getByRole('combobox', { name: '語音目標語言' }), 'ja')

    fireEvent.click(screen.getByRole('button', { name: '語音與字幕' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: '字幕最大行數' }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '字幕不透明度 (%)' }), { target: { value: '65' } })

    await waitFor(() => {
      expect(localData.userSettings).toMatchObject({
        speechConfig: {
          speechEnabled: false,
          speechTargetLanguage: 'ja',
          captionMaxLines: 3,
          captionOpacity: 65,
        },
      })
    })

    expect(speechBroadcasts().map((message) => message.payload)).toEqual(expect.arrayContaining([
      { speechEnabled: false },
      { speechTargetLanguage: 'ja' },
      { captionMaxLines: 3 },
      { captionOpacity: 65 },
    ]))
    expect(settingsBroadcasts()).toHaveLength(0)
    expect(sendMessage).toHaveBeenCalledWith({ type: 'speech_control', payload: { action: 'stop' } })
  })

  it('keeps the prior active state and shows a bounded error when live persistence fails', async () => {
    rejectUserSettingsWrites = true
    const user = userEvent.setup()
    render(<App />)

    const translationToggle = await screen.findByRole('checkbox', { name: '啟用翻譯' })
    await user.click(translationToggle)

    await waitFor(() => {
      expect(screen.getByText('設定儲存失敗，請再試一次。')).toBeTruthy()
    })
    expect(translationToggle).toHaveProperty('checked', true)
    expect(localData.userSettings).toMatchObject({ translationEnabled: true })
    expect(settingsBroadcasts()).toHaveLength(0)
  })

  it('does not stop speech or show a false disabled state when speech persistence fails', async () => {
    localData.userSettings = createUserSettings({
      speechConfig: {
        ...DEFAULT_SETTINGS.speechConfig,
        speechEnabled: true,
        speechConsentGranted: true,
      },
    })
    rejectUserSettingsWrites = true
    const user = userEvent.setup()
    render(<App />)

    const speechToggle = await screen.findByRole('checkbox', { name: '啟用語音字幕' })
    await user.click(speechToggle)

    await waitFor(() => {
      expect(screen.getByText('設定儲存失敗，請再試一次。')).toBeTruthy()
    })
    expect(speechToggle).toHaveProperty('checked', true)
    expect(localData.userSettings).toMatchObject({ speechConfig: { speechEnabled: true } })
    expect(sendMessage).not.toHaveBeenCalledWith({
      type: 'speech_control',
      payload: { action: 'stop' },
    })
  })

  it('preserves channel precedence and chat/speech isolation for live changes', async () => {
    activeTabs = [{ url: 'https://www.twitch.tv/example_channel' }]
    localData = {
      userSettings: createUserSettings({
        targetLanguage: 'zh-TW',
        speechConfig: {
          ...DEFAULT_SETTINGS.speechConfig,
          speechTargetLanguage: 'ko',
        },
      }),
      perChannelSettings: {
        example_channel: { targetLanguage: 'ja' },
      },
    }
    const user = userEvent.setup()
    render(<App />)

    const chatLanguage = await screen.findByRole('combobox', { name: '目標語言' })
    expect(chatLanguage).toHaveProperty('value', 'ja')
    await user.selectOptions(chatLanguage, 'en')
    await user.selectOptions(screen.getByRole('combobox', { name: '語音目標語言' }), 'vi')

    await waitFor(() => {
      expect(localData.perChannelSettings).toEqual({ example_channel: { targetLanguage: 'en' } })
      expect(localData.userSettings).toMatchObject({
        targetLanguage: 'zh-TW',
        speechConfig: { speechTargetLanguage: 'vi' },
      })
    })
    expect(settingsBroadcasts().map((message) => message.payload)).toContainEqual({
      channelName: 'example_channel',
      targetLanguage: 'en',
    })
    expect(localData.perChannelSettings).not.toHaveProperty('example_channel.speechConfig')
  })
})
