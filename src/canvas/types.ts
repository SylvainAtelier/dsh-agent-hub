/**
 * Canvases: self-contained HTML files the models write to `~/.dsh/canvases`
 * (charts, tables, dashboards), browsed together in the 画布 panel. The panel
 * also lists the `@session` snapshots too large to hand an external agent
 * inline (claude/translate.ts), kept in `~/.dsh/dsh-agent-hub/references`.
 * Shared by the host and the browser.
 */

export const CANVAS_METHOD = 'agent-hub/canvas'

/** `canvas`: an HTML page the panel runs; `reference`: a Markdown snapshot it shows as text. */
export type CanvasKind = 'canvas' | 'reference'

export interface CanvasItem {
  kind: CanvasKind
  /** File name inside its folder, extension included. */
  name: string
  /** Absolute path, what the models link to. */
  path: string
  /** The page's `<title>` (a snapshot's heading), else its file name. */
  title: string
  size: number
  /** Last write, epoch milliseconds. */
  mtime: number
}

export interface CanvasList {
  dir: string
  items: CanvasItem[]
  /** The snapshots' folder and its files, newest first. */
  referenceDir: string
  references: CanvasItem[]
}

/** The session a canvas came from (source.ts). */
export interface CanvasSource {
  sessionId: string
  /** The session's title, when it has one. */
  title?: string
}

export type CanvasRequest =
  | { op: 'list' }
  | { op: 'source'; name: string }
  | { op: 'read'; name: string; kind?: CanvasKind }
  | { op: 'remove'; name: string; kind?: CanvasKind }
