/**
 * 设置 → Agent Hub → 剪贴板与翻译: the global hotkey is recorded by pressing it, and what
 * the system actually registered is shown beside what is configured, because the two differ
 * when another program already holds the combination.
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PaletteStore } from '../palette/api.ts'
import type { ConfigFormModel, FieldState } from './form.ts'
import { t } from './i18n.ts'
import { accelerator, normalizeAccelerator } from './hotkey.ts'
import { Row } from './review.tsx'

/** Taken by a Chinese input method before any page sees it, yet a global hotkey still comes first. */
const IME_HOTKEY = 'Ctrl+Space'
const noSubscribe = (): (() => void) => () => {}
const nothing = { status: undefined }

export function HotkeyField(props: { id: string; field: FieldState; disabled: boolean; form: ConfigFormModel; store?: PaletteStore }): ReactNode {
  const { id, field, form, store } = props
  const [recording, setRecording] = useState(false)
  // Typed rather than pressed: undefined while the recorder is used instead.
  const [typed, setTyped] = useState<string | undefined>(undefined)
  const { status } = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? (() => nothing))
  useEffect(() => store?.watch(), [store])
  const value = typeof field.value === 'string' ? field.value : ''
  useEffect(() => {
    if (!recording) return
    const onKey = (event: KeyboardEvent): void => {
      // While recording, DSH's own shortcuts must not see the keys.
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') return setRecording(false)
      const accel = accelerator(event)
      if (accel === undefined) return
      setRecording(false)
      form.edit(id, accel)
      store?.refresh()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, form, id, store])

  let state: string
  let tone: 'bad' | undefined
  const hotkey = status?.hotkey
  const invalid = typed !== undefined && typed.trim() !== '' && normalizeAccelerator(typed) === undefined
  if (invalid) {
    tone = 'bad'
    state = t('palette.hotkey.invalid')
  } else if (typed !== undefined) state = t('palette.hotkey.typing')
  else if (recording) state = t('palette.hotkey.ime')
  else if (status?.error !== undefined) {
    tone = 'bad'
    state = t('palette.hotkey.error', { error: status.error })
  } else if (status?.supported === false) state = t('palette.hotkey.unsupported')
  else if (status === undefined || !status.enabled) state = t('palette.hotkey.off')
  else if (hotkey === null || hotkey === undefined) state = t('palette.hotkey.pending')
  else if (hotkey.ok && hotkey.accel === value) state = t('palette.hotkey.active')
  else if (!hotkey.ok && hotkey.accel === value) {
    tone = 'bad'
    state = t('palette.hotkey.failed', { error: hotkey.error ?? '' }) + (hotkey.active ? t('palette.hotkey.kept', { accel: hotkey.active }) : '')
  } else state = t('palette.hotkey.pending')

  return (
    <Row id={id} field={field} disabled={props.disabled} form={form}>
      <div className="ac-hotkey">
        {typed !== undefined
          ? <input className="ac-input ac-hotkey-input" autoFocus spellCheck={false} aria-label={t('palette.hotkey.type')} aria-invalid={invalid}
              value={typed} placeholder="Ctrl+Space" onChange={(event) => setTyped(event.target.value)} onBlur={() => setTyped(undefined)}
              onKeyDown={(event) => {
                // DSH's own shortcuts must not act on what is typed here.
                event.stopPropagation()
                if (event.key === 'Escape') return setTyped(undefined)
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                const accel = normalizeAccelerator(typed)
                if (accel === undefined) return
                setTyped(undefined)
                form.edit(id, accel)
                store?.refresh()
              }} />
          : value === '' ? <span className="ac-muted">{t('palette.hotkey.none')}</span> : <kbd className="ac-kbd">{value}</kbd>}
        {typed === undefined && <button type="button" id={`ac-field-${id}`} className="ah-btn" disabled={props.disabled} aria-pressed={recording}
          onClick={() => setRecording(!recording)}>{recording ? t('palette.hotkey.recording') : t('palette.hotkey.record')}</button>}
        {/* The one combination the recorder cannot hear under a Chinese input method: offered while it listens. */}
        {recording && <button type="button" className="ac-link" onMouseDown={(event) => event.preventDefault()}
          onClick={() => { setRecording(false); form.edit(id, IME_HOTKEY); store?.refresh() }}>{t('palette.hotkey.useSpace', { accel: IME_HOTKEY })}</button>}
        {typed === undefined && !recording && <button type="button" className="ac-link" disabled={props.disabled} onClick={() => setTyped(value)}>{t('palette.hotkey.type')}</button>}
        {value !== '' && typed === undefined && !recording && <button type="button" className="ac-link" disabled={props.disabled} onClick={() => { form.edit(id, ''); store?.refresh() }}>{t('palette.hotkey.clear')}</button>}
        <p className="ac-hint" role="status" data-invalid={tone === 'bad' ? '' : undefined}>{state}</p>
      </div>
    </Row>
  )
}
