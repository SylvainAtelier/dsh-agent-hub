/**
 * Terminal output → styled lines. Understands SGR colors (16, 256 and true
 * color), bold/dim/italic/underline/inverse, carriage returns (progress lines
 * overwrite themselves) and drops every other escape sequence. State carries
 * across chunks, so a color or an escape split between two reads still works.
 */

export interface Style {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

export interface Segment {
  text: string
  style?: Style
}

export type Line = Segment[]

/** The 16 base colors as CSS variables, so the console can theme them for light and dark. */
const BASE = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
const named = (index: number): string => `var(--gc-${index >= 8 ? 'bright-' : ''}${BASE[index % 8]})`

function color256(n: number): string {
  if (n < 16) return named(n)
  if (n >= 232) {
    const level = 8 + (n - 232) * 10
    return `rgb(${level},${level},${level})`
  }
  const c = n - 16
  const steps = [0, 95, 135, 175, 215, 255]
  return `rgb(${steps[Math.floor(c / 36)]},${steps[Math.floor(c / 6) % 6]},${steps[c % 6]})`
}

function applySgr(style: Style, params: number[]): Style {
  const next: Style = { ...style }
  if (params.length === 0) params = [0]
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!
    if (p === 0) {
      for (const key of Object.keys(next) as (keyof Style)[]) delete next[key]
    } else if (p === 1) next.bold = true
    else if (p === 2) next.dim = true
    else if (p === 3) next.italic = true
    else if (p === 4) next.underline = true
    else if (p === 7) next.inverse = true
    else if (p === 22) { delete next.bold; delete next.dim }
    else if (p === 23) delete next.italic
    else if (p === 24) delete next.underline
    else if (p === 27) delete next.inverse
    else if (p >= 30 && p <= 37) next.fg = named(p - 30)
    else if (p >= 90 && p <= 97) next.fg = named(p - 90 + 8)
    else if (p === 39) delete next.fg
    else if (p >= 40 && p <= 47) next.bg = named(p - 40)
    else if (p >= 100 && p <= 107) next.bg = named(p - 100 + 8)
    else if (p === 49) delete next.bg
    else if ((p === 38 || p === 48) && params[i + 1] === 5 && params[i + 2] !== undefined) {
      next[p === 38 ? 'fg' : 'bg'] = color256(params[i + 2]!)
      i += 2
    } else if ((p === 38 || p === 48) && params[i + 1] === 2 && params[i + 4] !== undefined) {
      next[p === 38 ? 'fg' : 'bg'] = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`
      i += 4
    }
  }
  return next
}

const empty = (style: Style): boolean => Object.keys(style).length === 0

export class AnsiBuffer {
  lines: Line[] = [[]]
  private style: Style = {}
  /** An escape sequence cut off at the end of the last chunk. */
  private pending = ''
  /** A lone CR was seen: the next text overwrites the current line. */
  private overwrite = false
  /** Bumps on every change, for cheap memoization. */
  version = 0

  private readonly maxLines: number

  constructor(maxLines = 5000) {
    this.maxLines = maxLines
  }

  write(chunk: string, base?: Style): void {
    let text = this.pending + chunk
    this.pending = ''
    let i = 0
    let run = ''
    const flush = (): void => {
      if (run === '') return
      if (this.overwrite) {
        this.lines[this.lines.length - 1] = []
        this.overwrite = false
      }
      const style = base === undefined ? this.style : { ...base, ...this.style }
      const line = this.lines[this.lines.length - 1]!
      const last = line[line.length - 1]
      if (last !== undefined && sameStyle(last.style, style)) last.text += run
      else line.push(empty(style) ? { text: run } : { text: run, style })
      run = ''
    }
    while (i < text.length) {
      const ch = text[i]!
      if (ch === '\x1b') {
        flush()
        const rest = text.slice(i)
        const csi = /^\x1b\[([0-9;?]*)([@-~])/.exec(rest)
        if (csi) {
          if (csi[2] === 'm') this.style = applySgr(this.style, csi[1]!.split(';').filter((p) => p !== '' && p !== '?').map(Number))
          else if (csi[2] === 'K' && this.overwrite) {
            this.lines[this.lines.length - 1] = []
            this.overwrite = false
          }
          i += csi[0].length
          continue
        }
        const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(rest)
        if (osc) {
          i += osc[0].length
          continue
        }
        if (/^\x1b(\[[0-9;?]*|\][^\x07\x1b]*)?$/.test(rest)) {
          // Incomplete: wait for the next chunk.
          this.pending = rest
          break
        }
        i += 2 // other two-byte escapes
        continue
      }
      if (ch === '\n') {
        flush()
        if (this.overwrite) this.overwrite = false
        this.lines.push([])
        i++
        continue
      }
      if (ch === '\r') {
        flush()
        if (text[i + 1] === '\n') {
          i++
          continue
        }
        this.overwrite = true
        i++
        continue
      }
      if (ch === '\b' || ch === '\x07') {
        i++
        continue
      }
      run += ch
      i++
    }
    flush()
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines)
    this.version++
  }

  /** Add a whole line in a fixed style (prompts, notices). */
  note(text: string, style: Style): void {
    const last = this.lines[this.lines.length - 1]!
    if (last.length > 0) this.lines.push([])
    this.lines[this.lines.length - 1]!.push({ text, style })
    this.lines.push([])
    this.style = {}
    this.version++
  }

  clear(): void {
    this.lines = [[]]
    this.style = {}
    this.pending = ''
    this.overwrite = false
    this.version++
  }
}

function sameStyle(a: Style | undefined, b: Style): boolean {
  const left = a ?? {}
  const keys = new Set([...Object.keys(left), ...Object.keys(b)]) as Set<keyof Style>
  for (const key of keys) if (left[key] !== b[key]) return false
  return true
}

/** Plain text of a line, for copy and search. */
export const lineText = (line: Line): string => line.map((segment) => segment.text).join('')
