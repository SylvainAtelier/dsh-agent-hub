/**
 * The clipboard and translation window, hosted by the native helper (native/dsh-type, --palette).
 * No framework: the page is kept small because it stays resident, throttled, between uses.
 * Everything that can be answered here (search, selection) is; the helper answers the rest, and
 * sends only the rows that changed since the page last heard from it.
 */

import css from './page.css'
import { LANGS, type Lang } from '../../palette/translate.ts'
import { MESSAGES, type Key } from './text.ts'

/**
 * `pin` is 0, or when the entry was pinned: pinned entries keep the order they were pinned in.
 * An image has a negative id, no text, its size in pixels (`img`) and in bytes; it is never pinned.
 */
interface Wire { id: number; text: string; cut: boolean; app: string; pin: number; at: number; img?: [number, number]; size?: number }
interface Item extends Wire { n: string }
interface Sync { items?: Wire[]; rows?: Wire[]; gone?: number[] }
interface Bot { id: string; name: string }
/** A finished translation, as the helper keeps it; `n` is what the search looks in. */
interface Translation { id: number; src: string; out: string; lang: string; bot: string; at: number; n: string }
type Mode = 'clip' | 'tr'
type Side = 'pin' | 'rec'

declare global {
  interface Window {
    ipc: { postMessage(message: string): void }
    __r(message: Record<string, unknown>): void
  }
}

const zh = navigator.language.toLowerCase().startsWith('zh')
const t = (key: Key, vars: Record<string, string | number> = {}): string =>
  MESSAGES[zh ? 'zh' : 'en'][key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''))
const mac = /mac/i.test(navigator.platform)
const MOD = mac ? '⌘' : 'Ctrl'
const ALT = mac ? '⌥' : 'Alt'
/** How long a row that just arrived stays marked. */
const FRESH_MS = 1600
/** An image unused this long is dropped by the helper (db::IMAGE_TTL_MS). */
const IMAGE_TTL_MS = 5 * 3_600_000
/** Where the helper serves an image's PNG: its `clip` scheme, which WebView2 maps to http. */
const imageUrl = (id: number): string => (mac ? `clip://localhost/${id}` : `http://clip.localhost/${id}`)

const send = (message: Record<string, unknown>): void => window.ipc.postMessage(JSON.stringify(message))
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const ICON = {
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5M9 3h6l-1 7 3 3v2H7v-2l3-3z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>',
  del: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
}

document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }))
document.documentElement.lang = zh ? 'zh' : 'en'
document.body.innerHTML = `
<div id="app">
  <header>
    <div class="tabs" role="tablist">
      <button class="tab" id="tab-clip" role="tab" aria-controls="clip" type="button"></button>
      <button class="tab" id="tab-tr" role="tab" aria-controls="tr" type="button"></button>
    </div>
    <input id="q" type="search" autocomplete="off" spellcheck="false" />
    <span class="where" id="where"></span>
  </header>
  <main>
    <section class="pane" id="clip" role="tabpanel" aria-labelledby="tab-clip">
      <div class="cols">
        <div class="col" id="col-pin" data-side="pin">
          <h2 id="h-pin"><span></span><small></small></h2>
          <div class="list" id="list-pin" role="listbox" aria-labelledby="h-pin" tabindex="-1"><div class="spacer"></div><p class="empty" hidden></p></div>
        </div>
        <div class="col" id="col-rec" data-side="rec">
          <h2 id="h-rec"><span></span><small></small></h2>
          <div class="list" id="list-rec" role="listbox" aria-labelledby="h-rec" tabindex="-1"><div class="spacer"></div><p class="empty" hidden></p></div>
        </div>
      </div>
      <div class="look" id="look" hidden><img id="look-img" alt="" draggable="false" /></div>
      <div class="preview" id="preview">
        <div class="pv-bar">
          <small id="pv-meta"></small>
          <button class="pv-btn" id="ed-start" type="button"></button>
          <span class="pv-acts" id="ed-acts" hidden><button class="pv-btn" id="ed-cancel" type="button"></button><button class="pv-btn primary" id="ed-save" type="button"></button></span>
        </div>
        <textarea id="pv-text" readonly spellcheck="false"></textarea>
        <img id="pv-img" alt="" draggable="false" hidden />
      </div>
    </section>
    <section class="pane" id="tr" role="tabpanel" aria-labelledby="tab-tr">
      <div class="cols">
        <div class="col" id="col-hist">
          <h2 id="h-hist"><span></span><small></small></h2>
          <div class="list" id="list-hist" role="listbox" aria-labelledby="h-hist" tabindex="-1"><p class="empty" hidden></p></div>
        </div>
        <div class="tr-main">
          <textarea id="src" spellcheck="false"></textarea>
          <div class="options">
            <div class="seg" role="radiogroup" id="langs"></div>
            <select id="bot"></select>
            <button class="go ghost" id="copy" type="button"></button>
            <button class="go" id="go" type="button"></button>
          </div>
          <div class="out" id="out" role="status" aria-live="polite"></div>
        </div>
      </div>
    </section>
  </main>
  <footer id="keys"></footer>
  <div id="toast" role="status" aria-live="polite"></div>
  <div id="live" class="sr" role="status" aria-live="polite"></div>
  <div class="grip" id="grip" hidden></div>
</div>`

const q = el<HTMLInputElement>('q')
const pvMeta = el('pv-meta')
/** The preview is also the editor: the text seen is the text changed, where it is. */
const pvText = el<HTMLTextAreaElement>('pv-text')
const pvImg = el<HTMLImageElement>('pv-img')
const edText = pvText
const preview = el('preview')
const look = el('look')
const lookImg = el<HTMLImageElement>('look-img')
const src = el<HTMLTextAreaElement>('src')
const out = el('out')
const go = el<HTMLButtonElement>('go')
const copy = el<HTMLButtonElement>('copy')
const botSelect = el<HTMLSelectElement>('bot')
const toast = el('toast')

const prepare = (text: string): string => text.normalize('NFKC').toLowerCase()
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 160)
const byPinTime = (a: Item, b: Item): number => a.pin - b.pin || b.at - a.at
const byRecency = (a: Item, b: Item): number => b.at - a.at

function ago(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return t('now')
  if (minutes < 60) return t('minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  return hours < 48 ? t('hours', { n: hours }) : new Date(at).toLocaleDateString()
}

/** What is left of an image's time, said as briefly as the row allows. */
function left(at: number): string {
  const minutes = Math.max(1, Math.ceil((at + IMAGE_TTL_MS - Date.now()) / 60_000))
  return t('left', { t: minutes > 90 ? t('leftHours', { n: Math.round(minutes / 60) }) : t('leftMinutes', { n: minutes }) })
}

function bytes(size: number): string {
  return size >= 1 << 20 ? `${(size / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`
}

const titleOf = (item: Item): string => (item.img ? t('imageTitle', { w: item.img[0], h: item.img[1] }) : flat(item.text))

function highlight(parent: HTMLElement, text: string, query: string): void {
  parent.textContent = ''
  const at = query === '' ? -1 : prepare(text).indexOf(query)
  // Normalising can change a text's length; then it is shown plain rather than mismarked.
  if (at < 0 || prepare(text).length !== text.length) return void (parent.textContent = text)
  parent.append(text.slice(0, at))
  const mark = document.createElement('mark')
  mark.textContent = text.slice(at, at + query.length)
  parent.append(mark, text.slice(at + query.length))
}

// ── Columns ───────────────────────────────────────────────────────────────

interface Slot { row: HTMLElement; title: HTMLElement; aside: HTMLElement; pin: HTMLButtonElement; edit: HTMLButtonElement; thumb?: HTMLImageElement; key: string }

/**
 * One virtualised list: only the rows in view exist, and they are reused as it scrolls, so a
 * thousand entries cost the same as ten and a redraw touches only rows whose content changed.
 */
class Column {
  all: Item[] = []
  view: Item[] = []
  sel = 0
  private last = ''
  /** `all` changed since `view` was computed: a narrower query cannot reuse `view`. */
  private stale = true
  private readonly slots: Slot[] = []
  readonly list: HTMLElement
  private readonly spacer: HTMLElement
  private readonly empty: HTMLElement
  private readonly head: HTMLElement

  constructor(readonly side: Side, readonly height: number) {
    this.list = el(`list-${side}`)
    this.spacer = this.list.querySelector('.spacer')!
    this.empty = this.list.querySelector('.empty')!
    this.head = el(`h-${side}`)
  }

  setAll(all: Item[]): void {
    this.all = all
    this.stale = true
  }

  /**
   * Shows the entries matching `query`. A new query selects the first match; new data under the
   * same query keeps the selected entry selected.
   */
  apply(query: string): void {
    const id = this.view[this.sel]?.id
    // A longer query only narrows the last answer: look there, not at everything.
    const narrowing = !this.stale && query !== '' && this.last !== '' && query.startsWith(this.last)
    this.view = query === '' ? this.all : (narrowing ? this.view : this.all).filter((item) => item.n.includes(query))
    this.stale = false
    if (query !== this.last) {
      this.last = query
      this.sel = 0
      this.list.scrollTop = 0
      return
    }
    const at = id === undefined ? -1 : this.view.findIndex((item) => item.id === id)
    this.sel = at >= 0 ? at : Math.min(this.sel, Math.max(0, this.view.length - 1))
  }

  selected(): Item | undefined {
    return this.view[this.sel]
  }

  move(delta: number): void {
    if (this.view.length === 0) return
    this.sel = Math.min(this.view.length - 1, Math.max(0, this.sel + delta))
    this.reveal()
  }

  reveal(): void {
    const top = this.sel * this.height
    if (top < this.list.scrollTop) this.list.scrollTop = top
    else if (top + this.height > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = top + this.height - this.list.clientHeight
  }

  draw(query: string, active: boolean, fresh: Map<number, number>, now: number): void {
    const { height, view } = this
    this.spacer.style.height = `${view.length * height}px`
    const first = Math.max(0, Math.floor(this.list.scrollTop / height) - 2)
    const last = Math.min(view.length, Math.ceil((this.list.scrollTop + this.list.clientHeight) / height) + 2)
    for (let i = first, s = 0; i < last; i++, s++) {
      const item = view[i]!
      const slot = this.slots[s] ?? this.slot()
      const chosen = i === this.sel
      const isFresh = (fresh.get(item.id) ?? 0) > now
      const aside = this.side === 'pin'
        ? (item.pin && this.rank(item) < 9 ? String(this.rank(item) + 1) : '')
        : item.img
          ? [item.app, ago(item.at), left(item.at)].filter(Boolean).join(' · ')
          : [item.app, ago(item.at), item.text.length > 160 ? t('chars', { n: item.cut ? '8000+' : item.text.length }) : ''].filter(Boolean).join(' · ')
      const key = `${item.id}|${i}|${chosen}|${active}|${isFresh}|${item.pin}|${query}|${aside}`
      if (slot.key === key) continue
      slot.key = key
      slot.row.hidden = false
      slot.row.id = `r${item.id}`
      slot.row.dataset.index = String(i)
      slot.row.style.transform = `translateY(${i * height}px)`
      slot.row.ariaSelected = String(chosen)
      slot.row.classList.toggle('active', chosen && active)
      slot.row.classList.toggle('fresh', isFresh)
      if (item.img) slot.title.textContent = titleOf(item)
      else highlight(slot.title, flat(item.text), query)
      slot.aside.textContent = aside
      slot.row.classList.toggle('image', item.img !== undefined)
      if (slot.thumb) {
        slot.thumb.hidden = !item.img
        const src = item.img ? imageUrl(item.id) : ''
        if (src !== '' && slot.thumb.getAttribute('src') !== src) slot.thumb.src = src
      }
      // An image is never pinned: no button that would do nothing.
      slot.pin.hidden = item.img !== undefined
      slot.edit.hidden = item.img !== undefined
      slot.pin.ariaPressed = String(item.pin > 0)
      slot.pin.ariaLabel = t(item.pin ? 'unpin' : 'pin')
      slot.pin.title = slot.pin.ariaLabel
    }
    for (let s = last - first; s < this.slots.length; s++) {
      const slot = this.slots[s]!
      if (!slot.row.hidden) {
        slot.row.hidden = true
        slot.key = ''
      }
    }
    const searching = query !== ''
    this.empty.hidden = view.length > 0
    if (view.length === 0) {
      this.empty.textContent = this.side === 'pin'
        ? t(searching ? 'emptyPinsFound' : 'emptyPins', { mod: MOD })
        : t(searching ? 'emptyFound' : 'emptyAll')
    }
    this.head.querySelector('span')!.textContent = t(this.side === 'pin' ? 'pinned' : 'recent')
    this.head.querySelector('small')!.textContent = searching ? `${view.length} / ${this.all.length}` : String(this.all.length)
    this.head.classList.toggle('active', active)
  }

  /** The entry's place among all pinned ones: its Ctrl/⌘ number, whatever the search shows. */
  private rank(item: Item): number {
    return this.all.indexOf(item)
  }

  private slot(): Slot {
    const row = document.createElement('div')
    row.className = 'row'
    row.role = 'option'
    const title = document.createElement('b')
    const aside = document.createElement(this.side === 'pin' ? 'kbd' : 'small')
    const pin = document.createElement('button')
    pin.type = 'button'
    pin.className = 'icon act'
    pin.dataset.do = 'pin'
    pin.tabIndex = -1
    pin.innerHTML = ICON.pin
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'icon act'
    edit.dataset.do = 'edit'
    edit.tabIndex = -1
    edit.ariaLabel = t('edit')
    edit.title = `${t('edit')} · ${MOD} E`
    edit.innerHTML = ICON.edit
    if (this.side === 'pin') {
      row.append(aside, title, edit, pin)
    } else {
      const thumb = document.createElement('img')
      thumb.className = 'thumb'
      thumb.alt = ''
      thumb.draggable = false
      thumb.loading = 'lazy'
      thumb.decoding = 'async'
      thumb.hidden = true
      row.append(thumb)
      const cell = document.createElement('div')
      cell.className = 'cell'
      cell.append(title, aside)
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'icon act'
      del.dataset.do = 'del'
      del.tabIndex = -1
      del.ariaLabel = t('delete')
      del.title = del.ariaLabel
      del.innerHTML = ICON.del
      row.append(cell, edit, pin, del)
    }
    this.spacer.append(row)
    const slot: Slot = { row, title, aside, pin, edit, thumb: row.querySelector<HTMLImageElement>('.thumb') ?? undefined, key: '' }
    this.slots.push(slot)
    return slot
  }
}

const cols: Record<Side, Column> = { pin: new Column('pin', 36), rec: new Column('rec', 44) }
const items = new Map<number, Item>()
const fresh = new Map<number, number>()
let side: Side = 'rec'
let mode: Mode = 'clip'
let lang: Lang = 'en'
/** The Alt/⌥ digits: the first goes to the next language, the others pick the languages in their order; set in the settings. */
let keys = [3, 4, 5, 6]
let bot = ''
let bots: Bot[] = []
let target = ''
let rid = 0
let translated: { rid: number; key: string; text: string; state: 'busy' | 'ready' | 'error'; error?: string } | undefined
/** The kept translations, newest first, and those the search shows. */
let history: Translation[] = []
let historyView: Translation[] = []
/** The kept translation shown in the translator, if one is; and what was there before it. */
let shownId: number | undefined
let beforeHistory: string | undefined
let historyDelete: { item: Translation; timer: number } | undefined
/** Each tab keeps its own search. */
const searches: Record<Mode, string> = { clip: '', tr: '' }
let autoType = false
let pendingDelete: { item: Item; timer: number } | undefined
let toastTimer = 0
let raf = 0
let freshTimer = 0
/** The person moved the selection since the window opened: a new copy then leaves it alone. */
let touched = false

const query = (): string => prepare(q.value.trim())
const current = (): Item | undefined => cols[side].selected()

/** Splits the entries into the two columns and re-applies the search. */
function arrange(): void {
  const pins: Item[] = []
  const rest: Item[] = []
  for (const item of items.values()) {
    if (pendingDelete?.item.id === item.id) continue
    ;(item.pin ? pins : rest).push(item)
  }
  cols.pin.setAll(pins.sort(byPinTime))
  cols.rec.setAll(rest.sort(byRecency))
  filter()
}

/** The query `filter` last applied: a different one picks the column again. */
let searched = ''

/**
 * Applies the search to both columns; an empty column hands the selection to the other. A new
 * search starts on the pinned entries when any match, and clearing it goes back to the newest copy.
 */
function filter(): void {
  const text = query()
  cols.pin.apply(text)
  cols.rec.apply(text)
  if (text !== searched) {
    searched = text
    side = text !== '' && cols.pin.view.length > 0 ? 'pin' : 'rec'
  }
  if (cols[side].view.length === 0) {
    const other: Side = side === 'pin' ? 'rec' : 'pin'
    if (cols[other].view.length > 0) side = other
  }
  render()
}

function render(): void {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(draw)
}

function draw(): void {
  const text = query()
  const now = Date.now()
  cols.pin.draw(text, side === 'pin', fresh, now)
  cols.rec.draw(text, side === 'rec', fresh, now)
  const item = current()
  q.setAttribute('aria-activedescendant', item ? `r${item.id}` : '')
  q.setAttribute('aria-controls', `list-${side}`)
  if (editing) return showHints('edit')
  pvMeta.textContent = !item
    ? ''
    : item.img
      ? [titleOf(item), bytes(item.size ?? 0), item.app, ago(item.at), left(item.at)].filter(Boolean).join(' · ')
      : [item.pin ? t('pinned') : '', item.app, ago(item.at), t('chars', { n: item.cut ? '8000+' : item.text.length })].filter(Boolean).join(' · ')
  pvText.hidden = item?.img !== undefined
  pvImg.hidden = item?.img === undefined
  el('ed-start').hidden = !item || item.img !== undefined
  if (item?.img) {
    const src = imageUrl(item.id)
    if (pvImg.getAttribute('src') !== src) pvImg.src = src
  } else {
    const shown = item ? item.text.slice(0, 4000) + (item.text.length > 4000 || item.cut ? '…' : '') : ''
    if (pvText.value !== shown) {
      pvText.value = shown
      pvText.scrollTop = 0
    }
  }
  showHints(editing ? 'edit' : item?.img ? 'image' : 'text')
  // The large view follows the selection while it is open, and closes on a text.
  if (!look.hidden) setLook(item?.img !== undefined)
}

/** The selected image at the size of the lists (Space, as Quick Look does), or back to the lists. */
function setLook(on: boolean): void {
  const item = current()
  look.hidden = !(on && item?.img)
  if (!look.hidden && item) {
    const src = imageUrl(item.id)
    if (lookImg.getAttribute('src') !== src) lookImg.src = src
    lookImg.alt = titleOf(item)
  }
}

function switchSide(next: Side): void {
  if (next === side || cols[next].view.length === 0) return
  touched = true
  side = next
  cols[side].reveal()
  draw()
}

// ── Updates from the helper ───────────────────────────────────────────────

function fromWire(row: Wire): Item {
  const known = items.get(row.id)
  // An image is found by searching for the word "image" (in the window's language) or its size.
  if (row.img) return { ...row, n: prepare(`${t('image')} image ${row.img[0]}×${row.img[1]} ${row.img[0]}x${row.img[1]}`) }
  return { ...row, n: known && known.text === row.text ? known.n : prepare(row.text) }
}

/** Applies what changed; rows that are new or copied again are marked for a moment. */
function applySync(sync: Sync | null | undefined, mark: boolean): void {
  if (!sync) return
  if (sync.items) {
    const next = sync.items.map(fromWire)
    items.clear()
    for (const item of next) items.set(item.id, item)
  } else {
    const until = Date.now() + FRESH_MS
    let added: Item | undefined
    for (const row of sync.rows ?? []) {
      const known = items.get(row.id)
      const item = fromWire(row)
      items.set(row.id, item)
      if (mark && !item.pin && (!known || known.at < item.at)) {
        fresh.set(item.id, until)
        if (!added || item.at > added.at) added = item
      }
    }
    for (const id of sync.gone ?? []) items.delete(id)
    if (added) {
      el('live').textContent = t('added', { text: titleOf(added).slice(0, 60) })
      clearTimeout(freshTimer)
      freshTimer = window.setTimeout(() => {
        fresh.clear()
        render()
      }, FRESH_MS)
      // Opened a moment before the copy landed (a phone or remote sync is slow): it is the one wanted.
      if (!touched) {
        cols.rec.sel = 0
        cols.rec.list.scrollTop = 0
        side = 'rec'
        arrange()
        cols.rec.sel = 0
        return draw()
      }
    }
  }
  arrange()
}

// ── Actions on the selected entry ────────────────────────────────────────

function togglePin(): void {
  const item = current()
  if (!item) return
  if (item.img) return say(t('noPinImage', { n: IMAGE_TTL_MS / 3_600_000 }))
  const on = !item.pin
  // Placed at once; the helper answers with the exact pin time.
  item.pin = on ? Date.now() : 0
  send({ t: 'pin', id: item.id, on })
  // The selection stays in its column, on the next entry: pinning several in a row is quick.
  const index = cols[side].sel
  arrange()
  cols[side].sel = Math.min(index, Math.max(0, cols[side].view.length - 1))
  draw()
}

function flushDelete(): void {
  if (!pendingDelete) return
  clearTimeout(pendingDelete.timer)
  send({ t: 'del', id: pendingDelete.item.id })
  items.delete(pendingDelete.item.id)
  pendingDelete = undefined
}

/** Deleting asks nothing: it can be undone for a few seconds instead. */
function remove(): void {
  const item = current()
  if (!item) return
  flushDelete()
  const index = cols[side].sel
  pendingDelete = { item, timer: window.setTimeout(flushDelete, 6000) }
  arrange()
  cols[side].sel = Math.min(index, Math.max(0, cols[side].view.length - 1))
  draw()
  say(t('deleted'), 'ok', t('undo'), () => {
    if (!pendingDelete) return
    clearTimeout(pendingDelete.timer)
    pendingDelete = undefined
    arrange()
    hideToast()
  })
}

// ── Editing an entry ──────────────────────────────────────────────────────

/** The entry being edited and the text it had; a cut entry is read whole before it can be changed. */
let editing: { id: number; original: string } | undefined
/** What was typed when the window closed mid-edit, offered again at the next opening. */
let draft: { id: number; text: string } | undefined

/**
 * Turns the preview into the editor, grown over the lists, on the selected entry or on a draft
 * of it. `caret`: the preview was clicked, and the caret stays where the click put it.
 */
function startEdit(text?: string, caret = false): void {
  const item = current()
  if (!item || editing) return
  if (item.img) return say(t('noEditImage'))
  setLook(false)
  hideToast()
  editing = { id: item.id, original: item.text }
  const loading = item.cut && text === undefined
  const at = pvText.selectionStart
  // The preview was cut at 4000 characters: the editor has the whole stored text.
  pvText.value = loading ? t('loading') : (text ?? item.text)
  pvText.readOnly = loading
  if (loading) send({ t: 'full', id: item.id })
  preview.dataset.edit = ''
  q.disabled = true
  el('ed-start').hidden = true
  el('ed-acts').hidden = false
  el<HTMLButtonElement>('ed-save').disabled = text === undefined
  pvMeta.textContent = t('editing', { meta: [item.pin ? t('pinned') : '', item.app, ago(item.at)].filter(Boolean).join(' · ') || t('edit') })
  if (document.activeElement !== pvText) pvText.focus()
  const end = caret && !loading && text === undefined ? Math.min(at, pvText.value.length) : pvText.value.length
  pvText.setSelectionRange(end, end)
  if (!caret) pvText.scrollTop = pvText.scrollHeight
  draw()
}

function closeEdit(): void {
  editing = undefined
  delete preview.dataset.edit
  pvText.readOnly = true
  q.disabled = false
  el('ed-acts').hidden = true
  footerFor = undefined
  // Back to showing the entry as it is now.
  pvText.value = ''
  q.focus()
  draw()
}

const changed = (): boolean => editing !== undefined && !pvText.readOnly && pvText.value !== editing.original

/** Leaves without saving; what was typed can be had back for a while. */
function cancelEdit(): void {
  const kept = changed() && editing ? { id: editing.id, text: edText.value } : undefined
  closeEdit()
  if (kept) say(t('editDiscarded'), 'ok', t('undo'), () => resume(kept))
}

function resume(kept: { id: number; text: string }): void {
  const at = cols[side].view.findIndex((item) => item.id === kept.id)
  if (at < 0 && !select(kept.id)) return
  if (at >= 0) cols[side].sel = at
  startEdit(kept.text)
}

/** Puts the selection on an entry, in whichever column holds it. */
function select(id: number): boolean {
  for (const name of ['pin', 'rec'] as const) {
    const at = cols[name].view.findIndex((item) => item.id === id)
    if (at < 0) continue
    side = name
    cols[name].sel = at
    cols[name].reveal()
    return true
  }
  return false
}

/** Saves at once on the page; the helper answers with the row that holds the text now. */
function saveEdit(): void {
  if (!editing || pvText.readOnly) return
  const text = pvText.value
  if (text === editing.original) return closeEdit()
  if (text.trim() === '') return say(t('editEmpty'), 'bad')
  if (new TextEncoder().encode(text).length > 64 * 1024) return say(t('editLong'), 'bad')
  const item = items.get(editing.id)
  if (item) {
    saved.set(item.id, { before: item.text, cut: item.cut, text })
    item.text = text
    item.cut = false
    item.n = prepare(text)
  }
  send({ t: 'edit', id: editing.id, text })
  closeEdit()
  arrange()
}

/** Edits sent and not yet answered: what to put back if the helper refuses. */
const saved = new Map<number, { before: string; cut: boolean; text: string }>()

function onEdited(message: { id: number; row?: number; error?: string }): void {
  const sent = saved.get(message.id)
  saved.delete(message.id)
  if (message.error) {
    const item = items.get(message.id)
    if (item && sent) {
      item.text = sent.before
      item.cut = sent.cut
      item.n = prepare(sent.before)
      arrange()
    }
    const kept = sent && { id: message.id, text: sent.text }
    return say(t('editFailed', { error: message.error }), 'bad', kept ? t('editResume') : undefined, () => kept && resume(kept))
  }
  // The same text was stored already: that entry is the one now, and stays selected.
  if (message.row !== undefined && message.row !== message.id && select(message.row)) draw()
}

el('ed-save').addEventListener('click', saveEdit)
el('ed-cancel').addEventListener('click', cancelEdit)
el('ed-start').addEventListener('click', () => startEdit())
// A click in the preview's text starts editing right there.
pvText.addEventListener('focus', () => startEdit(undefined, true))
pvText.addEventListener('input', () => {
  // Nothing to save until something changed.
  if (editing) el<HTMLButtonElement>('ed-save').disabled = !changed()
})

const typeItem = (item: Item | undefined): void => void (item && send({ t: 'type', id: item.id }))
const copyItem = (item: Item | undefined): void => void (item && send({ t: 'use', id: item.id }))

const pane = el('clip')
pane.addEventListener('mousedown', (event) => {
  // Clicking a row keeps the typing caret in the search box.
  if ((event.target as HTMLElement).closest('.row')) event.preventDefault()
})
pane.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const row = target.closest<HTMLElement>('.row')
  const column = target.closest<HTMLElement>('.col')
  if (!row || !column) return
  side = column.dataset.side as Side
  cols[side].sel = Number(row.dataset.index)
  touched = true
  const action = target.closest<HTMLElement>('[data-do]')?.dataset.do
  if (action === 'pin') return togglePin()
  if (action === 'edit') return startEdit()
  if (action === 'del') return remove()
  draw()
})
pvImg.addEventListener('click', () => setLook(true))
look.addEventListener('click', () => setLook(false))
pane.addEventListener('dblclick', (event) => {
  const target = event.target as HTMLElement
  if (!target.closest('[data-do]') && target.closest('.row')) typeItem(current())
})
for (const col of Object.values(cols)) col.list.addEventListener('scroll', render, { passive: true })

// ── Messages ──────────────────────────────────────────────────────────────

function say(message: string, tone: 'ok' | 'bad' = 'ok', action?: string, onAction?: () => void): void {
  clearTimeout(toastTimer)
  const text = document.createElement('span')
  text.textContent = message
  toast.replaceChildren(text)
  if (action && onAction) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = action
    button.addEventListener('click', onAction)
    toast.append(button)
  }
  toast.dataset.tone = tone
  toast.dataset.on = ''
  // A message with an action stays long enough to read it and reach the button.
  toastTimer = window.setTimeout(hideToast, action ? 15000 : tone === 'bad' ? 6000 : 4000)
}

function hideToast(): void {
  clearTimeout(toastTimer)
  delete toast.dataset.on
}

window.__r = (message) => {
  switch (message.t) {
    case 'open': return open(message)
    case 'close': {
      // The window lost the focus mid-edit: the text is kept for the next opening.
      if (changed() && editing) draft = { id: editing.id, text: pvText.value }
      if (editing) closeEdit()
      flushHistoryDelete()
      return flushDelete()
    }
    case 'edited': return onEdited(message as unknown as { id: number; row?: number; error?: string })
    case 'sync': return applySync(message.sync as Sync | null, true)
    case 'full': {
      if (editing && editing.id === message.id && pvText.readOnly) {
        pvText.readOnly = false
        if (typeof message.text === 'string') editing.original = message.text
        pvText.value = editing.original
        pvText.setSelectionRange(0, 0)
        return
      }
      if (typeof message.text === 'string' && mode === 'tr') {
        src.value = message.text
        updateGo()
      }
      return
    }
    case 'lang': return void (editing || langKey(keys.indexOf(Number(message.n))))
    case 'theme': return setTheme(message.theme)
    case 'tr': return onTranslation(message as unknown as { rid: number; text: string; done: boolean; error?: string })
    case 'history': return onHistory(message.row as Omit<Translation, 'n'>)
    case 'toast': return say(String(message.message), message.tone === 'bad' ? 'bad' : 'ok')
  }
}

/** DSH's light or dark theme; anything else follows the system's. */
function setTheme(theme: unknown): void {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
}

function open(message: Record<string, unknown>): void {
  setTheme(message.theme)
  const prefs = (message.prefs ?? {}) as Record<string, string>
  bots = ((message.bots as Bot[] | undefined) ?? [])
  bot = prefs.bot !== undefined && prefs.bot !== '' ? prefs.bot : String(message.bot ?? '')
  if (bot !== '' && !bots.some((entry) => entry.id === bot)) bot = ''
  lang = LANGS.includes(prefs.to as Lang) ? (prefs.to as Lang) : 'en'
  target = String(message.app ?? '')
  if (Array.isArray(message.keys) && message.keys.length > 0) keys = message.keys as number[]
  q.value = ''
  look.hidden = true
  hideToast()
  const notice = message.notice as { message: string; tone: 'ok' | 'bad'; perm?: boolean } | null | undefined
  if (notice) say(notice.message, notice.tone, notice.perm ? t('openPerm') : undefined, () => send({ t: 'openPerm' }))
  else if (draft) {
    const kept = draft
    say(t('editKept'), 'ok', t('editResume'), () => {
      draft = undefined
      resume(kept)
    })
  }
  applySync(message.sync as Sync | null, true)
  if (Array.isArray(message.history)) history = (message.history as Array<Omit<Translation, 'n'>>).map(fromHistory)
  if (!history.some((item) => item.id === shownId)) shownId = undefined
  searches.tr = ''
  // The newest copy is the likeliest choice.
  side = 'rec'
  touched = false
  filter()
  for (const col of Object.values(cols)) {
    col.sel = 0
    col.list.scrollTop = 0
  }
  const app = el('app')
  app.classList.remove('in')
  void app.offsetWidth
  app.classList.add('in')
  buildTranslateControls()
  setMode('clip')
  draw()
}

// ── Translation ───────────────────────────────────────────────────────────

const keyOf = (text: string): string => `${lang}\n${bot}\n${text}`

function buildTranslateControls(): void {
  const langs = el('langs')
  langs.ariaLabel = t('hintLang')
  langs.title = `${t('hintLangNext')} · ${ALT} ${keys[0]}`
  langs.replaceChildren(...LANGS.map((value, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.role = 'radio'
    button.ariaChecked = String(value === lang)
    button.ariaKeyShortcuts = `Alt+${keys[index + 1]}`
    button.title = `${t(`name_${value}`)} · ${ALT} ${keys[index + 1]}`
    button.textContent = t(`lang_${value}`)
    button.addEventListener('click', () => pickLang(index))
    return button
  }))
  botSelect.replaceChildren(...[{ id: '', name: t('defaultBot') }, ...bots].map((entry) => {
    const option = document.createElement('option')
    option.value = entry.id
    option.textContent = entry.name
    option.selected = entry.id === bot
    return option
  }))
  botSelect.ariaLabel = t('bot')
  copy.textContent = t('copy')
  updateGo()
}

botSelect.addEventListener('change', () => {
  bot = botSelect.value
  send({ t: 'pref', k: 'bot', v: bot })
  updateGo()
})

function updateGo(): void {
  const text = src.value.trim()
  const ready = translated?.state === 'ready' && translated.key === keyOf(text)
  go.textContent = translated?.state === 'busy' ? t('translating') : ready ? t('typeInto', { app: target || '…' }) : t('translate')
  go.disabled = text === '' || (ready && target === '') || translated?.state === 'busy'
  copy.disabled = !ready
  if (!translated) {
    out.dataset.state = ''
    out.textContent = t('trHint')
  }
}

/**
 * Alt/⌥ with a digit, or a click: picks a language. A translation already shown or under way
 * follows it at once (asking again for one seen before costs nothing); otherwise Enter starts it.
 * From the clipboard it translates the selected entry.
 */
function pickLang(index: number): void {
  const next = LANGS[index]
  if (!next) return
  let follow = translated !== undefined
  if (mode === 'clip') {
    const item = current()
    if (item?.img) return say(t('noTranslateImage'))
    if (item) {
      src.value = item.text
      // A cut entry is longer than a translation takes: shown whole, but not sent.
      if (item.cut) send({ t: 'full', id: item.id })
      follow = !item.cut
    }
    setMode('tr')
  }
  if (next !== lang) {
    lang = next
    send({ t: 'pref', k: 'to', v: next })
  }
  buildTranslateControls()
  if (follow && translated?.key !== keyOf(src.value.trim())) translate()
  else dropStale()
}

/** One of the Alt/⌥ digits, by its place: the first goes on to the next language, from the clipboard too. */
function langKey(at: number): void {
  if (at === 0) pickLang((LANGS.indexOf(lang) + 1) % LANGS.length)
  else if (at > 0) pickLang(at - 1)
}

function translate(andType = false): void {
  const text = src.value.trim()
  if (text === '') return
  if (translated?.state === 'busy') send({ t: 'trCancel', rid: translated.rid })
  autoType = andType
  rid += 1
  translated = { rid, key: keyOf(text), text: '', state: 'busy' }
  out.dataset.state = 'busy'
  out.textContent = t('translating')
  send({ t: 'tr', rid, text, to: lang, bot })
  updateGo()
}

function onTranslation(message: { rid: number; text: string; done: boolean; error?: string }): void {
  // An answer to a request that was replaced or abandoned is of no interest.
  if (!translated || message.rid !== translated.rid) return
  if (message.error) {
    translated = { ...translated, state: 'error', error: message.error }
    out.dataset.state = 'error'
    out.textContent = `${t('failed')}: ${message.error}`
    autoType = false
  } else {
    translated.text = message.text
    out.textContent = message.text
    out.dataset.state = message.done ? 'ready' : 'busy'
    if (message.done) {
      translated.state = 'ready'
      if (autoType) {
        autoType = false
        send({ t: 'typeText', text: message.text })
      }
    }
  }
  updateGo()
}

// ── Translation history ───────────────────────────────────────────────────

const historyList = el('list-hist')

function fromHistory(row: Omit<Translation, 'n'>): Translation {
  return { ...row, n: prepare(`${row.src}\n${row.out}`) }
}

/** A translation that just finished: at the top, and the one shown when it is the current text. */
function onHistory(row: Omit<Translation, 'n'>): void {
  const item = fromHistory(row)
  history = [item, ...history.filter((entry) => entry.id !== item.id)]
  if (translated?.state === 'ready' && translated.key === `${item.lang}\n${item.bot}\n${item.src}`) shownId = item.id
  drawHistory()
}

function drawHistory(): void {
  const text = mode === 'tr' ? query() : ''
  historyView = text === '' ? history : history.filter((item) => item.n.includes(text))
  const rows = historyView.map((item) => {
    const row = document.createElement('div')
    row.className = 'row'
    row.role = 'option'
    row.id = `h${item.id}`
    row.dataset.id = String(item.id)
    row.ariaSelected = String(item.id === shownId)
    row.classList.toggle('active', item.id === shownId)
    const cell = document.createElement('div')
    cell.className = 'cell'
    const title = document.createElement('b')
    highlight(title, flat(item.src), text)
    const aside = document.createElement('small')
    const name = LANGS.includes(item.lang as Lang) ? t(`lang_${item.lang as Lang}`) : item.lang
    aside.textContent = [`→ ${name}`, ago(item.at), flat(item.out)].join(' · ')
    cell.append(title, aside)
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'icon act'
    del.dataset.do = 'del'
    del.tabIndex = -1
    del.ariaLabel = t('delete')
    del.title = del.ariaLabel
    del.innerHTML = ICON.del
    row.append(cell, del)
    return row
  })
  const empty = historyList.querySelector<HTMLElement>('.empty')!
  empty.hidden = historyView.length > 0
  empty.textContent = t(text === '' ? 'emptyHistory' : 'emptyHistoryFound')
  historyList.replaceChildren(empty, ...rows)
  const head = el('h-hist')
  head.querySelector('span')!.textContent = t('history')
  head.querySelector('small')!.textContent = text === '' ? String(history.length) : `${historyView.length} / ${history.length}`
  if (mode === 'tr') q.setAttribute('aria-activedescendant', shownId === undefined ? '' : `h${shownId}`)
  el(`h${shownId}`)?.scrollIntoView({ block: 'nearest' })
}

/**
 * Shows a kept translation in the translator, ready to type in, without asking again. None goes
 * back to what was being written before the history was looked through.
 */
function showHistory(item: Translation | undefined): void {
  if (translated?.state === 'busy') send({ t: 'trCancel', rid: translated.rid })
  if (!item) {
    src.value = beforeHistory ?? ''
    beforeHistory = undefined
    shownId = undefined
    translated = undefined
  } else {
    if (shownId === undefined) beforeHistory = src.value
    shownId = item.id
    src.value = item.src
    if (LANGS.includes(item.lang as Lang)) lang = item.lang as Lang
    if (item.bot === '' || bots.some((entry) => entry.id === item.bot)) bot = item.bot
    // No request has this number: a late answer to another one leaves it alone.
    translated = { rid: -1, key: keyOf(item.src), text: item.out, state: 'ready' }
    out.dataset.state = 'ready'
    out.textContent = item.out
  }
  buildTranslateControls()
  drawHistory()
}

/** ↑/↓ through the history; above the newest is what was being written. */
function moveHistory(delta: number): void {
  const at = historyView.findIndex((item) => item.id === shownId)
  const next = at < 0 ? (delta > 0 ? 0 : -1) : at + delta
  if (next < 0) return void (at >= 0 && showHistory(undefined))
  const item = historyView[Math.min(next, historyView.length - 1)]
  if (item && item.id !== shownId) showHistory(item)
}

function flushHistoryDelete(): void {
  if (!historyDelete) return
  clearTimeout(historyDelete.timer)
  send({ t: 'trDel', id: historyDelete.item.id })
  historyDelete = undefined
}

/** As in the clipboard: gone at once, and back with Undo for a few seconds. */
function removeHistory(item: Translation | undefined): void {
  if (!item) return
  flushHistoryDelete()
  history = history.filter((entry) => entry !== item)
  if (shownId === item.id) shownId = undefined
  historyDelete = { item, timer: window.setTimeout(flushHistoryDelete, 6000) }
  drawHistory()
  say(t('deleted'), 'ok', t('undo'), () => {
    if (!historyDelete) return
    clearTimeout(historyDelete.timer)
    history = [...history, historyDelete.item].sort((a, b) => b.at - a.at)
    historyDelete = undefined
    drawHistory()
    hideToast()
  })
}

historyList.addEventListener('mousedown', (event) => {
  // Clicking a row leaves the caret where it was.
  if ((event.target as HTMLElement).closest('.row')) event.preventDefault()
})
historyList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const row = target.closest<HTMLElement>('.row')
  const item = row && history.find((entry) => entry.id === Number(row.dataset.id))
  if (!item) return
  if (target.closest('[data-do="del"]')) return removeHistory(item)
  showHistory(item)
})
historyList.addEventListener('dblclick', (event) => {
  if (!(event.target as HTMLElement).closest('[data-do]') && (event.target as HTMLElement).closest('.row')) primary()
})

go.addEventListener('click', () => primary())
copy.addEventListener('click', () => translated?.state === 'ready' && send({ t: 'copyText', text: translated.text }))
/** Editing the original, or replacing it, makes the old translation stale. */
function dropStale(): void {
  if (translated && translated.state !== 'busy' && translated.key !== keyOf(src.value.trim())) {
    translated = undefined
    out.textContent = t('trHint')
    out.dataset.state = ''
  }
  // Changed by hand: no longer the kept translation, and nothing to go back to.
  if (shownId !== undefined && translated?.rid !== -1) {
    shownId = undefined
    beforeHistory = undefined
    drawHistory()
  }
  updateGo()
}

src.addEventListener('input', dropStale)

/** Enter in the translation: first translate, then (the result being current) type it in. */
function primary(): void {
  const text = src.value.trim()
  if (translated?.state === 'ready' && translated.key === keyOf(text)) {
    if (target !== '') send({ t: 'typeText', text: translated.text })
  } else if (translated?.state !== 'busy') translate()
}

// ── Modes and keys ────────────────────────────────────────────────────────

const hints = (pairs: Array<[string, string]>): string =>
  pairs.map(([key, label]) => `<span><kbd>${key}</kbd> ${label}</span>`).join('')

function setMode(next: Mode): void {
  if (editing) cancelEdit()
  const typed = q.value
  searches[mode] = typed
  mode = next
  q.value = searches[next]
  for (const name of ['clip', 'tr'] as const) {
    const on = name === next
    el(`tab-${name}`).ariaSelected = String(on)
    el(`tab-${name}`).tabIndex = on ? 0 : -1
    if (on) el(name).dataset.on = ''
    else delete el(name).dataset.on
  }
  if (next === 'tr') {
    const item = current()
    if (src.value.trim() === '') {
      if (item?.img) src.value = ''
      else if (item) {
        src.value = item.text
        if (item.cut) send({ t: 'full', id: item.id })
      } else src.value = typed
    }
    drawHistory()
    updateGo()
    src.focus()
    src.select()
  } else q.focus()
  el('where').textContent = target ? t('target', { app: target }) : t('noTarget')
  footerFor = undefined
  if (next === 'clip') showHints(current()?.img ? 'image' : 'text')
  else el('keys').innerHTML = hints([['↵', t('hintTranslate')], [`${MOD} ↵`, t('hintTranslateType')], [`${ALT} ${keys[0]}–${keys.at(-1)}`, t('hintLang')], [`${MOD} ↑↓`, t('history')], ['Tab', t('tabClip')], ['Esc', t('close')]])
  el('tab-clip').textContent = t('tabClip')
  el('tab-tr').textContent = t('tabTranslate')
  el('ed-save').textContent = t('save')
  el('ed-save').title = `${MOD} ↵`
  el('ed-cancel').textContent = t('cancel')
  el('ed-cancel').title = 'Esc'
  el('ed-start').innerHTML = `${ICON.edit}<span>${t('edit')}</span><kbd>${MOD} E</kbd>`
  el('ed-start').ariaLabel = `${t('edit')} (${MOD} E)`
  pvText.ariaLabel = t('edit')
  q.placeholder = t(next === 'clip' ? 'search' : 'searchHistory')
  q.ariaLabel = q.placeholder
  q.setAttribute('aria-controls', next === 'clip' ? `list-${side}` : 'list-hist')
  src.placeholder = t('sourcePlaceholder')
  src.ariaLabel = t('source')
}

/** The clipboard's keys, for a text or for an image (pasted, not typed; never pinned). */
let footerFor: 'text' | 'image' | 'edit' | undefined
function showHints(kind: 'text' | 'image' | 'edit'): void {
  if (mode !== 'clip' || footerFor === kind) return
  footerFor = kind
  el('keys').innerHTML = kind === 'edit'
    ? hints([[`${MOD} ↵`, t('hintSave')], ['Esc', t('cancel')]])
    : kind === 'image'
      ? hints([['↵', t('hintPaste')], ['Space', t('hintLook')], [`${MOD} C`, t('hintCopy')], [`${MOD} 1–9`, t('hintQuick')], ['← →', t('hintColumn')], ['Del', t('hintDelete')], ['Tab', t('tabTranslate')]])
      : hints([['↵', t('hintType')], [`${MOD} E`, t('hintEdit')], [`${MOD} C`, t('hintCopy')], [`${MOD} P`, t('hintPin')], [`${MOD} 1–9`, t('hintQuick')], ['← →', t('hintColumn')], ['Del', t('hintDelete')], ['Tab', t('tabTranslate')]])
}

el('tab-clip').addEventListener('click', () => setMode('clip'))
el('tab-tr').addEventListener('click', () => setMode('tr'))
q.addEventListener('input', () => (mode === 'clip' ? filter() : drawHistory()))
// The top edge, on Windows: the page lies over the window's own there (macOS resizes by itself).
const grip = el('grip')
grip.hidden = mac
grip.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  send({ t: 'resize' })
})

// The header's empty parts move the window, and a double click there puts it back in the middle.
el('app').querySelector('header')!.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, select, textarea, a')) return
  // Keeps the caret where it is.
  event.preventDefault()
  // The system's move takes the mouse from the page, which then never sees a dblclick.
  send({ t: event.detail >= 2 ? 'center' : 'drag' })
})

const hide = (): void => {
  flushDelete()
  flushHistoryDelete()
  send({ t: 'hide' })
}

/** Whether the keystroke belongs to a text selection the person made. */
const selecting = (field: HTMLInputElement | HTMLTextAreaElement): boolean => field.selectionStart !== field.selectionEnd

/** ←/→ change column unless they would move the caret inside a search being typed. */
function arrowSwitches(key: string): boolean {
  if (q.value === '') return true
  const at = q.selectionStart ?? 0
  return !selecting(q) && (key === 'ArrowLeft' ? at === 0 : at === q.value.length)
}

/**
 * What Enter asked for, done when it is let go: typing hides the window and brings the target
 * back, and a key still held then would reach it (auto-repeat, or the key-up) as a second Return.
 */
let onEnterUp: (() => void) | undefined

document.addEventListener('keyup', (event) => {
  if (event.key !== 'Enter' || !onEnterUp) return
  const action = onEnterUp
  onEnterUp = undefined
  action()
})
window.addEventListener('blur', () => void (onEnterUp = undefined))

document.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey
  if (event.isComposing) return
  // The editor is a plain text field: only leaving and saving are ours.
  if (editing) {
    if (event.key === 'Escape') { event.preventDefault(); return cancelEdit() }
    if (mod && (event.key === 'Enter' || event.key.toLowerCase() === 's')) { event.preventDefault(); return saveEdit() }
    return
  }
  if (event.key === 'Enter' && event.repeat) return void event.preventDefault()
  if (event.key === 'Escape') {
    event.preventDefault()
    if (!look.hidden) return setLook(false)
    if (q.value !== '') {
      q.value = ''
      return mode === 'clip' ? filter() : drawHistory()
    }
    return hide()
  }
  if (event.key === 'Tab' && !event.shiftKey && !event.altKey && (document.activeElement === q || document.activeElement === src || document.activeElement === document.body)) {
    event.preventDefault()
    return setMode(mode === 'clip' ? 'tr' : 'clip')
  }
  // The helper takes these keys ahead of other programs while the window is open; this is for
  // when it could not (no keyboard hook, no accessibility permission).
  const langAt = event.altKey && !mod && !event.shiftKey && /^Digit[1-9]$/.test(event.code) ? keys.indexOf(Number(event.code.slice(5))) : -1
  if (langAt >= 0) {
    event.preventDefault()
    return langKey(langAt)
  }
  if (mode === 'clip') {
    const col = cols[side]
    if (/^(Arrow(Up|Down)|Page(Up|Down))$/.test(event.key)) touched = true
    if (event.key === 'ArrowDown') { event.preventDefault(); col.move(1); return draw() }
    if (event.key === 'ArrowUp') { event.preventDefault(); col.move(-1); return draw() }
    if (event.key === 'PageDown') { event.preventDefault(); col.move(8); return draw() }
    if (event.key === 'PageUp') { event.preventDefault(); col.move(-8); return draw() }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !mod && !event.shiftKey && arrowSwitches(event.key)) {
      event.preventDefault()
      return switchSide(event.key === 'ArrowLeft' ? 'pin' : 'rec')
    }
    if (event.key === ' ' && q.value === '' && current()?.img) {
      event.preventDefault()
      return setLook(look.hidden)
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const item = current()
      return void (onEnterUp = () => typeItem(item))
    }
    if (mod && /^[1-9]$/.test(event.key)) { event.preventDefault(); return typeItem(cols.pin.all[Number(event.key) - 1]) }
    if (mod && event.key.toLowerCase() === 'c' && !selecting(q)) { event.preventDefault(); return copyItem(current()) }
    if (mod && event.key.toLowerCase() === 'p') { event.preventDefault(); return togglePin() }
    if (mod && event.key.toLowerCase() === 'e') { event.preventDefault(); return startEdit() }
    if (event.key === 'Delete' && q.value === '') { event.preventDefault(); return remove() }
    return
  }
  // The history: ↑/↓ from the search, ⌘/Ctrl ↑/↓ from anywhere; Del from an empty search.
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (mod || document.activeElement === q)) {
    event.preventDefault()
    return moveHistory(event.key === 'ArrowDown' ? 1 : -1)
  }
  if (event.key === 'Delete' && document.activeElement === q && q.value === '') {
    event.preventDefault()
    return removeHistory(history.find((item) => item.id === shownId))
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    onEnterUp = mod ? () => translate(true) : primary
    return
  }
  if (mod && event.key.toLowerCase() === 'c' && !selecting(src) && translated?.state === 'ready' && !window.getSelection()?.toString()) {
    event.preventDefault()
    send({ t: 'copyText', text: translated.text })
  }
})

document.addEventListener('contextmenu', (event) => event.preventDefault())
window.addEventListener('beforeunload', flushDelete)
window.addEventListener('resize', render)

setMode('clip')
buildTranslateControls()
arrange()
send({ t: 'ready' })
