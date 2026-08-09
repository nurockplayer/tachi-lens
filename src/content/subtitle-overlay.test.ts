// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COLLAPSE_HANDLE_CLASS,
  DEFAULT_CAPTION_OPACITY,
  ERROR_CHIP_CLASS,
  FINAL_CLASS,
  HIDDEN_CLASS,
  HOST_CLASS,
  INTERIM_CLASS,
  INTERIM_CAPTION_OPACITY,
  OVERLAY_ROOT_CLASS,
  SUBTITLE_HOST_ATTRIBUTE,
  VIEWPORT_CENTERED_CLASS,
  SubtitleOverlay,
} from './subtitle-overlay'
import type { SpeechCaptionPayload, SpeechSettingsUpdatePayload, SpeechStatePayload } from '@/shared/messages'
import { t } from '@/shared/i18n'

const caption = (overrides: Partial<SpeechCaptionPayload>): SpeechCaptionPayload => ({
  id: 'c1',
  text: 'hello',
  interim: true,
  ...overrides,
})

const state = (overrides: Partial<SpeechStatePayload>): SpeechStatePayload => ({
  state: 'capturing',
  ...overrides,
})

const config = (overrides: Partial<SpeechSettingsUpdatePayload>): SpeechSettingsUpdatePayload => overrides

describe('subtitle-overlay', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const mountedOverlay = (): SubtitleOverlay => {
    const overlay = new SubtitleOverlay()
    overlay.mount()
    return overlay
  }

  const host = (): HTMLElement | null =>
    document.querySelector(`[${SUBTITLE_HOST_ATTRIBUTE}]`)

  const rowsEl = (): HTMLElement | null => {
    const hostEl = host()
    return hostEl?.shadowRoot?.querySelector<HTMLElement>('.tachi-lens-caption-rows') ?? null
  }

  const rowEls = (): HTMLElement[] =>
    Array.from(rowsEl()?.children ?? []) as HTMLElement[]

  const errorChip = (): HTMLElement | null => {
    const hostEl = host()
    return hostEl?.shadowRoot?.querySelector<HTMLElement>(`.${ERROR_CHIP_CLASS}`) ?? null
  }

  describe('mount / structure', () => {
    it('mounts idempotently: a second mount creates no duplicate host', () => {
      const overlay = mountedOverlay()
      overlay.mount()
      expect(document.querySelectorAll(`[${SUBTITLE_HOST_ATTRIBUTE}]`)).toHaveLength(1)
    })

    it('creates a shadow root with style, root, collapse handle, rows, and error chip', () => {
      mountedOverlay()
      const hostEl = host()!
      expect(hostEl.className).toContain(HOST_CLASS)
      expect(hostEl.shadowRoot).not.toBeNull()
      const shadow = hostEl.shadowRoot!
      expect(shadow.querySelector('style')).not.toBeNull()
      expect(shadow.querySelector(`.${OVERLAY_ROOT_CLASS}`)).not.toBeNull()
      expect(shadow.querySelector(`.${COLLAPSE_HANDLE_CLASS}`)).not.toBeNull()
      expect(shadow.querySelector('.tachi-lens-caption-rows')).not.toBeNull()
      expect(shadow.querySelector(`.${ERROR_CHIP_CLASS}`)).not.toBeNull()
    })

    it('host is pointer-events none and the collapse handle is clickable', () => {
      const overlay = new SubtitleOverlay({ onToggle: vi.fn() })
      overlay.mount()
      const hostEl = host()!
      expect(hostEl.style.pointerEvents).toBe('none')
      expect(hostEl.style.position).toBe('fixed')
      expect(Number(hostEl.style.zIndex)).toBeGreaterThan(2_000_000_000)
      // Collapse handle sits inside the shadow root and keeps pointer events.
      const handle = hostEl.shadowRoot!.querySelector<HTMLElement>(`.${COLLAPSE_HANDLE_CLASS}`)!
      expect(handle).not.toBeNull()
      // The shadow CSS opts the handle back into pointer events.
      expect(hostEl.shadowRoot!.querySelector('style')!.textContent).toContain(
        `${COLLAPSE_HANDLE_CLASS}`,
      )
    })

    it('never mutates Twitch nodes', () => {
      const player = document.createElement('div')
      player.setAttribute('data-a-target', 'video-player')
      player.textContent = 'player'
      document.body.appendChild(player)
      const beforeAttrs = Array.from(player.attributes).map((a) => [a.name, a.value])
      const beforeChildren = player.childNodes.length

      const overlay = mountedOverlay()
      overlay.setCaption(caption({ text: '字幕', interim: false }))

      expect(Array.from(player.attributes).map((a) => [a.name, a.value])).toEqual(beforeAttrs)
      expect(player.childNodes.length).toBe(beforeChildren)
      expect(player.textContent).toBe('player')
    })
  })

  describe('interim vs final rendering (Spec §10)', () => {
    it('renders an interim caption untranslated at reduced opacity', () => {
      const overlay = mountedOverlay()
      overlay.setCaption(caption({ text: 'draft text', interim: true }))
      const row = rowEls()[0]!
      expect(row).toBeDefined()
      expect(row.classList.contains(INTERIM_CLASS)).toBe(true)
      expect(row.classList.contains(FINAL_CLASS)).toBe(false)
      expect(row.textContent).toBe('draft text')
      expect(row.style.opacity).toBe(String(INTERIM_CAPTION_OPACITY))
    })

    it('flips the interim row to final: same row element, final class, full opacity, translated text', () => {
      const overlay = mountedOverlay()
      overlay.setCaption(caption({ id: 'c-int', text: 'draft', interim: true }))
      const interimRow = rowEls()[0]!

      overlay.setCaption(caption({ id: 'c-fin', text: 'translated', interim: false }))

      expect(rowEls()).toHaveLength(1)
      const finalRow = rowEls()[0]!
      expect(finalRow).toBe(interimRow) // same row element, flipped in place
      expect(finalRow.classList.contains(FINAL_CLASS)).toBe(true)
      expect(finalRow.classList.contains(INTERIM_CLASS)).toBe(false)
      expect(finalRow.textContent).toBe('translated')
      expect(finalRow.style.opacity).toBe('1')
    })

    it('appends a final caption when no interim precedes it', () => {
      const overlay = mountedOverlay()
      overlay.setCaption(caption({ id: 'a', text: 'first', interim: false }))
      overlay.setCaption(caption({ id: 'b', text: 'second', interim: false }))
      expect(rowEls().map((r) => r.textContent)).toEqual(['first', 'second'])
    })
  })

  describe('max-lines rolling', () => {
    it('keeps at most captionMaxLines rows and drops the oldest', () => {
      const overlay = mountedOverlay()
      overlay.setSpeechConfig(config({ captionMaxLines: 2 }))
      for (let i = 1; i <= 3; i++) {
        overlay.setCaption(caption({ id: `c${i}`, text: `line ${i}`, interim: false }))
      }
      expect(rowEls()).toHaveLength(2)
      expect(rowEls().map((r) => r.textContent)).toEqual(['line 2', 'line 3'])
    })

    it('applies captionMaxLines from a later settings broadcast and trims existing rows', () => {
      const overlay = mountedOverlay()
      overlay.setSpeechConfig(config({ captionMaxLines: 3 }))
      for (let i = 1; i <= 3; i++) {
        overlay.setCaption(caption({ id: `c${i}`, text: `line ${i}`, interim: false }))
      }
      overlay.setSpeechConfig(config({ captionMaxLines: 1 }))
      expect(rowEls()).toHaveLength(1)
      expect(rowEls()[0]!.textContent).toBe('line 3')
    })
  })

  describe('dirty-checking', () => {
    it('is a no-op when an identical interim caption is re-emitted', () => {
      const overlay = mountedOverlay()
      overlay.setCaption(caption({ id: 'c1', text: 'same', interim: true }))
      const before = rowEls()[0]!

      // Observe childList mutations on the rows container during the re-emit.
      const rowsContainer = rowsEl()!
      const mutations: MutationRecord[] = []
      const observer = new MutationObserver((records) => mutations.push(...records))
      observer.observe(rowsContainer, { childList: true, subtree: true })

      overlay.setCaption(caption({ id: 'c1', text: 'same', interim: true }))

      observer.disconnect()
      expect(rowEls()).toHaveLength(1)
      expect(rowEls()[0]).toBe(before)
      expect(before.textContent).toBe('same')
      expect(mutations).toHaveLength(0)
    })

    it('is a no-op when an identical final caption is re-emitted', () => {
      const overlay = mountedOverlay()
      overlay.setCaption(caption({ id: 'c1', text: 'final text', interim: false }))
      const before = rowEls()[0]!
      overlay.setCaption(caption({ id: 'c1', text: 'final text', interim: false }))
      expect(rowEls()).toHaveLength(1)
      expect(rowEls()[0]).toBe(before)
    })
  })

  describe('speech state and error chip', () => {
    it('destroys the overlay on idle and remounts on a later non-idle state', () => {
      const overlay = mountedOverlay()
      overlay.setState(state({ state: 'capturing' }))
      expect(host()).not.toBeNull()

      overlay.setState(state({ state: 'idle' }))
      expect(host()).toBeNull()

      overlay.setState(state({ state: 'transcribing' }))
      expect(host()).not.toBeNull()
    })

    it('mounts from idle and shows the sanitized error key on error', () => {
      const overlay = new SubtitleOverlay()
      overlay.setState(state({ state: 'error', errorKey: 'speechErrorAuth' }))
      expect(host()).not.toBeNull()
      const chip = errorChip()!
      expect(chip.classList.contains(HIDDEN_CLASS)).toBe(false)
      expect(chip.textContent).toBe(t('speechErrorAuth'))
    })

    it('auto-hides the error chip on recovery to capturing', () => {
      const overlay = new SubtitleOverlay()
      overlay.setState(state({ state: 'error', errorKey: 'speechErrorAuth' }))
      expect(errorChip()!.classList.contains(HIDDEN_CLASS)).toBe(false)

      overlay.setState(state({ state: 'capturing' }))
      expect(errorChip()!.classList.contains(HIDDEN_CLASS)).toBe(true)
      expect(errorChip()!.textContent).toBe('')
    })

    it('never renders raw text for an unrecognized error key', () => {
      const overlay = new SubtitleOverlay()
      overlay.setState(state({ state: 'error', errorKey: 'raw provider secret message' }))
      const chip = errorChip()!
      expect(chip.classList.contains(HIDDEN_CLASS)).toBe(true)
      expect(chip.textContent).toBe('')
      expect(host()!.shadowRoot!.textContent).not.toContain('raw provider')
    })

    it('mounts on paused and keeps the chip hidden when no errorKey is present', () => {
      const overlay = new SubtitleOverlay()
      overlay.setState(state({ state: 'paused', reason: 'network' }))
      expect(host()).not.toBeNull()
      expect(errorChip()!.classList.contains(HIDDEN_CLASS)).toBe(true)
    })
  })

  describe('caption clearing', () => {
    it('clears rows on silence but keeps the overlay mounted', () => {
      const overlay = mountedOverlay()
      overlay.setCaption(caption({ id: 'c1', text: 'x', interim: false }))
      overlay.clearCaptions('silence')
      expect(rowEls()).toHaveLength(0)
      expect(host()).not.toBeNull()
    })

    it('destroys the overlay on idle', () => {
      const overlay = mountedOverlay()
      overlay.setCaption(caption({ id: 'c1', text: 'x', interim: false }))
      overlay.clearCaptions('idle')
      expect(host()).toBeNull()
    })
  })

  describe('settings-driven rendering', () => {
    it('applies captionOpacity from speechConfig', () => {
      const overlay = mountedOverlay()
      overlay.setSpeechConfig(config({ captionOpacity: 60 }))
      const root = host()!.shadowRoot!.querySelector<HTMLElement>(`.${OVERLAY_ROOT_CLASS}`)!
      expect(root.style.opacity).toBe('0.6')

      overlay.setSpeechConfig(config({ captionOpacity: 0 }))
      expect(root.style.opacity).toBe('0')

      overlay.setSpeechConfig(config({ captionOpacity: 100 }))
      expect(root.style.opacity).toBe('1')
    })

    it('defaults to full opacity', () => {
      mountedOverlay()
      const root = host()!.shadowRoot!.querySelector<HTMLElement>(`.${OVERLAY_ROOT_CLASS}`)!
      expect(root.style.opacity).toBe(String(DEFAULT_CAPTION_OPACITY / 100))
    })

    it('clamps an out-of-range captionOpacity', () => {
      const overlay = mountedOverlay()
      overlay.setSpeechConfig(config({ captionOpacity: 250 }))
      const root = host()!.shadowRoot!.querySelector<HTMLElement>(`.${OVERLAY_ROOT_CLASS}`)!
      expect(root.style.opacity).toBe('1')
    })
  })

  describe('anchoring', () => {
    const mountPlayer = (): HTMLElement => {
      const player = document.createElement('div')
      player.setAttribute('data-a-target', 'video-player')
      player.getBoundingClientRect = () =>
        ({
          x: 100,
          y: 300,
          width: 800,
          height: 450,
          top: 300,
          right: 900,
          bottom: 750,
          left: 100,
          toJSON: () => ({}),
        }) as DOMRect
      document.body.appendChild(player)
      return player
    }

    it('anchors to the video player when present', () => {
      mountPlayer()
      mountedOverlay()
      const hostEl = host()!
      expect(hostEl.style.left).toBe('100px')
      expect(hostEl.style.width).toBe('800px')
      expect(hostEl.classList.contains(VIEWPORT_CENTERED_CLASS)).toBe(false)
    })

    it('falls back to viewport-centered when no player is present', () => {
      mountedOverlay()
      const hostEl = host()!
      expect(hostEl.classList.contains(VIEWPORT_CENTERED_CLASS)).toBe(true)
      expect(hostEl.style.width).toBe('90vw')
      expect(hostEl.style.left).toBe('50%')
      expect(hostEl.style.transform).toBe('translateX(-50%)')
    })

    it('falls back to viewport-centered when the player has zero size', () => {
      const player = document.createElement('div')
      player.setAttribute('data-a-target', 'video-player')
      player.getBoundingClientRect = () =>
        ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }) as DOMRect
      document.body.appendChild(player)
      mountedOverlay()
      expect(host()!.classList.contains(VIEWPORT_CENTERED_CLASS)).toBe(true)
    })

    it('observes the player via ResizeObserver when available', () => {
      const observe = vi.fn()
      const disconnect = vi.fn()
      const observerMock = class {
        observe = observe
        disconnect = disconnect
      }
      vi.stubGlobal('ResizeObserver', observerMock)
      const player = mountPlayer()
      mountedOverlay()
      expect(observe).toHaveBeenCalledWith(player)
      expect(disconnect).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })
  })

  describe('destroy', () => {
    it('removes the host and allows remounting', () => {
      const overlay = mountedOverlay()
      expect(host()).not.toBeNull()
      overlay.destroy()
      expect(host()).toBeNull()
      overlay.mount()
      expect(host()).not.toBeNull()
      expect(document.querySelectorAll(`[${SUBTITLE_HOST_ATTRIBUTE}]`)).toHaveLength(1)
    })

    it('is a no-op when not mounted', () => {
      const overlay = new SubtitleOverlay()
      expect(() => overlay.destroy()).not.toThrow()
    })
  })
})
