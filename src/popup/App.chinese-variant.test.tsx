// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_SETTINGS } from '@/storage/settings'
import { App } from './App'

const ZH_LOCALES = ['zh', 'zh-TW', 'zh-CN', 'zh-HK', 'zh-Hans', 'zh-Hant']
const NON_ZH_LOCALES = ['en', 'ja', 'ko', 'vi', 'th']

const SKIP_ALL_CHINESE_LABEL = '簡體、繁體都不翻譯'
const TRANSLATE_OTHER_SCRIPT_LABEL = '將另一種中文字體轉換成目標字體'

describe('Popup Chinese variant handling', () => {
  let localData: Record<string, unknown>
  let localSet: Mock<(value: Record<string, unknown>) => Promise<void>>

  const stubChrome = (targetLanguage = DEFAULT_SETTINGS.targetLanguage, activeTabs: Array<{ url?: string }> = []): void => {
    localSet = vi.fn<(value: Record<string, unknown>) => Promise<void>>(async () => undefined)
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
    localData = {
      userSettings: {
        ...DEFAULT_SETTINGS,
        targetLanguage,
      },
    }
  }

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it.each(ZH_LOCALES)('shows the Chinese variant control for the %s target', async (locale) => {
    stubChrome(locale)
    render(<App />)

    expect(await screen.findByText('中文訊息處理')).toBeTruthy()
    expect(screen.getByRole('radio', { name: SKIP_ALL_CHINESE_LABEL })).toBeTruthy()
    expect(screen.getByRole('radio', { name: TRANSLATE_OTHER_SCRIPT_LABEL })).toBeTruthy()
  })

  it.each(NON_ZH_LOCALES)('hides the Chinese variant control for the %s target', async (locale) => {
    stubChrome(locale)
    render(<App />)

    await screen.findByRole('combobox', { name: '目標語言' })
    expect(screen.queryByText('中文訊息處理')).toBeNull()
    expect(screen.queryByRole('radio', { name: SKIP_ALL_CHINESE_LABEL })).toBeNull()
    expect(screen.queryByRole('radio', { name: TRANSLATE_OTHER_SCRIPT_LABEL })).toBeNull()
  })

  it('defaults to skip_all_chinese through the settings layer', async () => {
    stubChrome('zh-TW')
    render(<App />)

    const skipRadio = await screen.findByRole('radio', { name: SKIP_ALL_CHINESE_LABEL })
    expect((skipRadio as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: TRANSLATE_OTHER_SCRIPT_LABEL }) as HTMLInputElement).checked).toBe(false)
  })

  it('selects and persists both Chinese variant values', async () => {
    stubChrome('zh-TW')
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText('中文訊息處理')

    await user.click(screen.getByRole('radio', { name: TRANSLATE_OTHER_SCRIPT_LABEL }))
    await user.click(screen.getByRole('button', { name: '儲存設定' }))

    await waitFor(() => {
      expect(localSet).toHaveBeenCalledWith({
        userSettings: expect.objectContaining({
          chineseVariantMode: 'translate_other_script',
        }),
      })
    })

    await user.click(screen.getByRole('radio', { name: SKIP_ALL_CHINESE_LABEL }))
    await user.click(screen.getByRole('button', { name: '儲存設定' }))

    await waitFor(() => {
      expect(localSet).toHaveBeenCalledWith({
        userSettings: expect.objectContaining({
          chineseVariantMode: 'skip_all_chinese',
        }),
      })
    })
  })

  it('restores the persisted value when the Popup reloads', async () => {
    stubChrome('zh-TW')
    const user = userEvent.setup()
    const firstRender = render(<App />)

    await firstRender.findByText('中文訊息處理')
    await user.click(firstRender.getByRole('radio', { name: TRANSLATE_OTHER_SCRIPT_LABEL }))
    await user.click(firstRender.getByRole('button', { name: '儲存設定' }))
    await waitFor(() => {
      expect(localSet).toHaveBeenCalledWith({
        userSettings: expect.objectContaining({
          chineseVariantMode: 'translate_other_script',
        }),
      })
    })

    cleanup()
    const reloaded = render(<App />)
    const reloadedRadio = await reloaded.findByRole('radio', { name: TRANSLATE_OTHER_SCRIPT_LABEL })
    expect((reloadedRadio as HTMLInputElement).checked).toBe(true)
  })

  it('hides the control for a non-Chinese target without erasing the saved value', async () => {
    stubChrome('zh-TW')
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText('中文訊息處理')
    await user.click(screen.getByRole('radio', { name: TRANSLATE_OTHER_SCRIPT_LABEL }))

    // Switch away from Chinese: control hides, saved chineseVariantMode is untouched.
    await user.selectOptions(screen.getByRole('combobox', { name: '目標語言' }), 'en')
    await user.click(screen.getByRole('button', { name: '儲存設定' }))

    expect(screen.queryByText('中文訊息處理')).toBeNull()
    await waitFor(() => {
      expect(localSet).toHaveBeenCalledWith({
        userSettings: expect.objectContaining({
          targetLanguage: 'en',
          chineseVariantMode: 'translate_other_script',
        }),
      })
    })
  })

  it('restores the prior Chinese variant value when switching back to Chinese', async () => {
    stubChrome('zh-TW')
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText('中文訊息處理')
    await user.click(screen.getByRole('radio', { name: TRANSLATE_OTHER_SCRIPT_LABEL }))

    // Switch to a non-Chinese target then back to Chinese.
    const languageSelect = screen.getByRole('combobox', { name: '目標語言' })
    await user.selectOptions(languageSelect, 'en')
    expect(screen.queryByText('中文訊息處理')).toBeNull()
    await user.selectOptions(languageSelect, 'zh-TW')

    const restoredRadio = await screen.findByRole('radio', { name: TRANSLATE_OTHER_SCRIPT_LABEL })
    expect((restoredRadio as HTMLInputElement).checked).toBe(true)
  })

  it('persists the Chinese variant value through the channel-specific settings path', async () => {
    stubChrome('zh-TW', [{ url: 'https://www.twitch.tv/example_channel' }])
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByLabelText('使用此頻道的專用設定'))
    await user.click(screen.getByRole('radio', { name: TRANSLATE_OTHER_SCRIPT_LABEL }))
    await user.click(screen.getByRole('button', { name: '儲存設定' }))

    await waitFor(() => {
      const channelWrite = localSet.mock.calls
        .map(([value]) => value as Record<string, unknown>)
        .find((value) => 'perChannelSettings' in value)
      const perChannel = channelWrite?.perChannelSettings as Record<string, Record<string, unknown>>
      expect(perChannel.example_channel).toMatchObject({ chineseVariantMode: 'translate_other_script' })
    })
  })

  it('keeps the Chinese variant setting when the target language changes via select', async () => {
    stubChrome('zh-TW')
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText('中文訊息處理')
    fireEvent.click(screen.getByRole('radio', { name: TRANSLATE_OTHER_SCRIPT_LABEL }))

    const languageSelect = screen.getByRole('combobox', { name: '目標語言' })
    await user.selectOptions(languageSelect, 'zh-CN')
    expect(screen.getByText('中文訊息處理')).toBeTruthy()
    expect((screen.getByRole('radio', { name: TRANSLATE_OTHER_SCRIPT_LABEL }) as HTMLInputElement).checked).toBe(true)
  })
})
