export interface FilterConfig {
  skipEmotesOnly: boolean
  skipCheermotes: boolean
  skipSlashMe: boolean
  skipWhispers: boolean
  skipReplies: boolean
  skipLinksOnly: boolean
  skipNumbersOnly: boolean
  skipSystemMessages: boolean
}

export const FILTER_CONFIG_KEYS: (keyof FilterConfig)[] = [
  'skipEmotesOnly',
  'skipCheermotes',
  'skipSlashMe',
  'skipWhispers',
  'skipReplies',
  'skipLinksOnly',
  'skipNumbersOnly',
  'skipSystemMessages',
]

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  skipEmotesOnly: true,
  skipCheermotes: true,
  skipSlashMe: true,
  skipWhispers: true,
  skipReplies: true,
  skipLinksOnly: true,
  skipNumbersOnly: true,
  skipSystemMessages: true,
}

export const isSlashMe = (text: string): boolean => /^\/me\s/.test(text)

export const isLinksOnly = (text: string): boolean => {
  const trimmed = text.trim()
  if (!trimmed) return false
  const urlRegex = /^https?:\/\/\S+$|^(\S+\.\S+)$/i
  return trimmed.split(/\s+/).every(word => urlRegex.test(word))
}

export const isNumbersOnly = (text: string): boolean => /^[\d\s,.]+$/.test(text.trim())
