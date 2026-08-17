/**
 * Popup presentation primitives (Issue #172).
 *
 * Small, stateless building blocks for the Popup visual system. They
 * exist so repeated UI patterns share one implementation and one style
 * source (popup.css) instead of divergent inline styling. All primitives
 * are pure — no effects, no external state — except Accordion, which owns
 * its own open/closed UI state.
 *
 * Deliberate contract notes:
 * - ToggleRow renders a NATIVE checkbox (role "checkbox") styled as a
 *   switch; the "switch" role is intentionally NOT used so existing
 *   checkbox-based queries and the `checked` property keep working.
 * - SegmentedControl renders NATIVE radio inputs inside labels; the
 *   accessible name of each radio is exactly its option label text.
 * - StatusBadge / InlineNotice keep the full status text inside ONE
 *   text node so text-based queries match the combined label + value.
 */

import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

/* ---- Layout ------------------------------------------------------ */

export function Card({ children, className }: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={['card', className].filter(Boolean).join(' ')}>
      {children}
    </div>
  )
}

export function SectionHeader({ children, level = 2, className }: {
  children: ReactNode
  level?: HeadingLevel
  className?: string
}): React.JSX.Element {
  const Tag = ('h' + level) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  return (
    <Tag className={['section-header', className].filter(Boolean).join(' ')}>
      {children}
    </Tag>
  )
}

/* ---- Form fields -------------------------------------------------- */

export function Field({ id, label, hint, children, className }: {
  id: string
  label: string
  hint?: string
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={['field', className].filter(Boolean).join(' ')}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  )
}

export function SelectField({ id, label, value, onChange, children, className }: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <Field id={id} label={label} className={className}>
      <select
        id={id}
        className="control"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </Field>
  )
}

export function TextInput({ id, label, value, onChange, type = 'text', placeholder, monospace, className, autoComplete }: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
  monospace?: boolean
  className?: string
  autoComplete?: string
}): React.JSX.Element {
  return (
    <Field id={id} label={label} className={className}>
      <input
        id={id}
        className={['control', monospace ? 'control--mono' : ''].filter(Boolean).join(' ')}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}

export function NumberField({ id, label, value, onChange, min, max, className }: {
  id: string
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  className?: string
}): React.JSX.Element {
  return (
    <Field id={id} label={label} className={className}>
      <input
        id={id}
        className="control"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  )
}

/* ---- Buttons ------------------------------------------------------ */

export interface ButtonProps {
  children: ReactNode
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  type?: 'button' | 'submit' | 'reset'
  variant?: 'primary' | 'secondary' | 'danger' | 'danger-outline'
  size?: 'md' | 'sm'
  disabled?: boolean
  className?: string
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'secondary',
  size = 'md',
  disabled,
  className,
}: ButtonProps): React.JSX.Element {
  const classes = [
    'btn',
    `btn--${variant}`,
    size === 'sm' ? 'btn--sm' : '',
    className,
  ].filter(Boolean).join(' ')
  return (
    <button type={type} className={classes} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

export function IconButton({ children, onClick, ariaLabel, title, bare, className }: {
  children: ReactNode
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  ariaLabel: string
  title?: string
  bare?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={['icon-btn', bare ? 'icon-btn--bare' : '', className].filter(Boolean).join(' ')}
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
    >
      {children}
    </button>
  )
}

/* ---- Secret input (mono input + visibility toggle) ------------------ */

export function SecretInput({ id, label, value, onChange, placeholder, visible, onToggleVisible, showLabel, hideLabel }: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  visible: boolean
  onToggleVisible: () => void
  showLabel: string
  hideLabel: string
}): React.JSX.Element {
  return (
    <Field id={id} label={label}>
      <div className="secret-input">
        <input
          id={id}
          className="control control--mono"
          type={visible ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        <IconButton ariaLabel={visible ? hideLabel : showLabel} title={visible ? hideLabel : showLabel} onClick={onToggleVisible}>
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </IconButton>
      </div>
    </Field>
  )
}

/* ---- Toggle row (native checkbox styled as a switch) -------------- */

export function ToggleRow({ label, checked, onChange, compact, className }: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  compact?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <label className={['toggle-row', compact ? 'toggle-row--compact' : '', className].filter(Boolean).join(' ')}>
      <input
        className="toggle-row__input"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-row__track" aria-hidden="true">
        <span className="toggle-row__thumb" />
      </span>
      <span className="toggle-row__label">{label}</span>
    </label>
  )
}

/* ---- Segmented control (native radios, segmented styling) --------- */

export interface SegmentOption {
  value: string
  id: string
  label: string
}

export function SegmentedControl({ groupLabel, name, options, value, onChange, className }: {
  groupLabel: string
  name: string
  options: readonly SegmentOption[]
  value: string
  onChange: (value: string) => void
  className?: string
}): React.JSX.Element {
  return (
    <div className={['segmented', className].filter(Boolean).join(' ')} role="radiogroup" aria-label={groupLabel}>
      {options.map((option) => (
        <Fragment key={option.value}>
          <input
            className="segmented__input"
            type="radio"
            id={option.id}
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <label className="segmented__label" htmlFor={option.id}>
            {option.label}
          </label>
        </Fragment>
      ))}
    </div>
  )
}

/* ---- Status badge -------------------------------------------------- */

export function StatusBadge({ tone = 'neutral', showDot = true, children, className }: {
  tone?: Tone
  showDot?: boolean
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span className={['badge', `badge--${tone}`, showDot ? '' : 'badge--no-dot', className].filter(Boolean).join(' ')}>
      {children}
    </span>
  )
}

/* ---- Inline notice -------------------------------------------------- */

export function InlineNotice({ tone = 'info', children, className }: {
  tone?: 'info' | 'success' | 'warning' | 'danger'
  children: ReactNode
  className?: string
}): React.JSX.Element {
  const icon =
    tone === 'success' ? <CheckIcon />
    : tone === 'warning' || tone === 'danger' ? <AlertIcon />
    : <InfoIcon />
  return (
    <div className={['notice', `notice--${tone}`, className].filter(Boolean).join(' ')}>
      <span className="notice__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="notice__body">{children}</span>
    </div>
  )
}

/* ---- Empty state ----------------------------------------------------- */

export function EmptyState({ children, className }: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={['empty-state', className].filter(Boolean).join(' ')}>
      {children}
    </div>
  )
}

/* ---- Accordion (progressively disclosed section) ---------------------- */

/**
 * Collapsible section for progressive disclosure (#173). The header is a real
 * button (keyboard operable) with aria-expanded/aria-controls; the content is
 * a labelled region that uses the `hidden` attribute when collapsed, so
 * collapsed content is removed from the accessibility tree and tab order.
 * Owns only its open/closed UI state — never touches persistence.
 */
export function Accordion({ id, title, defaultOpen = false, children, className }: {
  id: string
  title: string
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const buttonId = `${id}-button`
  const contentId = `${id}-content`
  return (
    <section className={['accordion', className].filter(Boolean).join(' ')}>
      <h2 className="accordion__heading">
        <button
          type="button"
          id={buttonId}
          className="accordion__header"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span className="accordion__title">{title}</span>
          <ChevronIcon className={open ? 'accordion__chevron accordion__chevron--open' : 'accordion__chevron'} />
        </button>
      </h2>
      <div
        id={contentId}
        role="region"
        aria-labelledby={buttonId}
        className="accordion__content"
        hidden={!open}
      >
        {children}
      </div>
    </section>
  )
}

/* ---- Icons (inline SVG, aria-hidden) --------------------------------- */

const iconProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

export function EyeIcon(): React.JSX.Element {
  return (
    <svg {...iconProps}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function EyeOffIcon(): React.JSX.Element {
  return (
    <svg {...iconProps}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </svg>
  )
}

export function CloseIcon(): React.JSX.Element {
  return (
    <svg {...iconProps} width={12} height={12}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  )
}

export function CheckIcon(): React.JSX.Element {
  return (
    <svg {...iconProps}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

export function AlertIcon(): React.JSX.Element {
  return (
    <svg {...iconProps}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  )
}

export function InfoIcon(): React.JSX.Element {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  )
}

export function ChevronIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg {...iconProps} className={className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}
