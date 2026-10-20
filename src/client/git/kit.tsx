/**
 * Small UI kit for the git pane: a fixed-row virtual list, a context menu
 * that becomes a bottom sheet on phones, a confirm/input dialog, and toasts.
 * Everything portals to <body> so it escapes the sidebar's overflow clipping.
 */

import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject,
  type TouchEvent as ReactTouchEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { t } from './i18n.ts'
import { rowAtLine, rowTop } from './rows.ts'
import { IconClose } from './icons.tsx'
import type { RepoStore, Toast } from './store.ts'
import { copyText } from '../editor/shared.ts'

/** The element's content width, updated at most once per frame. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    setWidth(element.clientWidth)
    let frame = 0
    const observer = new ResizeObserver((entries) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setWidth(entries[0]!.contentRect.width))
    })
    observer.observe(element)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  // Re-observe when the element itself changes (a list that mounts after a skeleton).
  }, [ref, ref.current])
  return width
}

const coarseQuery = typeof matchMedia === 'undefined' ? undefined : matchMedia('(pointer: coarse)')
export function useCoarse(): boolean {
  return useSyncExternalStore(
    (listener) => {
      coarseQuery?.addEventListener('change', listener)
      return () => coarseQuery?.removeEventListener('change', listener)
    },
    () => coarseQuery?.matches ?? false,
  )
}

export interface VirtualListProps {
  count: number
  rowHeight: number
  render: (index: number, style: CSSProperties) => ReactNode
  className?: string
  /** Inner width for horizontally scrolling content (diff lines). */
  innerWidth?: number | string
  overscan?: number
  onEndReached?: () => void
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  listRef?: RefObject<HTMLDivElement>
  role?: string
  label?: string
  /** Content above the rows that scrolls with them. */
  header?: ReactNode
  /**
   * One block of free height inserted after row `after` (an expanded commit's
   * details). Rows below it shift down by `height`.
   */
  gap?: { after: number; height: number; render: (style: CSSProperties) => ReactNode }
  /**
   * Rows of several lines (wrapped diff lines): row i starts at `starts[i]` lines and ends at
   * `starts[i + 1]`, so the array holds count + 1 entries. Not combined with `gap`.
   */
  starts?: readonly number[]
}

export { rowTop } from './rows.ts'

/**
 * Renders only the rows in view (plus overscan). Scroll position is read in a
 * frame callback, so fast flings cost one render per frame at most.
 */
export function VirtualList(props: VirtualListProps): ReactNode {
  const { count, rowHeight, render, overscan = 8 } = props
  const ownRef = useRef<HTMLDivElement>(null)
  const ref = props.listRef ?? ownRef
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(0)
  const [view, setView] = useState({ top: 0, height: 600 })
  const frame = useRef(0)
  const hasHeader = props.header !== undefined
  useLayoutEffect(() => {
    const element = headerRef.current
    if (element === null) return
    setHeaderHeight(element.offsetHeight)
    const observer = new ResizeObserver(() => setHeaderHeight(element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasHeader])
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = (): void => setView({ top: element.scrollTop, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  const onScroll = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const element = ref.current
      if (element !== null) setView({ top: element.scrollTop, height: element.clientHeight })
    })
  }, [ref])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  // One style object per row offset, so memoized rows that kept their place skip re-rendering while scrolling.
  const styles = useRef<{ height: number; byTop: Map<number | string, CSSProperties> }>({ height: rowHeight, byTop: new Map() })
  if (styles.current.height !== rowHeight || styles.current.byTop.size > 4096) styles.current = { height: rowHeight, byTop: new Map() }
  const starts = props.starts
  const styleAt = (offset: number, lines = 1): CSSProperties => {
    const key = lines === 1 ? offset : `${offset}:${lines}`
    let style = styles.current.byTop.get(key)
    if (style === undefined) {
      style = { position: 'absolute', top: offset, height: rowHeight * lines, left: 0, right: 0 }
      styles.current.byTop.set(key, style)
    }
    return style
  }
  // Rows changing height (wrapping toggled, the panel resized) keep the row at the top in place.
  const lastStarts = useRef(starts)
  useLayoutEffect(() => {
    const old = lastStarts.current
    lastStarts.current = starts
    const element = ref.current
    if (old === starts || element === null || element.scrollTop < headerHeight) return
    const line = (element.scrollTop - headerHeight) / rowHeight
    const row = old === undefined ? Math.floor(line) : rowAtLine(old, line)
    if (row >= count || (old !== undefined && row >= old.length - 1)) return
    const into = old === undefined ? line - row : (line - old[row]!) / (old[row + 1]! - old[row]!)
    const next = starts === undefined ? row + into : starts[row]! + into * (starts[row + 1]! - starts[row]!)
    element.scrollTop = next * rowHeight + headerHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starts])
  const top = Math.max(0, view.top - headerHeight)
  const gap = props.gap
  // Row index at a content offset, stepping over the inserted block.
  const indexAt = (y: number): number => {
    if (starts !== undefined) {
      // The row holding line y / rowHeight, plus the fraction into it.
      const line = y / rowHeight
      if (count === 0 || line >= starts[count]!) return count
      const row = rowAtLine(starts, line)
      return row + (line - starts[row]!) / (starts[row + 1]! - starts[row]!)
    }
    if (gap === undefined) return y / rowHeight
    const gapStart = (gap.after + 1) * rowHeight
    if (y < gapStart) return y / rowHeight
    if (y < gapStart + gap.height) return gap.after + 1
    return (y - gap.height) / rowHeight
  }
  const first = Math.max(0, Math.floor(indexAt(top)) - overscan)
  const last = Math.min(count, Math.ceil(indexAt(top + view.height)) + overscan)
  const endReached = props.onEndReached
  useEffect(() => {
    if (endReached !== undefined && count > 0 && last >= count - overscan) endReached()
  }, [last, count, overscan, endReached])
  const rows: ReactNode[] = []
  for (let i = first; i < last; i++) {
    rows.push(render(i, starts === undefined ? styleAt(rowTop(i, rowHeight, gap)) : styleAt(starts[i]! * rowHeight, starts[i + 1]! - starts[i]!)))
  }
  if (gap !== undefined && gap.after < count) {
    // Always rendered while present: it measures itself, and its size moves the rows below.
    rows.push(gap.render({ position: 'absolute', top: (gap.after + 1) * rowHeight, left: 0, right: 0 }))
  }
  return (
    <div ref={ref} className={props.className} onScroll={onScroll} onKeyDown={props.onKeyDown}
      role={props.role} aria-label={props.label} tabIndex={-1} data-gp-scroll="">
      {hasHeader && <div ref={headerRef} data-gp-vheader="">{props.header}</div>}
      <div style={{ position: 'relative', height: (starts === undefined ? count : starts[count]!) * rowHeight + (gap?.height ?? 0), minWidth: props.innerWidth ?? '100%' }}>{rows}</div>
    </div>
  )
}

export type MenuEntry =
  | {
    id: string; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; hint?: string; checked?: boolean
    /** A small button at the row's end with its own id (e.g. a star); shown on hover unless `on`. */
    trail?: { id: string; label: string; icon: ReactNode; on?: boolean }
  }
  | { separator: true }
  | { heading: string }

export interface MenuAnchor {
  x: number
  y: number
  /** Anchor element's rect: the menu opens below it, aligned to its edge. */
  rect?: DOMRect
  align?: 'start' | 'end'
}

const isItem = (entry: MenuEntry): entry is Extract<MenuEntry, { id: string }> => 'id' in entry

export function Menu(props: {
  anchor: MenuAnchor
  entries: MenuEntry[]
  onSelect: (id: string) => void
  onClose: () => void
  label?: string
  /** Extra content above the items (the branch picker's search field). */
  top?: ReactNode
  /** Keep keyboard focus outside (the search field owns it). */
  keepFocus?: boolean
  className?: string
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const coarse = useCoarse()
  const sheet = coarse || (typeof window !== 'undefined' && window.innerWidth < 560)
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  const [active, setActive] = useState(-1)
  const items = props.entries
  useLayoutEffect(() => {
    if (sheet) {
      setStyle({})
      return
    }
    const element = ref.current
    if (element === null) return
    const { anchor } = props
    const width = element.offsetWidth
    const height = element.offsetHeight
    const margin = 8
    let left = anchor.rect ? (anchor.align === 'end' ? anchor.rect.right - width : anchor.rect.left) : anchor.x
    let top = anchor.rect ? anchor.rect.bottom + 4 : anchor.y
    if (left + width > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - margin - width)
    if (left < margin) left = margin
    if (top + height > window.innerHeight - margin) {
      const above = (anchor.rect ? anchor.rect.top - 4 : anchor.y) - height
      top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - height)
    }
    setStyle({ left, top, transformOrigin: `${anchor.x - left}px ${anchor.y - top}px` })
  }, [props.anchor, sheet, items.length])
  useEffect(() => {
    if (!props.keepFocus) ref.current?.focus()
    const down = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) props.onClose()
    }
    const blur = (): void => props.onClose()
    document.addEventListener('pointerdown', down, true)
    // Not on resize: a phone's keyboard opening for the search field resizes the window.
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      window.removeEventListener('blur', blur)
    }
  }, [])
  const move = (step: number): void => {
    if (items.length === 0) return
    let next = active
    for (let n = 0; n < items.length; n++) {
      next = (next + step + items.length) % items.length
      const entry = items[next]!
      if (isItem(entry) && !entry.disabled) break
    }
    setActive(next)
    ref.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
  }
  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') move(1)
    else if (event.key === 'ArrowUp') move(-1)
    else if ((event.key === 'Home' || event.key === 'End') && event.target === ref.current) {
      const indices = items.flatMap((item, index) => isItem(item) && !item.disabled ? [index] : [])
      setActive((event.key === 'Home' ? indices[0] : indices[indices.length - 1]) ?? -1)
    }
    else if (event.key === 'Escape' || event.key === 'Tab') props.onClose()
    else if (event.key === 'Enter' || (event.key === ' ' && event.target === ref.current)) {
      const entry = items[active] ?? items.find((item) => isItem(item) && !item.disabled)
      if (entry !== undefined && isItem(entry) && !entry.disabled) props.onSelect(entry.id)
    } else return
    event.preventDefault()
    event.stopPropagation()
  }
  useEffect(() => { setActive(-1) }, [items])
  return createPortal(
    <>
      {sheet && <div className="gp-scrim" onClick={props.onClose} />}
      <div ref={ref} className={`gp-menu ${props.className ?? ''}`} data-sheet={sheet ? '' : undefined} role="menu"
        aria-label={props.label} aria-activedescendant={active >= 0 ? `${menuId}-${active}` : undefined} tabIndex={-1} style={style} onKeyDown={onKeyDown} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}>
        {props.top}
        <div className="gp-menu-items">
          {items.map((entry, index) => {
            if ('separator' in entry) return <div key={`s${index}`} className="gp-menu-sep" role="separator" />
            if ('heading' in entry) return <div key={`h${index}`} className="gp-menu-heading">{entry.heading}</div>
            const item = (
              <button key={entry.id} id={`${menuId}-${index}`} type="button" role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={entry.checked} className="gp-menu-item" data-index={index}
                data-active={index === active ? '' : undefined} data-danger={entry.danger ? '' : undefined}
                disabled={entry.disabled} onPointerEnter={() => setActive(index)} onClick={() => props.onSelect(entry.id)}>
                <span className="gp-menu-icon">{entry.checked ? '✓' : entry.icon}</span>
                <span className="gp-menu-label">{entry.label}</span>
                {entry.hint !== undefined && <span className="gp-menu-hint">{entry.hint}</span>}
              </button>
            )
            const { trail } = entry
            if (trail === undefined) return item
            return (
              <div key={entry.id} className="gp-menu-row" data-active={index === active ? '' : undefined}>
                {item}
                <button type="button" className="gp-menu-trail" aria-label={trail.label} title={trail.label} aria-pressed={trail.on ?? false}
                  data-on={trail.on ? '' : undefined} onPointerEnter={() => setActive(index)} onClick={() => props.onSelect(trail.id)}>
                  {trail.icon}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </>,
    document.body,
  )
}

/** A row a `combo` field offers under its input. */
export interface Suggestion {
  /** The field's text once it is picked. */
  value: string
  /** What the pick stands for; the dialog's values carry it as `<field id>:pick` while the text still names `tag`. */
  key: string
  /** A short code shown in monospace, e.g. ENG-123. */
  tag: string
  label: string
  detail?: string
  /** Colors the row's dot: started, unstarted, completed, … */
  tone?: string
}

export interface DialogField {
  id: string
  label: string
  /** `combo`: a text field that also offers suggestions as it is typed into (and on focus, for empty text). */
  kind: 'text' | 'textarea' | 'check' | 'radio' | 'combo'
  value?: string | boolean
  placeholder?: string
  /** `detail`: a second, quieter line under the label (what a bot is for). */
  options?: { value: string; label: string; detail?: string; danger?: boolean }[]
  validate?: (value: string) => boolean
  /** Shown under a field `validate` refuses; default: invalid name. */
  error?: string
  suggest?: (query: string, signal: AbortSignal) => Promise<{ title?: string; items: Suggestion[] }>
}

/** A text field with suggestions listed in place (not a floating popup), so it reads the same in a bottom sheet. */
function Combo(props: { field: DialogField; value: string; invalid: boolean; set(value: string): void; setPick(key: string | undefined): void }): ReactNode {
  const { field, value } = props
  const [open, setOpen] = useState(false)
  const [found, setFound] = useState<{ title?: string; items: Suggestion[]; loading: boolean }>({ items: [], loading: false })
  const [active, setActive] = useState(-1)
  const [picked, setPicked] = useState<Suggestion | null>(null)
  const listId = `gp-combo-${field.id}`
  const input = useRef<HTMLInputElement>(null)
  // The dialog focuses its first field as it opens; offer the list then, whether or not a focus event fired.
  useEffect(() => {
    const timer = setTimeout(() => { if (document.activeElement === input.current) setOpen(true) }, 0)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (!open || field.suggest === undefined) return
    const controller = new AbortController()
    setFound((old) => ({ ...old, loading: true }))
    const timer = setTimeout(() => {
      field.suggest!(value.trim(), controller.signal).then((result) => {
        if (controller.signal.aborted) return
        setFound({ ...result, loading: false })
        setActive(-1)
      }, () => { if (!controller.signal.aborted) setFound({ items: [], loading: false }) })
    }, value.trim() === '' ? 0 : 220)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, value, field])
  const pick = (item: Suggestion): void => {
    setPicked(item)
    props.setPick(item.key)
    props.set(item.value)
    setOpen(false)
  }
  const clear = (): void => {
    setPicked(null)
    props.setPick(undefined)
  }
  const items = found.items
  return (
    <div className="gp-field gp-combo">
      <label className="gp-field-label" htmlFor={listId + '-input'}>{field.label}</label>
      {picked !== null && (
        <div className="gp-pick" data-tone={picked.tone}>
          <span className="gp-pick-dot" aria-hidden="true" />
          <span className="gp-pick-tag">{picked.tag}</span>
          <span className="gp-pick-label" title={picked.label}>{picked.label}</span>
          <button type="button" className="ah-icon-btn gp-pick-clear" aria-label={t('unlink')} title={t('unlink')} onClick={clear}><IconClose size={12} /></button>
        </div>
      )}
      <input ref={input} id={listId + '-input'} type="text" className="gp-input" spellCheck={false} autoComplete="off" value={value}
        placeholder={field.placeholder} aria-invalid={props.invalid}
        role="combobox" aria-autocomplete="list" aria-expanded={open && items.length > 0} aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onChange={(event) => {
          const next = event.currentTarget.value
          props.set(next)
          setOpen(true)
          if (picked !== null && !next.toLowerCase().includes(picked.tag.toLowerCase())) clear()
        }}
        onKeyDown={(event) => {
          const shown = open && items.length > 0
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!shown) return setOpen(true)
            event.preventDefault()
            setActive((index) => (event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(-1, index - 1)))
          } else if (event.key === 'Enter' && shown && active >= 0) {
            event.preventDefault()
            event.stopPropagation()
            pick(items[active]!)
          } else if (event.key === 'Escape' && shown) {
            event.stopPropagation()
            setOpen(false)
          }
        }} />
      {props.invalid && <span className="gp-field-error">{t('invalidName')}</span>}
      {open && found.loading && items.length === 0 && (
        <div className="gp-combo-list" aria-busy="true"><div className="gp-skeleton-row" /><div className="gp-skeleton-row" /></div>
      )}
      {open && items.length > 0 && (
        <div className="gp-combo-list" id={listId} role="listbox" aria-label={found.title ?? field.label} aria-busy={found.loading || undefined}>
          {found.title !== undefined && <div className="gp-combo-title" aria-hidden="true">{found.title}</div>}
          {items.map((item, index) => (
            <div key={item.key} id={`${listId}-${index}`} role="option" aria-selected={index === active} className="gp-combo-row" data-tone={item.tone}
              // Keep the input focused, so the pick lands before blur closes the list.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(item)}>
              <span className="gp-pick-dot" aria-hidden="true" />
              <span className="gp-pick-tag">{item.tag}</span>
              <span className="gp-combo-label">{item.label}</span>
              {item.detail !== undefined && <span className="gp-combo-detail">{item.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export interface DialogSpec {
  title: string
  body?: string
  fields?: DialogField[]
  confirm?: string
  danger?: boolean
  /** A line under the fields that follows what is typed (where a new worktree will go). */
  note?: (values: Record<string, string | boolean>) => string | undefined
  onConfirm: (values: Record<string, string | boolean>) => void | Promise<unknown>
}

export function Dialog(props: { spec: DialogSpec; onClose: () => void }): ReactNode {
  const { spec } = props
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(
    (spec.fields ?? []).map((field) => [field.id, field.value ?? (field.kind === 'check' ? false : field.options?.[0]?.value ?? '')]),
  ))
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('input[type="text"], textarea') ?? ref.current?.querySelector<HTMLElement>('[data-gp-primary]')
    first?.focus()
    if (first instanceof HTMLInputElement) first.select()
  }, [])
  const valid = (spec.fields ?? []).every((field) => field.validate === undefined || field.validate(String(values[field.id] ?? '')))
  const submit = (): void => {
    if (!valid) return
    props.onClose()
    void spec.onConfirm(values)
  }
  return createPortal(
    <div className="gp-dialog-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) props.onClose() }}>
      <div ref={ref} className="gp-dialog" role="dialog" aria-modal="true" aria-label={spec.title}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') {
            event.stopPropagation()
            props.onClose()
          } else if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement && !(event.ctrlKey || event.metaKey))) {
            event.preventDefault()
            submit()
          }
        }}>
        <div className="gp-dialog-title">{spec.title}</div>
        {spec.body !== undefined && <p className="gp-dialog-body">{spec.body}</p>}
        {(spec.fields ?? []).map((field) => {
          const set = (value: string | boolean): void => setValues((old) => ({ ...old, [field.id]: value }))
          if (field.kind === 'check') {
            return (
              <label key={field.id} className="gp-check">
                <input type="checkbox" checked={values[field.id] === true} onChange={(e) => set(e.currentTarget.checked)} />
                <span>{field.label}</span>
              </label>
            )
          }
          if (field.kind === 'radio') {
            return (
              <div key={field.id} className="gp-radios" role="radiogroup" aria-label={field.label}>
                {field.options!.map((option) => (
                  <label key={option.value} className="gp-radio" data-danger={option.danger ? '' : undefined}>
                    <input type="radio" name={field.id} checked={values[field.id] === option.value} onChange={() => set(option.value)} />
                    {option.detail === undefined
                      ? <span>{option.label}</span>
                      : <span className="gp-radio-text"><span>{option.label}</span><span className="gp-radio-detail">{option.detail}</span></span>}
                  </label>
                ))}
              </div>
            )
          }
          const invalid = field.validate !== undefined && String(values[field.id] ?? '') !== '' && !field.validate(String(values[field.id]))
          if (field.kind === 'combo') {
            return (
              <Combo key={field.id} field={field} value={String(values[field.id] ?? '')} invalid={invalid} set={set}
                setPick={(key) => setValues((old) => {
                  const { [`${field.id}:pick`]: _dropped, ...rest } = old
                  return key === undefined ? rest : { ...rest, [`${field.id}:pick`]: key }
                })} />
            )
          }
          return (
            <label key={field.id} className="gp-field">
              <span className="gp-field-label">{field.label}</span>
              {field.kind === 'textarea'
                ? <textarea className="gp-input" rows={3} value={String(values[field.id] ?? '')} placeholder={field.placeholder} onChange={(e) => set(e.currentTarget.value)} />
                : <input type="text" className="gp-input" spellCheck={false} autoComplete="off" autoCapitalize="off" value={String(values[field.id] ?? '')}
                  placeholder={field.placeholder} aria-invalid={invalid} onChange={(e) => set(e.currentTarget.value)} />}
              {invalid && <span className="gp-field-error">{field.error ?? t('invalidName')}</span>}
            </label>
          )
        })}
        {spec.note !== undefined && <p className="gp-dialog-note">{spec.note(values)}</p>}
        <div className="gp-dialog-actions">
          <button type="button" className="ah-btn" onClick={props.onClose}>{t('cancel')}</button>
          <button type="button" className="ah-btn" data-variant={spec.danger ? 'danger' : 'primary'} data-gp-primary=""
            disabled={!valid} onClick={submit}>{spec.confirm ?? t('confirm')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function Toasts(props: { repo: RepoStore }): ReactNode {
  const toasts = useSyncExternalStore(props.repo.subscribe, () => props.repo.getSnapshot().toasts)
  if (toasts.length === 0) return null
  return (
    <div className="gp-toasts" aria-live="polite">
      {toasts.map((toast) => <ToastItem key={toast.id} repo={props.repo} toast={toast} />)}
    </div>
  )
}

/** One toast; its countdown pauses while pointed at, focused or expanded so it never vanishes mid-read. */
function ToastItem(props: { repo: RepoStore; toast: Toast }): ReactNode {
  const { repo, toast } = props
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const held = open || hover || focus
  useEffect(() => repo.holdToast(toast.id, held), [repo, toast.id, held])
  return (
    <div className="gp-toast" data-kind={toast.kind} data-held={held ? '' : undefined}
      role={toast.kind === 'error' ? 'alert' : undefined}
      style={{ '--gp-toast-ttl': `${toast.ttl}ms` } as CSSProperties}
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') setHover(true) }}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocus(false) }}>
      <div className="gp-toast-row">
        <span className="gp-toast-text">{toast.text}</span>
        <div className="gp-toast-actions">
          {toast.detail !== undefined && (
            <button type="button" className="gp-link" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? '−' : '…'}
            </button>
          )}
          {toast.action !== undefined && (
            <button type="button" className="gp-link" onClick={() => { repo.dismiss(toast.id); toast.action!.run() }}>{toast.action.label}</button>
          )}
          {toast.kind === 'error' && (
            <button type="button" className="gp-link" onClick={() => { void copyText(toast.detail ?? toast.text).catch(() => {}) }}>{t('copy')}</button>
          )}
          <button type="button" className="ah-icon-btn gp-toast-close" aria-label={t('dismiss')} onClick={() => repo.dismiss(toast.id)}>
            <IconClose size={14} />
          </button>
        </div>
      </div>
      {open && <pre className="gp-toast-detail">{toast.detail}</pre>}
      <span className="gp-toast-ttl" aria-hidden="true" />
    </div>
  )
}

/**
 * Context menu triggers: right-click everywhere, long-press on touch.
 * Returns handlers to spread on the row.
 */
let pressTimer: ReturnType<typeof setTimeout> | undefined

export function pressHandlers(open: (anchor: MenuAnchor) => void): {
  onContextMenu: (event: ReactMouseEvent) => void
  onTouchStart: (event: ReactTouchEvent) => void
  onTouchEnd: () => void
  onTouchMove: () => void
} {
  return {
    onContextMenu(event) {
      event.preventDefault()
      open({ x: event.clientX, y: event.clientY })
    },
    onTouchStart(event) {
      const touch = event.touches[0]
      if (touch === undefined) return
      const { clientX: x, clientY: y } = touch
      clearTimeout(pressTimer)
      pressTimer = setTimeout(() => {
        navigator.vibrate?.(10)
        open({ x, y })
      }, 480)
    },
    onTouchEnd() { clearTimeout(pressTimer) },
    onTouchMove() { clearTimeout(pressTimer) },
  }
}

/** Copy text and toast it. */
export function copy(repo: RepoStore, text: string): void {
  void copyText(text).then(() => repo.toast('ok', t('copied')), () => repo.toast('error', t('copyFailed')))
}
