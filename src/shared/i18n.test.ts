import { describe, expect, it } from 'vitest'
import { getShortcutLabel, t } from './i18n'

describe('i18n', () => {
  it('returns shortcut label for toggle-translation command', () => {
    expect(getShortcutLabel('toggle-translation')).toBeTypeOf('string')
    expect(getShortcutLabel('toggle-translation')).toBeTruthy()
  })

  it('returns shortcut label for toggle-display-mode command', () => {
    expect(getShortcutLabel('toggle-display-mode')).toBeTypeOf('string')
    expect(getShortcutLabel('toggle-display-mode')).toBeTruthy()
  })

  it('returns an unknown label for unrecognized commands', () => {
    expect(getShortcutLabel('unknown-command')).toBeTruthy()
  })

  it('t function returns localized text for existing keys', () => {
    expect(t('shortcutToggleTranslation')).toBeTypeOf('string')
    expect(t('shortcutToggleDisplayMode')).toBeTypeOf('string')
  })

  it('t function returns the key itself for unknown keys', () => {
    expect(t('nonexistent' as any)).toBe('nonexistent')
  })
})
