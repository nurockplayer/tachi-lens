// v0.3 speech subtitle overlay (Spec docs/specs/v0.3-speech-translation.md §6/§10).
//
// Vanilla-DOM shadow-root overlay anchored to the Twitch video player. React is
// popup-only (repo rule), so this module is plain TypeScript/DOM. The shadow
// root isolates the caption DOM from Twitch's React re-renders and global CSS.
//
// Invariants:
//   - The only page-level node we create is the fixed host appended to
//     document.body; we never mutate Twitch nodes (non-destructive invariant).
//   - The host is pointer-events: none except the tiny collapse handle.
//   - Error text is ONLY the fixed i18n key resolved from speech_state.errorKey
//     (never raw provider text, keys, or transcript — Spec §6).
//   - Interim captions render untranslated at reduced opacity; only the final
//     caption is translated (Spec §10).
//   - Idempotent mount + destroy(); the overlay is reusable after destroy.

import { MESSAGE_KEYS, t } from '@/shared/i18n'
import type { MessageKey } from '@/shared/i18n'
import type {
  SpeechCaptionClearedPayload,
  SpeechCaptionPayload,
  SpeechSettingsUpdatePayload,
  SpeechStatePayload,
} from '@/shared/messages'
import { VIDEO_PLAYER, queryFirst } from './twitch-selectors'

/** Host data attribute so tests / e2e can select the overlay in the light DOM. */
export const SUBTITLE_HOST_ATTRIBUTE = 'data-tachi-lens-subtitle-overlay'
export const HOST_CLASS = 'tachi-lens-subtitle-host'
export const VIEWPORT_CENTERED_CLASS = 'tachi-lens-viewport-centered'
export const OVERLAY_ROOT_CLASS = 'tachi-lens-overlay-root'
export const ROW_CLASS = 'tachi-lens-caption-row'
export const INTERIM_CLASS = 'interim'
export const FINAL_CLASS = 'final'
export const ERROR_CHIP_CLASS = 'tachi-lens-error-chip'
export const HIDDEN_CLASS = 'hidden'
export const COLLAPSE_HANDLE_CLASS = 'tachi-lens-collapse-handle'

/** Interim captions render untranslated at this fixed reduced opacity (§10). */
export const INTERIM_CAPTION_OPACITY = 0.55
export const DEFAULT_CAPTION_MAX_LINES = 2
export const DEFAULT_CAPTION_OPACITY = 100
/** High but below Chrome's z-index ceiling; above Twitch player UI. */
export const SUBTITLE_Z_INDEX = 2_147_483_000
/** Overlay sits just above the player's bottom edge. */
export const ANCHOR_MARGIN_PX = 12

interface CaptionRowModel {
  id: string
  text: string
  interim: boolean
}

export interface SubtitleOverlayOptions {
  /** Called when the collapse handle is clicked (e.g. emit speech_control toggle). */
  onToggle?: () => void
  /** Overridable for tests; defaults to the global document. */
  doc?: Document
}

const isKnownMessageKey = (key: string): key is MessageKey =>
  MESSAGE_KEYS.includes(key)

const OVERLAY_CSS = `
:host {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
    'Noto Sans TC', 'Microsoft JhengHei', sans-serif;
  color-scheme: dark;
  text-align: center;
}
.tachi-lens-overlay-root {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  box-sizing: border-box;
  padding: 0 8px;
}
.tachi-lens-collapse-handle {
  position: absolute;
  top: 0;
  right: 8px;
  transform: translateY(-110%);
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  appearance: none;
  border: none;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.5);
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  line-height: 1;
  padding: 3px 9px;
  opacity: 0.65;
}
.tachi-lens-collapse-handle:hover {
  opacity: 1;
}
.tachi-lens-caption-rows {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 100%;
}
.tachi-lens-caption-row {
  max-width: 100%;
  box-sizing: border-box;
  padding: 3px 12px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 18px;
  line-height: 1.35;
  text-align: center;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  overflow-wrap: anywhere;
}
.tachi-lens-error-chip {
  margin-top: 4px;
  padding: 3px 10px;
  border-radius: 4px;
  background: rgba(180, 40, 40, 0.75);
  color: #fff;
  font-size: 13px;
  line-height: 1.3;
  max-width: 100%;
  box-sizing: border-box;
  overflow-wrap: anywhere;
}
.tachi-lens-error-chip.hidden {
  display: none;
}
`

export class SubtitleOverlay {
  private readonly doc: Document
  private readonly onToggle?: () => void
  private readonly handleResize: () => void

  private host: HTMLDivElement | undefined
  private shadow: ShadowRoot | undefined
  private rowsEl: HTMLDivElement | undefined
  private errorEl: HTMLDivElement | undefined
  private rows: CaptionRowModel[] = []
  private captionMaxLines = DEFAULT_CAPTION_MAX_LINES
  private captionOpacity = DEFAULT_CAPTION_OPACITY
  private anchorObserver: ResizeObserver | undefined
  private observedPlayer: HTMLElement | undefined

  constructor(options: SubtitleOverlayOptions = {}) {
    this.doc = options.doc ?? document
    this.onToggle = options.onToggle
    this.handleResize = () => this.updateAnchor()
  }

  get isMounted(): boolean {
    return this.host !== undefined && this.host.isConnected
  }

  /**
   * Mount the overlay host on document.body. Idempotent: a second mount while
   * already mounted is a no-op and creates no duplicate host.
   */
  mount(): void {
    if (this.host) return

    const doc = this.doc
    const host = doc.createElement('div')
    host.className = HOST_CLASS
    host.setAttribute(SUBTITLE_HOST_ATTRIBUTE, '')
    host.style.position = 'fixed'
    host.style.pointerEvents = 'none'
    host.style.zIndex = String(SUBTITLE_Z_INDEX)
    host.style.boxSizing = 'border-box'

    const shadow = host.attachShadow({ mode: 'open' })
    const style = doc.createElement('style')
    style.textContent = OVERLAY_CSS
    shadow.appendChild(style)

    const root = doc.createElement('div')
    root.className = OVERLAY_ROOT_CLASS
    shadow.appendChild(root)

    const handle = doc.createElement('button')
    handle.type = 'button'
    handle.className = COLLAPSE_HANDLE_CLASS
    handle.textContent = '—'
    handle.setAttribute('aria-label', t('speechSection'))
    handle.addEventListener('click', () => this.onToggle?.())
    root.appendChild(handle)

    const rows = doc.createElement('div')
    rows.className = 'tachi-lens-caption-rows'
    root.appendChild(rows)

    const errorChip = doc.createElement('div')
    errorChip.className = ERROR_CHIP_CLASS
    errorChip.classList.add(HIDDEN_CLASS)
    root.appendChild(errorChip)

    doc.body.appendChild(host)

    this.host = host
    this.shadow = shadow
    this.rowsEl = rows
    this.errorEl = errorChip
    this.applyRootOpacity()
    this.updateAnchor()
    doc.defaultView?.addEventListener('resize', this.handleResize)
  }

  /** Remove the host and all listeners. The overlay can be mounted again. */
  destroy(): void {
    this.disconnectAnchorObserver()
    this.doc.defaultView?.removeEventListener('resize', this.handleResize)
    this.host?.remove()
    this.host = undefined
    this.shadow = undefined
    this.rowsEl = undefined
    this.errorEl = undefined
    this.rows = []
  }

  /** Apply a partial speech config broadcast (captionMaxLines / captionOpacity). */
  setSpeechConfig(payload: SpeechSettingsUpdatePayload): void {
    if (typeof payload.captionMaxLines === 'number' && Number.isFinite(payload.captionMaxLines)) {
      this.captionMaxLines = Math.max(1, Math.floor(payload.captionMaxLines))
      if (this.rows.length > this.captionMaxLines) {
        this.enforceMaxLines()
        this.renderRows()
      }
    }
    if (typeof payload.captionOpacity === 'number' && Number.isFinite(payload.captionOpacity)) {
      this.captionOpacity = Math.min(100, Math.max(0, payload.captionOpacity))
      this.applyRootOpacity()
    }
  }

  /**
   * Reflect a speech_state broadcast. `idle` destroys the overlay. Any
   * non-idle state mounts it. The error chip is shown whenever the payload
   * carries a fixed errorKey (error/paused) and auto-hides when it returns to
   * capturing/transcribing (no errorKey).
   */
  setState(payload: SpeechStatePayload): void {
    if (payload.state === 'idle') {
      this.destroy()
      return
    }
    this.mount()
    if (payload.errorKey !== undefined) {
      this.showErrorChip(payload.errorKey)
    } else {
      this.hideErrorChip()
    }
  }

  /** Render a caption (interim untranslated, final translated). */
  setCaption(caption: SpeechCaptionPayload): void {
    this.mount()
    this.applyCaption(caption)
  }

  /** Clear captions; `idle` also destroys the overlay. */
  clearCaptions(reason: SpeechCaptionClearedPayload['reason']): void {
    if (reason === 'idle') {
      this.destroy()
      return
    }
    this.rows = []
    if (this.rowsEl) {
      while (this.rowsEl.firstChild) this.rowsEl.removeChild(this.rowsEl.firstChild)
    }
  }

  /**
   * Recompute the overlay's position from the Twitch video player. Falls back
   * to viewport-centered when no laid-out player is found.
   */
  updateAnchor(): void {
    if (!this.host) return
    const player = queryFirst(this.doc, VIDEO_PLAYER)
    if (player instanceof HTMLElement && player.getBoundingClientRect().width > 0) {
      this.positionFromPlayer(player)
      this.host.classList.remove(VIEWPORT_CENTERED_CLASS)
      this.observePlayer(player)
    } else {
      this.positionViewportCentered()
    }
  }

  // --- internal ---------------------------------------------------------------

  private applyCaption(caption: SpeechCaptionPayload): void {
    const last = this.rows[this.rows.length - 1]
    const { id, text, interim } = caption

    if (interim) {
      if (last?.interim) {
        if (last.text === text) {
          // Dirty-check: an identical interim is already displayed — no DOM
          // write and no model change.
          return
        }
        last.id = id
        last.text = text
      } else {
        this.rows.push({ id, text, interim: true })
      }
    } else if (last?.interim) {
      // Final replaces the most recent interim (the same utterance): the row
      // flips from interim styling to final styling.
      last.id = id
      last.text = text
      last.interim = false
    } else {
      if (last?.text === text) {
        // Dirty-check: an identical final is already displayed — no-op.
        return
      }
      this.rows.push({ id, text, interim: false })
    }

    this.enforceMaxLines()
    this.renderRows()
  }

  /** Keep at most captionMaxLines rows, dropping the oldest. */
  private enforceMaxLines(): void {
    while (this.rows.length > this.captionMaxLines) {
      this.rows.shift()
    }
  }

  /** Diff the row model against the shadow DOM; skip unchanged rows entirely. */
  private renderRows(): void {
    if (!this.rowsEl) return
    const rowsEl = this.rowsEl
    const children = Array.from(rowsEl.children) as HTMLElement[]

    while (children.length < this.rows.length) {
      const row = this.doc.createElement('div')
      row.className = ROW_CLASS
      rowsEl.appendChild(row)
      children.push(row)
    }
    while (children.length > this.rows.length) {
      const stale = children.pop()!
      stale.remove()
    }

    for (let i = 0; i < this.rows.length; i++) {
      const row = children[i]!
      const entry = this.rows[i]!
      const nextText = entry.text
      const nextInterim = entry.interim
      if (row.dataset.tachiText === nextText && row.dataset.tachiInterim === (nextInterim ? '1' : '0')) {
        continue // dirty-check: text and state unchanged — no DOM write
      }
      row.dataset.tachiText = nextText
      row.dataset.tachiInterim = nextInterim ? '1' : '0'
      row.textContent = nextText
      row.classList.toggle(INTERIM_CLASS, nextInterim)
      row.classList.toggle(FINAL_CLASS, !nextInterim)
      row.style.opacity = nextInterim ? String(INTERIM_CAPTION_OPACITY) : '1'
    }
  }

  private applyRootOpacity(): void {
    if (!this.shadow) return
    const root = this.shadow.querySelector<HTMLElement>(`.${OVERLAY_ROOT_CLASS}`)
    if (root) root.style.opacity = String(this.captionOpacity / 100)
  }

  private showErrorChip(errorKey?: string): void {
    if (!this.errorEl) return
    if (!errorKey || !isKnownMessageKey(errorKey)) {
      // Never surface raw text: an unrecognized key renders no chip at all.
      this.hideErrorChip()
      return
    }
    this.errorEl.textContent = t(errorKey)
    this.errorEl.classList.remove(HIDDEN_CLASS)
  }

  private hideErrorChip(): void {
    if (!this.errorEl) return
    this.errorEl.classList.add(HIDDEN_CLASS)
    this.errorEl.textContent = ''
  }

  private positionFromPlayer(player: HTMLElement): void {
    if (!this.host) return
    const rect = player.getBoundingClientRect()
    const win = this.doc.defaultView
    const viewportWidth = win?.innerWidth ?? rect.width
    const viewportHeight = win?.innerHeight ?? rect.bottom
    const width = Math.max(0, Math.min(rect.width, viewportWidth))
    this.host.style.left = `${rect.left}px`
    this.host.style.width = `${width}px`
    this.host.style.top = 'auto'
    this.host.style.bottom = `${Math.max(0, viewportHeight - rect.bottom + ANCHOR_MARGIN_PX)}px`
    this.host.style.transform = ''
  }

  private positionViewportCentered(): void {
    if (!this.host) return
    this.host.style.left = '50%'
    this.host.style.top = 'auto'
    this.host.style.bottom = '10%'
    this.host.style.width = '90vw'
    this.host.style.transform = 'translateX(-50%)'
    this.host.classList.add(VIEWPORT_CENTERED_CLASS)
    this.disconnectAnchorObserver()
  }

  private observePlayer(player: HTMLElement): void {
    if (typeof ResizeObserver === 'undefined') return
    if (this.observedPlayer === player && this.anchorObserver) return
    this.disconnectAnchorObserver()
    this.anchorObserver = new ResizeObserver(() => this.updateAnchor())
    this.anchorObserver.observe(player)
    this.observedPlayer = player
  }

  private disconnectAnchorObserver(): void {
    this.anchorObserver?.disconnect()
    this.anchorObserver = undefined
    this.observedPlayer = undefined
  }
}
