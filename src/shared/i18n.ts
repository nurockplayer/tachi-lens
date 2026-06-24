/** i18n helpers for shortcut labels and popup display text. */

export type I18nKey = 'shortcutToggleTranslation' | 'shortcutToggleDisplayMode'

const locale: Record<string, string> = {
  shortcutToggleTranslation: '切換翻譯 (Ctrl+Shift+T)',
  shortcutToggleDisplayMode: '切換顯示模式 (Ctrl+Shift+M)',
}

export const t = (key: string): string => locale[key] ?? key

const shortcutLabels: Record<string, string> = {
  'toggle-translation': 'Ctrl+Shift+T',
  'toggle-display-mode': 'Ctrl+Shift+M',
}

export const getShortcutLabel = (command: string): string =>
  shortcutLabels[command] ?? `Unknown (${command})`
