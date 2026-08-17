// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_SETTINGS, maskApiKey } from '@/storage/settings'
import { PROVIDER_IDS } from '@/providers/types'
import { listProviderMetadata } from '@/providers/registry'
import { FILTER_CONFIG_KEYS } from '@/content/message-filter'
import type { FilterConfig } from '@/content/message-filter'
import { App, extractChannelFromUrl } from './App'

describe('extractChannelFromUrl', () => {
  it('extracts channel name from a standard Twitch URL', () => {
    expect(extractChannelFromUrl('https://www.twitch.tv/somerchannel')).toBe('somerchannel')
  })

  it('extracts channel name from twitch.tv base domain', () => {
    expect(extractChannelFromUrl('https://twitch.tv/mychannel')).toBe('mychannel')
  })

  it('returns lowercase channel name', () => {
    expect(extractChannelFromUrl('https://www.twitch.tv/SomeChannel')).toBe('somechannel')
  })

  it('returns undefined for non-Twitch URLs', () => {
    expect(extractChannelFromUrl('https://www.youtube.com')).toBeUndefined()
  })

  it('returns undefined for Twitch root URL', () => {
    expect(extractChannelFromUrl('https://www.twitch.tv')).toBeUndefined()
  })

  it('returns undefined for Twitch subdomain pages', () => {
    expect(extractChannelFromUrl('https://dashboard.twitch.tv')).toBeUndefined()
  })

  it('returns undefined for empty string', () => {
    expect(extractChannelFromUrl('')).toBeUndefined()
  })

  it('ignores sub-paths after channel name', () => {
    expect(extractChannelFromUrl('https://www.twitch.tv/somerchannel/video/12345')).toBe(
      'somerchannel',
    )
  })
})

describe('Popup App', () => {
  it('exports a valid React component', () => {
    expect(App).toBeTypeOf('function')
  })

  it('has a default target language of zh-TW', () => {
    expect(DEFAULT_SETTINGS.targetLanguage).toBe('zh-TW')
  })

  it('knows all provider IDs', () => {
    expect(PROVIDER_IDS).toHaveLength(4)
    expect(PROVIDER_IDS).toContain('gemini')
    expect(PROVIDER_IDS).toContain('deepseek')
    expect(PROVIDER_IDS).toContain('openai')
    expect(PROVIDER_IDS).toContain('claude')
  })

  it('lists provider metadata for the popup form', () => {
    const providers = listProviderMetadata()
    expect(providers).toHaveLength(4)
    for (const p of providers) {
      expect(p.id).toBeTypeOf('string')
      expect(p.displayName).toBeTypeOf('string')
      expect(p.models.length).toBeGreaterThanOrEqual(1)
      expect(p.defaultModel).toBeTypeOf('string')
    }
  })

  it('defaults to deepseek as provider', () => {
    expect(DEFAULT_SETTINGS.selectedProvider).toBe('deepseek')
    expect(DEFAULT_SETTINGS.selectedModel).toBe('deepseek-v4-flash')
  })

  it('defaults to below display mode', () => {
    expect(DEFAULT_SETTINGS.displayMode).toBe('below')
  })

  it('defaults to speech-disabled with the Gemini speech provider', () => {
    expect(DEFAULT_SETTINGS.speechConfig.speechEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.speechConfig.speechProvider).toBe('gemini')
    expect(DEFAULT_SETTINGS.speechConfig.speechTargetLanguage).toBe('zh-TW')
  })

  it('masks API keys correctly for display', () => {
    expect(maskApiKey('sk-abc123xyz')).toMatch(/^sk-.*xyz$/)
    expect(maskApiKey('sk-abc123xyz')).not.toContain('abc123')
  })

  it('has a provider option for each registered provider', () => {
    const providers = listProviderMetadata()
    const providerOptions = providers.map((p) => ({
      value: p.id,
      label: p.displayName,
    }))

    expect(providerOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'gemini' }),
        expect.objectContaining({ value: 'deepseek' }),
        expect.objectContaining({ value: 'openai' }),
        expect.objectContaining({ value: 'claude' }),
      ]),
    )
  })

  describe('filter toggles', () => {
    const filterDefaults: Record<keyof FilterConfig, boolean> = {
      skipEmotesOnly: true,
      skipCheermotes: true,
      skipSlashMe: true,
      skipWhispers: true,
      skipReplies: true,
      skipLinksOnly: true,
      skipNumbersOnly: true,
      skipSystemMessages: true,
    }

    it('all filter config keys are present in DEFAULT_SETTINGS', () => {
      for (const key of FILTER_CONFIG_KEYS) {
        expect(DEFAULT_SETTINGS).toHaveProperty(key)
      }
    })

    it('DEFAULT_SETTINGS has correct filter key types (boolean)', () => {
      for (const key of FILTER_CONFIG_KEYS) {
        expect(typeof DEFAULT_SETTINGS[key]).toBe('boolean')
      }
    })

    it('all filter toggles default to true (skip enabled)', () => {
      for (const [key, expected] of Object.entries(filterDefaults)) {
        expect(DEFAULT_SETTINGS[key as keyof FilterConfig]).toBe(expected)
      }
    })

    it('FILTER_CONFIG_KEYS has all 8 entries', () => {
      expect(FILTER_CONFIG_KEYS).toHaveLength(8)
    })

    it('filter config key types match FilterConfig interface', () => {
      const keys: (keyof FilterConfig)[] = [
        'skipEmotesOnly',
        'skipCheermotes',
        'skipSlashMe',
        'skipWhispers',
        'skipReplies',
        'skipLinksOnly',
        'skipNumbersOnly',
        'skipSystemMessages',
      ]
      expect(keys).toHaveLength(8)
    })
  })
})

describe('Popup speech consent flow (#162)', () => {
  let localData: Record<string, unknown>
  let localSet: Mock<(value: Record<string, unknown>) => Promise<void>>
  let sendMessage: Mock<(message: { type?: string; payload?: unknown }) => Promise<unknown>>
  let runtimeListeners: Array<(message: unknown) => void>

  beforeEach(() => {
    localSet = vi.fn<(value: Record<string, unknown>) => Promise<void>>(async () => undefined)
    sendMessage = vi.fn(async () => ({ type: 'ok', payload: {} }))
    runtimeListeners = []
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
          addListener: vi.fn((listener: (message: unknown) => void) => {
            runtimeListeners.push(listener)
          }),
          removeListener: vi.fn(),
        },
      },
      tabs: {
        query: vi.fn(async () => []),
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

  const dispatchRuntimeMessage = (message: unknown): void => {
    for (const listener of runtimeListeners) listener(message)
  }

  it('first enable shows the consent panel and does not start capture', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('checkbox', { name: '啟用語音字幕' })
    const checkbox = screen.getByRole('checkbox', { name: '啟用語音字幕' })

    await user.click(checkbox)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('錄製目前 Twitch 分頁的音訊')).toBeTruthy()
    expect(screen.getByText('將音訊傳送至你所選的 BYOK 提供者進行轉錄')).toBeTruthy()
    expect(screen.getByText('音訊不會被儲存或保留')).toBeTruthy()
    expect(screen.getByText('用量會依你的 API Key 計費')).toBeTruthy()
    expect(screen.getByText('錄製期間會持續顯示 REC 標記')).toBeTruthy()

    // Nothing started, nothing persisted. The switch reflects the user's intent
    // (checked) while the panel is open, but capture has not begun.
    expect(getMessageTypes()).not.toContain('speech_control')
    expect(localSet).not.toHaveBeenCalled()
    expect((checkbox as HTMLInputElement).checked).toBe(true)
  })

  it('confirm sends speech_control start and persists speechEnabled + consent', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('checkbox', { name: '啟用語音字幕' })
    await user.click(screen.getByRole('checkbox', { name: '啟用語音字幕' }))
    await user.click(screen.getByRole('button', { name: '啟用並開始' }))

    await waitFor(() => {
      expect(getMessageTypes()).toContain('speech_control')
    })
    const startCall = sendMessage.mock.calls
      .map(([message]) => message as { type?: string; payload?: unknown })
      .find((message) => message.type === 'speech_control')
    expect(startCall?.payload).toEqual({ action: 'start' })

    await waitFor(() => {
      expect(localSet).toHaveBeenCalled()
    })
    const saved = localSet.mock.calls
      .map(([value]) => (value as Record<string, unknown>).userSettings)
      .find((settings) => (settings as Record<string, unknown>).speechConfig !== undefined)
    expect(saved).toMatchObject({
      speechConfig: { speechEnabled: true, speechConsentGranted: true },
    })
    expect(screen.getByRole('checkbox', { name: '啟用語音字幕' })).toHaveProperty('checked', true)
  })

  it('cancel closes the panel and starts nothing', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('checkbox', { name: '啟用語音字幕' })
    await user.click(screen.getByRole('checkbox', { name: '啟用語音字幕' }))
    expect(screen.getByRole('dialog')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(getMessageTypes()).not.toContain('speech_control')
    expect(localSet).not.toHaveBeenCalled()
    expect((screen.getByRole('checkbox', { name: '啟用語音字幕' }) as HTMLInputElement).checked).toBe(false)
  })

  it('toggle off with no consent sent does not persist or start', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('checkbox', { name: '啟用語音字幕' })
    await user.click(screen.getByRole('checkbox', { name: '啟用語音字幕' }))
    // Toggle back off while the panel is open.
    await user.click(screen.getByRole('checkbox', { name: '啟用語音字幕' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(getMessageTypes()).not.toContain('speech_control')
    expect(localSet).not.toHaveBeenCalled()
  })

  it('chat settings remain untouched by the consent flow', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('checkbox', { name: '啟用語音字幕' })
    await user.click(screen.getByRole('checkbox', { name: '啟用語音字幕' }))
    await user.click(screen.getByRole('button', { name: '啟用並開始' }))

    await waitFor(() => {
      expect(localSet).toHaveBeenCalled()
    })
    const saved = localSet.mock.calls
      .map(([value]) => (value as Record<string, unknown>).userSettings)
      .find((settings) => (settings as Record<string, unknown>).speechConfig !== undefined)
    expect(saved).toMatchObject({
      selectedProvider: DEFAULT_SETTINGS.selectedProvider,
      selectedModel: DEFAULT_SETTINGS.selectedModel,
      targetLanguage: DEFAULT_SETTINGS.targetLanguage,
      translationEnabled: DEFAULT_SETTINGS.translationEnabled,
    })
  })

  it('renders the live speech state from a speech_state message', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('checkbox', { name: '啟用語音字幕' })
    await user.click(screen.getByRole('checkbox', { name: '啟用語音字幕' }))
    await user.click(screen.getByRole('button', { name: '啟用並開始' }))

    dispatchRuntimeMessage({ type: 'speech_state', payload: { state: 'capturing' } })
    expect(await screen.findByText(/語音字幕狀態/)).toBeTruthy()
    expect(screen.getByText('語音字幕錄製中')).toBeTruthy()
  })

  it('renders error state from a speech_state message with the fixed error label', async () => {
    const user = userEvent.setup()
    render(<App />)

    await screen.findByRole('checkbox', { name: '啟用語音字幕' })
    await user.click(screen.getByRole('checkbox', { name: '啟用語音字幕' }))
    await user.click(screen.getByRole('button', { name: '啟用並開始' }))

    dispatchRuntimeMessage({
      type: 'speech_state',
      payload: { state: 'error', reason: 'budget_exhausted', errorKey: 'speechErrorBudget' },
    })
    expect(await screen.findByText(/語音字幕狀態/)).toBeTruthy()
    // Reuses the fixed #160 error key, never a raw provider message.
    expect(screen.getByText('語音時段或每日用量已達上限')).toBeTruthy()
  })
})
