import { describe, expect, it, vi } from 'vitest'
import {
  isExtensionContextInvalidatedError,
  safeRuntimeSendMessage,
} from './runtime-messaging'

describe('safeRuntimeSendMessage', () => {
  it('stops when sendMessage synchronously throws an invalidated-context error', async () => {
    const onContextInvalidated = vi.fn()
    const sendMessage = vi.fn(() => {
      throw new Error('Extension context invalidated.')
    })

    const result = await safeRuntimeSendMessage(
      { sendMessage },
      { type: 'diagnostic_event' },
      onContextInvalidated,
    )

    expect(result).toEqual({ kind: 'context_invalidated' })
    expect(onContextInvalidated).toHaveBeenCalledTimes(1)
  })

  it('stops when sendMessage rejects with an invalidated-context error', async () => {
    const onContextInvalidated = vi.fn()
    const sendMessage = vi.fn().mockRejectedValue(new Error('Extension context invalidated.'))

    const result = await safeRuntimeSendMessage(
      { sendMessage },
      { type: 'get_content_settings' },
      onContextInvalidated,
    )

    expect(result).toEqual({ kind: 'context_invalidated' })
    expect(onContextInvalidated).toHaveBeenCalledTimes(1)
  })

  it('returns normal runtime responses unchanged', async () => {
    const onContextInvalidated = vi.fn()
    const response = { type: 'content_settings', payload: { translationEnabled: true } }

    const result = await safeRuntimeSendMessage(
      { sendMessage: vi.fn().mockResolvedValue(response) },
      { type: 'get_content_settings' },
      onContextInvalidated,
    )

    expect(result).toEqual({ kind: 'ok', value: response })
    expect(onContextInvalidated).not.toHaveBeenCalled()
  })

  it('does not misclassify other runtime errors as invalidation', async () => {
    const onContextInvalidated = vi.fn()
    const error = new Error('Could not establish connection. Receiving end does not exist.')

    await expect(safeRuntimeSendMessage(
      { sendMessage: vi.fn().mockRejectedValue(error) },
      { type: 'translate_request' },
      onContextInvalidated,
    )).rejects.toBe(error)

    expect(isExtensionContextInvalidatedError(error)).toBe(false)
    expect(onContextInvalidated).not.toHaveBeenCalled()
  })
})
