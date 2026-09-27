// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    sendMessage = vi.fn(async (message) => (message as { type?: string }).type === 'get_api_key_preview'
      ? { type: 'api_key_preview', payload: { preview: '', success: true } }
      : { type: 'ok', payload: {} })
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

  it('shows speech preview unavailable when the stored override cannot be read', async () => {
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview') {
        return request.payload?.scope === 'speech'
          ? { type: 'api_key_preview', payload: { preview: '', success: false } }
          : { type: 'api_key_preview', payload: { preview: 'sha***red', success: true } }
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    expect((await screen.findAllByText('API Key 狀態暫時無法確認。重新開啟設定可重試。')).length).toBeGreaterThan(0)
    expect(screen.queryByText('此提供者已設定共用 API Key')).toBeNull()
    expect(screen.queryByText('尚未設定此提供者的 API Key。請至「提供者與 API Key」設定。')).toBeNull()
    expect(screen.queryByText('語音使用此專用 API Key。關閉此設定即可改用共用 API Key。')).toBeNull()
    expect((screen.getByRole('checkbox', { name: '使用語音專用 API Key' }) as HTMLInputElement).disabled).toBe(true)
    expect(getMessageTypes()).not.toContain('save_api_key')
    expect(getMessageTypes()).not.toContain('delete_api_key')
  })

  it('keeps speech status unknown when the shared preview fails but the override is known absent', async () => {
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview') {
        return request.payload?.scope === 'speech'
          ? { type: 'api_key_preview', payload: { preview: '', success: true } }
          : { type: 'api_key_preview', payload: { preview: '', success: false } }
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    expect((await screen.findAllByText('API Key 狀態暫時無法確認。重新開啟設定可重試。')).length).toBeGreaterThan(0)
    expect(screen.queryByText('尚未設定此提供者的 API Key。請至「提供者與 API Key」設定。')).toBeNull()
    expect(screen.queryByText('此提供者已設定共用 API Key')).toBeNull()
    expect((screen.getByRole('checkbox', { name: '使用語音專用 API Key' }) as HTMLInputElement).disabled).toBe(false)
    expect(getMessageTypes()).not.toContain('save_api_key')
    expect(getMessageTypes()).not.toContain('delete_api_key')
  })

  it('shows pending credential status until a scoped speech preview resolves', async () => {
    const user = userEvent.setup()
    const saveRequests: unknown[] = []
    let resolveSpeechPreview!: (value: unknown) => void
    sendMessage.mockImplementation((message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview' && request.payload?.scope === 'speech') {
        return new Promise((resolve) => { resolveSpeechPreview = resolve })
      }
      if (request.type === 'get_api_key_preview') {
        return Promise.resolve({ type: 'api_key_preview', payload: { preview: 'sha***red', success: true } })
      }
      if (request.type === 'save_api_key') saveRequests.push(message)
      return Promise.resolve({ type: 'ok', payload: {} })
    })
    render(<App />)

    await waitForSpeechControls()
    expect(await screen.findByText('正在檢查 API Key 狀態…')).toBeTruthy()
    expect(screen.queryByText('此提供者已設定共用 API Key')).toBeNull()
    expect(screen.queryByText('尚未設定此提供者的 API Key。請至「提供者與 API Key」設定。')).toBeNull()
    expect((screen.getByRole('checkbox', { name: '使用語音專用 API Key' }) as HTMLInputElement).disabled).toBe(true)
    expect(getMessageTypes()).not.toContain('save_api_key')
    expect(getMessageTypes()).not.toContain('delete_api_key')

    await act(async () => {
      resolveSpeechPreview({ type: 'api_key_preview', payload: { preview: '', success: true } })
    })
    expect(await screen.findByText('此提供者已設定共用 API Key')).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: '使用語音專用 API Key' }) as HTMLInputElement).disabled).toBe(false)

    await user.click(screen.getByRole('checkbox', { name: '使用語音專用 API Key' }))
    const input = await screen.findByLabelText('語音專用 API Key') as HTMLInputElement
    await user.type(input, 'ready-after-preview')
    expect(saveRequests).toHaveLength(0)
    fireEvent.blur(input)
    await waitFor(() => expect(saveRequests).toEqual([{
      type: 'save_api_key',
      payload: { providerId: 'gemini', apiKey: 'ready-after-preview', scope: 'speech' },
    }]))
  })

  it('allows a deliberate shared replacement from unavailable state and acknowledges it as known', async () => {
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview') {
        return request.payload?.scope === 'speech'
          ? { type: 'api_key_preview', payload: { preview: '', success: true } }
          : { type: 'api_key_preview', payload: { preview: '', success: false } }
      }
      if (request.type === 'save_api_key') {
        return { type: 'save_api_key_result', payload: { success: true, preview: 'new***key' } }
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    fireEvent.click(document.getElementById('providers-button')!)
    await screen.findAllByText('API Key 狀態暫時無法確認。重新開啟設定可重試。')
    await userEvent.setup().selectOptions(document.getElementById('provider-select')!, 'gemini')
    const input = await screen.findByLabelText('API Key') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'new-shared-secret' } })
    fireEvent.blur(input)

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
      type: 'save_api_key',
      payload: { providerId: 'gemini', apiKey: 'new-shared-secret' },
    }))
    expect(await screen.findByText('此提供者已設定共用 API Key')).toBeTruthy()
    expect(screen.queryByText('API Key 狀態暫時無法確認。重新開啟設定可重試。')).toBeNull()
    expect(input.value).toBe('new***key')
  })

  it('shows a known speech override even when the shared preview is unavailable', async () => {
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview') {
        return request.payload?.scope === 'speech'
          ? { type: 'api_key_preview', payload: { preview: 'spe***ret', success: true } }
          : { type: 'api_key_preview', payload: { preview: '', success: false } }
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    expect(await screen.findByText('語音使用此專用 API Key。關閉此設定即可改用共用 API Key。')).toBeTruthy()
    expect(screen.queryByText('尚未設定此提供者的 API Key。請至「提供者與 API Key」設定。')).toBeNull()
    expect((screen.getByRole('checkbox', { name: '使用語音專用 API Key' }) as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByRole('checkbox', { name: '使用語音專用 API Key' }) as HTMLInputElement).checked).toBe(true)
    expect(getMessageTypes()).not.toContain('save_api_key')
    expect(getMessageTypes()).not.toContain('delete_api_key')
  })

  it('saves a deliberate speech override through the Service Worker and removes only that override', async () => {
    const user = userEvent.setup()
    render(<App />)

    await waitForSpeechControls()
    const overrideToggle = screen.getByRole('checkbox', { name: '使用語音專用 API Key' })
    await user.click(overrideToggle)
    const overrideField = await screen.findByLabelText('語音專用 API Key')
    fireEvent.change(overrideField, { target: { value: 'fixture-speech-override' } })
    fireEvent.blur(overrideField)

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

  it('stages rapid speech input events and saves only the complete draft on blur', async () => {
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview') {
        return { type: 'api_key_preview', payload: { preview: '' } }
      }
      if (request.type === 'save_api_key' && request.payload?.scope === 'speech') {
        return { type: 'save_api_key_result', payload: { success: true, preview: 'com***raft' } }
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    await userEvent.setup().click(screen.getByRole('checkbox', { name: '使用語音專用 API Key' }))
    const input = await screen.findByLabelText('語音專用 API Key') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'c' } })
    fireEvent.change(input, { target: { value: 'com' } })
    fireEvent.change(input, { target: { value: 'complete-draft' } })

    expect(sendMessage.mock.calls.some(([message]) => (message as { type?: string }).type === 'save_api_key')).toBe(false)
    fireEvent.blur(input)
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
      type: 'save_api_key',
      payload: { providerId: 'gemini', apiKey: 'complete-draft', scope: 'speech' },
    }))
    expect(sendMessage.mock.calls.filter(([message]) => (message as { type?: string }).type === 'save_api_key')).toHaveLength(1)
  })

  it('reconciles a failed stable override commit to the previous persisted override', async () => {
    let persistedOverride = ''
    let saveCount = 0
    let speechPreviewReads = 0
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { providerId?: string; scope?: string; apiKey?: string } }
      if (request.type === 'get_api_key_preview') {
        if (request.payload?.scope === 'speech') speechPreviewReads += 1
        return {
          type: 'api_key_preview',
          payload: { preview: request.payload?.scope === 'speech' && persistedOverride ? `${persistedOverride.slice(0, 3)}***` : '' },
        }
      }
      if (request.type === 'save_api_key' && request.payload?.scope === 'speech') {
        saveCount += 1
        if (saveCount === 1) {
          persistedOverride = request.payload.apiKey ?? ''
          return { type: 'save_api_key_result', payload: { success: true, preview: 'pri***ide' } }
        }
        return { type: 'save_api_key_result', payload: { success: false, error: 'Credential save failed' } }
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    await userEvent.setup().click(screen.getByRole('checkbox', { name: '使用語音專用 API Key' }))
    const input = await screen.findByLabelText('語音專用 API Key') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'prior-stable-override' } })
    fireEvent.blur(input)
    await waitFor(() => expect(saveCount).toBe(1))
    await waitFor(() => expect(input.value).toBe('pri***ide'))

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'newer-stable-override' } })
    fireEvent.blur(input)
    await waitFor(() => expect(saveCount).toBe(2))
    await waitFor(() => expect(sendMessage.mock.calls.some(([message]) =>
      (message as { type?: string }).type === 'get_api_key_preview' &&
      (message as { payload?: { scope?: string } }).payload?.scope === 'speech')).toBe(true))

    expect(input.value).toBe('newer-stable-override')
    expect(speechPreviewReads).toBeGreaterThan(1)
    expect(screen.getByText('語音使用此專用 API Key。關閉此設定即可改用共用 API Key。')).toBeTruthy()
    expect(persistedOverride).toBe('prior-stable-override')
  })

  it('preserves the last acknowledged override when failed-save reconciliation is unavailable', async () => {
    let speechPreviewReads = 0
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview') {
        if (request.payload?.scope === 'speech') {
          speechPreviewReads += 1
          if (speechPreviewReads > 1) return { type: 'api_key_preview', payload: { preview: '', success: false } }
          return { type: 'api_key_preview', payload: { preview: 'old***key', success: true } }
        }
        return { type: 'api_key_preview', payload: { preview: '', success: true } }
      }
      if (request.type === 'save_api_key' && request.payload?.scope === 'speech') {
        return { type: 'save_api_key_result', payload: { success: false, error: 'Credential save failed' } }
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    const input = await screen.findByLabelText('語音專用 API Key') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'new-override' } })
    fireEvent.blur(input)
    await waitFor(() => expect(speechPreviewReads).toBe(2))

    expect(screen.getByText('API Key 狀態暫時無法確認。重新開啟設定可重試。')).toBeTruthy()
    expect(screen.queryByText('語音使用此專用 API Key。關閉此設定即可改用共用 API Key。')).toBeNull()
    expect(screen.queryByText('尚未設定此提供者的 API Key。請至「提供者與 API Key」設定。')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('無效')
  })

  it('does not let failed-delete reconciliation replace a newer speech draft', async () => {
    let previewReads = 0
    let resolveDelete!: (value: unknown) => void
    let resolveReconciliation!: (value: unknown) => void
    sendMessage.mockImplementation((message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview' && request.payload?.scope === 'speech') {
        previewReads += 1
        if (previewReads === 1) return Promise.resolve({ type: 'api_key_preview', payload: { preview: 'old***key', success: true } })
        return new Promise((resolve) => { resolveReconciliation = resolve })
      }
      if (request.type === 'delete_api_key' && request.payload?.scope === 'speech') {
        return new Promise((resolve) => { resolveDelete = resolve })
      }
      return Promise.resolve({ type: 'ok', payload: {} })
    })
    render(<App />)

    await waitForSpeechControls()
    const input = await screen.findByLabelText('語音專用 API Key') as HTMLInputElement
    fireEvent.click(screen.getByRole('checkbox', { name: '使用語音專用 API Key' }))
    await waitFor(() => expect(resolveDelete).toBeTypeOf('function'))
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'newer-speech-draft' } })

    await act(async () => {
      resolveDelete({ type: 'delete_api_key_result', payload: { success: false } })
    })
    await waitFor(() => expect(previewReads).toBe(2))
    await act(async () => {
      resolveReconciliation({ type: 'api_key_preview', payload: { preview: 'old***key', success: true } })
    })

    expect(input.value).toBe('newer-speech-draft')
    expect(screen.getByRole('alert').textContent).toContain('無效')
  })

  it('keeps a newer speech draft when an older delete succeeds', async () => {
    let resolveDelete!: (value: unknown) => void
    sendMessage.mockImplementation((message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview' && request.payload?.scope === 'speech') {
        return Promise.resolve({ type: 'api_key_preview', payload: { preview: 'old***key', success: true } })
      }
      if (request.type === 'get_api_key_preview') {
        return Promise.resolve({ type: 'api_key_preview', payload: { preview: '', success: true } })
      }
      if (request.type === 'delete_api_key' && request.payload?.scope === 'speech') {
        return new Promise((resolve) => { resolveDelete = resolve })
      }
      return Promise.resolve({ type: 'ok', payload: {} })
    })
    render(<App />)

    await waitForSpeechControls()
    const input = await screen.findByLabelText('語音專用 API Key') as HTMLInputElement
    fireEvent.click(screen.getByRole('checkbox', { name: '使用語音專用 API Key' }))
    await waitFor(() => expect(resolveDelete).toBeTypeOf('function'))
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'newer-speech-draft' } })
    await act(async () => {
      resolveDelete({ type: 'delete_api_key_result', payload: { success: true } })
    })

    expect(input.value).toBe('newer-speech-draft')
    expect((screen.getByRole('checkbox', { name: '使用語音專用 API Key' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('尚未設定此提供者的 API Key。請至「提供者與 API Key」設定。')).toBeTruthy()
  })

  it('reconciles a lost delete acknowledgement to authoritative override absence', async () => {
    let storedSpeechKey: string | undefined = 'persisted-speech-secret'
    const storedSharedKey = 'persisted-shared-secret'
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview') {
        const speech = request.payload?.scope === 'speech'
        const key = speech ? storedSpeechKey : storedSharedKey
        return {
          type: 'api_key_preview',
          payload: { preview: key ? (speech ? 'spe***ret' : 'sha***ret') : '', success: true },
        }
      }
      if (request.type === 'delete_api_key' && request.payload?.scope === 'speech') {
        storedSpeechKey = undefined
        throw new Error('delete acknowledgement lost after persistence')
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    const toggle = await screen.findByRole('checkbox', { name: '使用語音專用 API Key' })
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true))
    fireEvent.click(toggle)

    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false))
    expect(screen.queryByLabelText('語音專用 API Key')).toBeNull()
    expect(screen.getByText('此提供者已設定共用 API Key')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(storedSpeechKey).toBeUndefined()
    expect(storedSharedKey).toBe('persisted-shared-secret')
  })

  it('completes an empty speech draft deletion when persistence succeeds but its acknowledgement is lost', async () => {
    const user = userEvent.setup()
    const storedKeys: { speech?: string; shared?: string } = {
      speech: 'persisted-speech-secret',
      shared: 'persisted-shared-secret',
    }
    let deleteCount = 0
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview') {
        const speech = request.payload?.scope === 'speech'
        const key = speech ? storedKeys.speech : storedKeys.shared
        return {
          type: 'api_key_preview',
          payload: { preview: key ? (speech ? 'spe***ret' : 'sha***ret') : '', success: true },
        }
      }
      if (request.type === 'delete_api_key') {
        if (request.payload?.scope !== 'speech') {
          storedKeys.shared = undefined
          return { type: 'delete_api_key_result', payload: { success: true } }
        }
        deleteCount += 1
        storedKeys.speech = undefined
        throw new Error('delete acknowledgement lost after persistence')
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    const toggle = await screen.findByRole('checkbox', { name: '使用語音專用 API Key' })
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true))
    const input = await screen.findByLabelText('語音專用 API Key') as HTMLInputElement
    await user.click(input)
    await user.type(input, 'replacement-draft')
    await user.clear(input)
    fireEvent.blur(input)

    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false))
    expect(screen.queryByLabelText('語音專用 API Key')).toBeNull()
    expect(screen.getByText('此提供者已設定共用 API Key')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(deleteCount).toBe(1)
    expect(storedKeys.speech).toBeUndefined()
    expect(storedKeys.shared).toBe('persisted-shared-secret')

    await user.click(toggle)
    const emptyInput = await screen.findByLabelText('語音專用 API Key')
    fireEvent.focus(emptyInput)
    fireEvent.blur(emptyInput)
    expect(deleteCount).toBe(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('preserves a newer speech draft while empty-draft deletion reconciliation is pending', async () => {
    const user = userEvent.setup()
    const storedKeys: { speech?: string; shared?: string } = {
      speech: 'persisted-speech-secret',
      shared: 'persisted-shared-secret',
    }
    let speechPreviewReads = 0
    let resolveReconciliation!: (value: unknown) => void
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview') {
        if (request.payload?.scope === 'speech') {
          speechPreviewReads += 1
          if (speechPreviewReads > 1) {
            return new Promise((resolve) => { resolveReconciliation = resolve })
          }
          return { type: 'api_key_preview', payload: { preview: storedKeys.speech ? 'spe***ret' : '', success: true } }
        }
        return { type: 'api_key_preview', payload: { preview: storedKeys.shared ? 'sha***ret' : '', success: true } }
      }
      if (request.type === 'delete_api_key' && request.payload?.scope === 'speech') {
        storedKeys.speech = undefined
        throw new Error('delete acknowledgement lost after persistence')
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    const toggle = await screen.findByRole('checkbox', { name: '使用語音專用 API Key' })
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true))
    const input = await screen.findByLabelText('語音專用 API Key') as HTMLInputElement
    await user.click(input)
    await user.type(input, 'replacement-draft')
    await user.clear(input)
    fireEvent.blur(input)
    await waitFor(() => expect(speechPreviewReads).toBe(2))

    fireEvent.focus(input)
    await user.type(input, 'newer-draft')
    await act(async () => {
      resolveReconciliation({ type: 'api_key_preview', payload: { preview: '', success: true } })
    })

    expect(input.value).toBe('newer-draft')
    expect((toggle as HTMLInputElement).checked).toBe(true)
    expect(screen.getByLabelText('語音專用 API Key')).toBeTruthy()
    expect(screen.getByText('此提供者已設定共用 API Key')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(storedKeys.speech).toBeUndefined()
    expect(storedKeys.shared).toBe('persisted-shared-secret')
  })

  it('retries an unchanged speech draft after a failed commit', async () => {
    let saveCount = 0
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { scope?: string } }
      if (request.type === 'get_api_key_preview') return { type: 'api_key_preview', payload: { preview: '' } }
      if (request.type === 'save_api_key' && request.payload?.scope === 'speech') {
        saveCount += 1
        return saveCount === 1
          ? { type: 'save_api_key_result', payload: { success: false, error: 'Credential save failed' } }
          : { type: 'save_api_key_result', payload: { success: true, preview: 'ret***ied' } }
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    await userEvent.setup().click(screen.getByRole('checkbox', { name: '使用語音專用 API Key' }))
    const input = await screen.findByLabelText('語音專用 API Key') as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'retry-unchanged' } })
    fireEvent.blur(input)
    await waitFor(() => expect(saveCount).toBe(1))
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'get_api_key_preview', payload: { providerId: 'gemini', scope: 'speech' },
    })))

    fireEvent.focus(input)
    fireEvent.blur(input)
    await waitFor(() => expect(saveCount).toBe(2))
    await waitFor(() => expect(input.value).toBe('ret***ied'))
  })

  it('never copies a shared preview into an enabled but unconfigured speech editor', async () => {
    sendMessage.mockImplementation(async (message) => {
      const request = message as { type?: string; payload?: { providerId?: string; scope?: string; apiKey?: string } }
      if (request.type === 'get_api_key_preview') {
        return { type: 'api_key_preview', payload: { preview: '' } }
      }
      if (request.type === 'save_api_key' && request.payload?.scope !== 'speech') {
        return { type: 'save_api_key_result', payload: { success: true, preview: 'shared***' } }
      }
      if (request.type === 'save_api_key' && request.payload?.scope === 'speech') {
        return { type: 'save_api_key_result', payload: { success: true, preview: 'user***' } }
      }
      return { type: 'ok', payload: {} }
    })
    render(<App />)

    await waitForSpeechControls()
    await userEvent.setup().click(screen.getByRole('checkbox', { name: '使用語音專用 API Key' }))
    const speechInput = await screen.findByLabelText('語音專用 API Key') as HTMLInputElement
    fireEvent.click(document.getElementById('providers-button')!)
    await userEvent.setup().selectOptions(document.getElementById('provider-select')!, 'gemini')
    const sharedInput = await screen.findByLabelText('API Key') as HTMLInputElement
    fireEvent.focus(sharedInput)
    fireEvent.change(sharedInput, { target: { value: 'rotated-shared-secret' } })
    fireEvent.blur(sharedInput)
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
      type: 'save_api_key',
      payload: { providerId: 'gemini', apiKey: 'rotated-shared-secret' },
    }))
    expect(speechInput.value).toBe('')

    fireEvent.focus(speechInput)
    fireEvent.change(speechInput, { target: { value: 'user-entered-override' } })
    fireEvent.blur(speechInput)
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
      type: 'save_api_key',
      payload: { providerId: 'gemini', apiKey: 'user-entered-override', scope: 'speech' },
    }))
    expect(sendMessage.mock.calls.some(([message]) =>
      (message as { type?: string; payload?: { scope?: string; apiKey?: string } }).type === 'save_api_key' &&
      (message as { payload?: { scope?: string; apiKey?: string } }).payload?.scope === 'speech' &&
      (message as { payload?: { scope?: string; apiKey?: string } }).payload?.apiKey?.includes('shared'))).toBe(false)
  })

  it('keeps a speech-override typing draft through save acknowledgements and masks it on blur', async () => {
    const user = userEvent.setup()
    let persistedKey = ''
    const pendingSaves: Array<{ apiKey: string; acknowledge: () => void }> = []
    sendMessage.mockImplementation((message) => {
      const request = message as { type?: string; payload?: { providerId?: string; scope?: string; apiKey?: string } }
      if (request.type === 'get_api_key_preview') {
        return Promise.resolve({ type: 'api_key_preview', payload: { preview: '' } })
      }
      if (request.type === 'save_api_key' && request.payload?.scope === 'speech' && request.payload.apiKey) {
        const apiKey = request.payload.apiKey
        return new Promise((resolve) => {
          pendingSaves.push({
            apiKey,
            acknowledge: () => {
              persistedKey = apiKey
              resolve({ type: 'save_api_key_result', payload: { success: true, preview: '*'.repeat(apiKey.length) } })
            },
          })
        })
      }
      return Promise.resolve({ type: 'ok', payload: {} })
    })
    render(<App />)

    await waitForSpeechControls()
    await user.click(screen.getByRole('checkbox', { name: '使用語音專用 API Key' }))
    const input = await screen.findByLabelText('語音專用 API Key') as HTMLInputElement
    await user.type(input, 'abc')
    expect(pendingSaves).toHaveLength(0)
    fireEvent.blur(input)
    expect(input.value).toBe('abc')
    await waitFor(() => expect(pendingSaves).toHaveLength(1))
    expect(pendingSaves[0]?.apiKey).toBe('abc')
    await act(async () => { pendingSaves[0]!.acknowledge() })
    expect(persistedKey).toBe('abc')
    await waitFor(() => expect(input.value).toBe('***'))
  })

  it('keeps shared and speech credential acknowledgements independent for the same provider', async () => {
    const user = userEvent.setup()
    const pendingSaves: Array<{ scope: string; acknowledge: () => void }> = []
    sendMessage.mockImplementation((message) => {
      const request = message as { type?: string; payload?: { scope?: string; apiKey?: string } }
      if (request.type === 'get_api_key_preview') {
        return Promise.resolve({ type: 'api_key_preview', payload: { preview: '' } })
      }
      if (request.type === 'save_api_key' && request.payload?.apiKey) {
        const scope = request.payload.scope ?? 'shared'
        return new Promise((resolve) => pendingSaves.push({
          scope,
          acknowledge: () => resolve({
            type: 'save_api_key_result',
            payload: { success: true, preview: scope === 'speech' ? 'speech***' : 'shared***' },
          }),
        }))
      }
      return Promise.resolve({ type: 'ok', payload: {} })
    })
    render(<App />)

    await waitForSpeechControls()
    await user.click(screen.getByRole('checkbox', { name: '使用語音專用 API Key' }))
    const speechInput = await screen.findByLabelText('語音專用 API Key') as HTMLInputElement
    fireEvent.change(speechInput, { target: { value: 'speech-secret' } })
    fireEvent.blur(speechInput)
    await waitFor(() => expect(pendingSaves).toHaveLength(1))

    fireEvent.click(document.getElementById('providers-button')!)
    await user.selectOptions(document.getElementById('provider-select')!, 'gemini')
    const sharedInput = await screen.findByLabelText('API Key') as HTMLInputElement
    fireEvent.change(sharedInput, { target: { value: 'shared-secret' } })
    fireEvent.blur(sharedInput)
    await waitFor(() => expect(pendingSaves).toHaveLength(2))

    await act(async () => { pendingSaves[0]!.acknowledge() })
    expect(speechInput.value).toBe('speech***')
    await act(async () => { pendingSaves[1]!.acknowledge() })

    expect(speechInput.value).toBe('speech***')
    expect(screen.getByText('語音使用此專用 API Key。關閉此設定即可改用共用 API Key。')).toBeTruthy()
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
