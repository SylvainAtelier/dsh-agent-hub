/** Canvas panel stylesheet, `cv-` prefixed, on the shared tokens and controls of theme/base.ts. */

const CSS = `
.cv-page {
  display: flex; height: 100%; min-height: 0; overflow: hidden; font-size: 13px; line-height: 20px;
  color: var(--ah-fg);
}
.cv-side { flex: none; display: flex; flex-direction: column; width: 280px; min-height: 0; border-right: 1px solid var(--ah-line); }
.cv-bar { display: flex; align-items: center; gap: 8px; padding: 14px 14px 8px; }
.cv-title { flex: 1; margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.cv-list { flex: 1; min-height: 0; overflow: auto; padding: 4px 8px 12px; }
.cv-row {
  display: block; width: 100%; box-sizing: border-box; padding: 8px 10px; border: 0; border-radius: var(--ah-radius);
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.cv-row:hover { background: var(--ah-hover); }
.cv-row:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.cv-row[aria-current="true"] { background: color-mix(in srgb, currentColor 9%, transparent); }
.cv-row-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.cv-row-meta { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--ah-fg3); }
.cv-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.cv-stage { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--ah-bg); }
.cv-head { display: flex; align-items: center; gap: 4px; padding: 6px 8px 6px 6px; border-bottom: 1px solid var(--ah-line); }
.cv-head-title { flex: 1; min-width: 0; margin: 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.cv-head .ah-btn { margin-left: 4px; }
/* The way back to the session that made the canvas: labelled while there is room, an icon when narrow. */
.cv-head .cv-source { margin: 0 2px 0 4px; padding: 0 8px; }
.cv-page[data-narrow] .cv-head .cv-source { width: 28px; padding: 0; }
@media (pointer: coarse) { .cv-page[data-narrow] .cv-head .cv-source { width: 36px; height: 36px; } }
.cv-remove:hover:not(:disabled) { color: var(--ah-danger-ink); }
/* White backs a page that paints no background of its own, but only once it has loaded: until then the frame is
   invisible over the stage, so a dark theme never flashes white while the page parses. */
.cv-frame { flex: 1; min-height: 0; width: 100%; border: 0; background: #fff; opacity: 0; }
.cv-frame[data-ready] { opacity: 1; transition: opacity 120ms ease-out; }
@media (prefers-reduced-motion: reduce) { .cv-frame[data-ready] { transition: none; } }
.cv-group { margin: 12px 10px 4px; font-size: 11px; font-weight: 600; color: var(--ah-fg3); }
.cv-text {
  flex: 1; min-height: 0; margin: 0; padding: 14px 16px; overflow: auto; font: 12px/18px var(--ah-mono);
  white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ah-fg);
}
.cv-empty { margin: 0; padding: 24px 20px; color: var(--ah-fg2); }
.cv-foot { padding: 8px 14px; border-top: 1px solid var(--ah-line); font-size: 11px; color: var(--ah-fg3); overflow-wrap: anywhere; }

/* Folding: the list hides when folded (wide) or while the canvas has the panel (narrow); focus mode hides it too. */
.cv-page:not([data-list]) .cv-side, .cv-page:has(.cv-stage[data-focused]) .cv-side { display: none; }
.cv-page[data-narrow] .cv-side { width: 100%; border-right: 0; }
.cv-page[data-narrow][data-list] .cv-main { display: none; }
.cv-page[data-narrow] .cv-row { padding: 10px 12px; }

/* Focus mode: only the canvas, with one floating way back that stays out of the content's way until reached for. */
.cv-exit {
  position: absolute; z-index: 1; top: max(8px, env(safe-area-inset-top)); right: max(8px, env(safe-area-inset-right));
  display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0;
  border: 1px solid var(--ah-line-strong); border-radius: 50%; color: var(--ah-fg); cursor: pointer;
  background: color-mix(in srgb, var(--ah-popup) 78%, transparent); box-shadow: var(--ah-shadow);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); -webkit-tap-highlight-color: transparent;
  opacity: .6; transition: opacity 120ms ease, transform 120ms var(--ah-ease);
}
.cv-exit:hover, .cv-exit:focus-visible { opacity: 1; }
.cv-exit:active { transform: scale(.94); }
.cv-exit:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 2px; }
@media (pointer: coarse) { .cv-exit { width: 44px; height: 44px; opacity: .75; } }
@media (prefers-reduced-motion: reduce) { .cv-exit { transition: none; } .cv-exit:active { transform: none; } }
`

export function injectCanvasStyle(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.canvas'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}
