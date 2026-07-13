/**
 * Parse the two Retry-After forms defined by HTTP: delay-seconds and HTTP-date.
 * A past date means no remaining delay; invalid values intentionally fall back to
 * provider-specific retry metadata.
 */
export const parseRetryAfterMs = (value: string | null | undefined, now = Date.now()): number | undefined => {
  const trimmed = value?.trim()
  if (!trimmed) return undefined

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined
  }

  const timestamp = Date.parse(trimmed)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined
}
