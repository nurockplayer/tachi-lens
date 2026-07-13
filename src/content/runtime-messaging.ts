export interface RuntimeMessagePort {
  sendMessage(message: unknown): Promise<unknown>
}

export type RuntimeMessageResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'context_invalidated' }

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' ? message : ''
  }
  return ''
}

export const isExtensionContextInvalidatedError = (error: unknown): boolean =>
  /extension context invalidated/i.test(getErrorMessage(error))

/**
 * Sends a Chrome runtime message while handling both synchronous throws and
 * Promise rejections. Only extension-context invalidation is terminal; every
 * other runtime error is rethrown so callers can retain their normal handling.
 */
export const safeRuntimeSendMessage = async <T>(
  runtime: RuntimeMessagePort,
  message: unknown,
  onContextInvalidated: () => void,
): Promise<RuntimeMessageResult<T>> => {
  try {
    return { kind: 'ok', value: await runtime.sendMessage(message) as T }
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      onContextInvalidated()
      return { kind: 'context_invalidated' }
    }
    throw error
  }
}
