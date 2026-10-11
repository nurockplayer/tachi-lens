/** Resolve legacy placeholder ids at the test runtime boundary to the request's real id. */
export const sendWithCorrelatedTestResponse = async (
  sender: unknown,
  message: unknown,
): Promise<unknown> => {
  const response = await (sender as (message: unknown) => Promise<unknown>)(message)
  if (!isRecord(message) || message.type !== 'translate_request' || !isRecord(message.payload) ||
    !isRecord(response) || response.type !== 'translate_response' || !isRecord(response.payload) ||
    response.payload.messageId !== 'any-id' || typeof message.payload.messageId !== 'string') {
    return response
  }
  return {
    ...response,
    payload: { ...response.payload, messageId: message.payload.messageId },
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
