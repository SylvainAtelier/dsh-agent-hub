/**
 * One injected stylesheet, `uh-` prefixed, on the shared tokens and controls of
 * theme/base.ts; color is spent only where attention is due (amber under 50%
 * left, red under 20%) and on the providers' own marks.
 */
const CSS = `
.uh-section { display: flex; flex-direction: column; gap: 14px; color: inherit; }
.uh-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; }
.uh-muted { color: var(--ah-fg2); }
.uh-more > summary:focus-visible, .uh-glance:focus-visible, .uh-pop-close:focus-visible, .uh-pop-link:focus-visible,
.uh-sw-chip:focus-visible, .uh-tok-scroll:focus-visible {
  outline: 2px solid var(--ah-focus); outline-offset: 1px;
}
.uh-tok-provider > summary:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }

.uh-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); align-items: start; }
.uh-card {
  display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 14px; border-radius: 12px;
  background: color-mix(in srgb, currentColor 3%, transparent);
  border: 1px solid var(--ah-line);
}
.uh-head { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; }
.uh-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.uh-dot[data-p="claude"] { background: #d97757; }
.uh-dot[data-p="minimax"] { background: #f23f5d; }
.uh-dot[data-p="cursor"] { background: #7b8794; }
.uh-dot[data-p="qoder"] { background: #2bc48a; }
.uh-name { flex: none; font-weight: 600; }
.uh-account { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ah-fg2); }
.uh-tag {
  flex: none; padding: 0 6px; border-radius: 6px; font-size: 11px; line-height: 18px; text-transform: capitalize;
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.uh-badge { flex: none; margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ah-fg2); }
.uh-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--ah-ok); }
.uh-age { flex: none; margin-left: auto; font-size: 11px; color: var(--ah-fg3); }
.uh-badge + .uh-age { margin-left: 8px; }

.uh-meter { display: flex; flex-direction: column; gap: 6px; }
.uh-card[data-stale] .uh-meter { opacity: .55; }
.uh-meter-top, .uh-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.uh-label { font-size: 12px; color: var(--ah-fg2); }
.uh-pct { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.uh-meta { font-size: 11px; color: var(--ah-fg2); font-variant-numeric: tabular-nums; }
.uh-bar { position: relative; height: 6px; border-radius: 3px; background: color-mix(in srgb, currentColor 12%, transparent); }
.uh-fill {
  height: 100%; border-radius: inherit; background: var(--uh-level);
  transition: width 400ms var(--ah-ease);
}
/* --uh-level fills the bars; --uh-ink colours the numbers. */
[data-level="ok"] { --uh-level: color-mix(in srgb, currentColor 70%, transparent); }
[data-level="warn"] { --uh-level: var(--ah-warn); --uh-ink: var(--ah-warn-ink); }
[data-level="bad"] { --uh-level: var(--ah-danger); --uh-ink: var(--ah-danger-ink); }
[data-level="warn"] .uh-pct, [data-level="bad"] .uh-pct { color: var(--uh-ink); }
.uh-pace {
  position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px;
  background: currentColor; opacity: .4;
}

.uh-more > summary { cursor: pointer; font-size: 12px; color: var(--ah-fg2); list-style: none; user-select: none; }
.uh-more > summary::-webkit-details-marker { display: none; }
.uh-more > summary::before { content: '▸'; display: inline-block; width: 1em; transition: transform 150ms ease; }
.uh-more[open] > summary::before { transform: rotate(90deg); }
.uh-more[open] > summary { margin-bottom: 10px; }
.uh-more-body { display: flex; flex-direction: column; gap: 12px; }
.uh-foot-note { font-size: 12px; color: var(--ah-fg2); font-variant-numeric: tabular-nums; }
.uh-foot-note[data-level="warn"], .uh-foot-note[data-level="bad"] { color: var(--uh-ink); }
.uh-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--ah-fg2); }
.uh-hint[data-error] { color: var(--ah-danger-ink); }

.uh-skeleton { height: 132px; border-radius: var(--ah-radius-lg); background: color-mix(in srgb, currentColor 6%, transparent);
  animation: uh-appear 360ms ease 180ms both, uh-pulse 2.8s ease-in-out 540ms infinite; }
@keyframes uh-appear { from { opacity: 0; } }
@keyframes uh-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .6; } }

/* Sidebar glance: one cell per account. The host's foot-action row is a flex row; give the glance a line of its own. */
[class*="footerActions"]:has(> .uh-glance-wrap), [class*="footerActions"]:has(.uh-glance-wrap) { flex-wrap: wrap; }
.uh-glance-wrap { flex: 1 0 100%; min-width: 0; padding: 2px 0 4px; }
.uh-glance {
  appearance: none; box-sizing: border-box; display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: 7px 12px; width: 100%; padding: 9px 10px; border: none; border-radius: var(--ah-radius-lg); color: inherit; font: inherit;
  text-align: left; cursor: pointer; position: relative;
  background: color-mix(in srgb, currentColor 4%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 7%, transparent);
  transition: background-color 160ms ease, box-shadow 160ms ease, transform 160ms var(--ah-ease);
}
.uh-glance:hover, .uh-glance[data-open] {
  background: color-mix(in srgb, currentColor 9%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 26%, transparent), 0 8px 20px -10px rgba(0, 0, 0, .45);
  transform: translateY(-1px);
}
.uh-glance:active { transform: translateY(0) scale(.985); transition-duration: 80ms; }
.uh-glance-empty { grid-column: 1 / -1; font-size: 12px; color: var(--ah-fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.uh-cell { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.uh-cell[data-stale] { opacity: .55; }
.uh-cell-top { display: flex; align-items: center; gap: 5px; min-width: 0; font-size: 11px; line-height: 14px; }
.uh-cell-top .uh-dot { width: 6px; height: 6px; }
.uh-cell-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ah-fg2); }
.uh-cell-active { flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--ah-ok); }
.uh-cell-pct { flex: none; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.uh-cell[data-level="warn"] .uh-cell-pct, .uh-cell[data-level="bad"] .uh-cell-pct { color: var(--uh-ink); }
.uh-cell-bar {
  display: block; height: 3px; border-radius: 2px; overflow: hidden;
  background: color-mix(in srgb, currentColor 12%, transparent); transition: height 160ms ease;
}
.uh-cell-bar > span {
  display: block; height: 100%; border-radius: inherit; background: var(--uh-level, currentColor);
  transition: width 400ms var(--ah-ease), filter 160ms ease;
}
.uh-glance:hover .uh-cell-bar, .uh-glance[data-open] .uh-cell-bar { height: 4px; }
.uh-glance:hover .uh-cell-bar > span, .uh-glance[data-open] .uh-cell-bar > span { filter: brightness(1.15) saturate(1.2); }

/* Hover detail popover: anchored beside the glance card, bottom edges aligned. */
.uh-pop {
  position: fixed; z-index: var(--ah-z-float); box-sizing: border-box; overflow-y: auto;
  display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: var(--ah-radius-lg); font-size: 12px;
  border: 1px solid var(--ah-line-strong);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .22), 0 2px 6px rgba(0, 0, 0, .1);
  transform-origin: left bottom; animation: uh-pop-in 140ms var(--ah-ease);
}
@keyframes uh-pop-in { from { opacity: 0; transform: translateX(-4px) scale(.98); } }
.uh-pop-head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.uh-pop-head .uh-muted { margin-left: auto; }
.uh-pop-close {
  appearance: none; flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px;
  margin: -4px -4px -4px 0; padding: 0; border: none; border-radius: var(--ah-radius-sm); background: transparent; color: var(--ah-fg2); cursor: pointer;
}
.uh-pop-close:hover { color: var(--ah-fg); background: var(--ah-hover); }
.uh-pop-head .uh-muted { font-weight: 400; font-size: 11px; }
.uh-pop-acc { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--ah-line); }
.uh-pop .uh-head { font-size: 12px; }
.uh-pop .uh-account, .uh-pop .uh-age, .uh-pop-note { color: var(--ah-fg2); }
.uh-pop-acc[data-stale] .uh-pop-row { opacity: .55; }
.uh-pop-row {
  display: grid; grid-template-columns: 3.6em minmax(40px, 1fr) 3.2em 5.8em; align-items: center; gap: 8px;
  font-variant-numeric: tabular-nums;
}
.uh-pop-row .uh-bar { height: 4px; border-radius: 2px; }
.uh-pop-label { color: var(--ah-fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.uh-pop-pct { text-align: right; font-weight: 600; }
.uh-pop-row[data-level="warn"] .uh-pop-pct, .uh-pop-row[data-level="bad"] .uh-pop-pct { color: var(--uh-ink); }
.uh-pop-reset { text-align: right; color: var(--ah-fg2); white-space: nowrap; }
.uh-pop-note { font-variant-numeric: tabular-nums; }
.uh-pop-note [data-level="warn"], .uh-pop-note [data-level="bad"] { color: var(--uh-ink); }
.uh-pop-link {
  appearance: none; align-self: flex-end; border: none; border-radius: var(--ah-radius-sm); background: transparent; color: var(--ah-fg2);
  font: inherit; font-size: 12px; padding: 4px 8px; cursor: pointer;
}
.uh-pop-link:hover { color: var(--ah-fg); background: var(--ah-hover); }

/* Account switch: one line per provider, accounts as chips. */
.uh-sw { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--ah-line); }
.uh-sw-head { display: flex; align-items: baseline; gap: 8px; font-weight: 600; }
.uh-sw-head .uh-muted { margin-left: auto; font-weight: 400; font-size: 11px; }
.uh-sw-row { display: grid; grid-template-columns: 4.6em minmax(0, 1fr); align-items: start; column-gap: 8px; row-gap: 4px; }
.uh-sw-provider { display: inline-flex; align-items: center; gap: 6px; min-height: 22px; color: var(--ah-fg2); white-space: nowrap; }
.uh-sw-provider .uh-dot { width: 6px; height: 6px; }
.uh-sw-chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.uh-sw-chip {
  appearance: none; box-sizing: border-box; max-width: min(100%, 180px); min-height: 22px; padding: 2px 9px;
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--ah-line-strong); border-radius: 999px;
  background: transparent; color: var(--ah-fg2); font: inherit; font-size: 12px; line-height: 16px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: background-color 120ms, border-color 120ms, color 120ms, transform 120ms var(--ah-ease);
}
.uh-sw-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uh-sw-chip:hover:not(:disabled):not([aria-pressed="true"]) { color: var(--ah-fg); background: var(--ah-hover); }
.uh-sw-chip:active:not(:disabled):not([aria-pressed="true"]) { transform: scale(.96); }
.uh-sw-chip:disabled { cursor: default; opacity: .4; }
.uh-sw-chip[aria-pressed="true"] {
  cursor: default; color: var(--ah-fg); font-weight: 600; border-color: transparent;
  background: color-mix(in srgb, currentColor 11%, transparent);
}
.uh-sw-chip[aria-pressed="true"]::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--ah-ok); }
.uh-sw-chip[data-pending] { color: var(--ah-fg); border-style: dashed; animation: uh-sw-pulse 900ms ease-in-out infinite alternate; }
@keyframes uh-sw-pulse { to { opacity: .45; } }
.uh-sw-error { grid-column: 2; margin: 0; color: var(--ah-danger-ink); font-size: 11px; overflow-wrap: anywhere; }

/* Tokens. Period switch: a compact .ah-seg shared by the popover and the settings table. */
.uh-seg { flex: none; }
.uh-seg > button { padding: 1px 8px; font-size: 11px; line-height: 18px; }

/* Popover block: total, split, then provider rows that open onto their models. */
.uh-tok { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--ah-line); }
.uh-tok-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 8px; font-weight: 600; }
.uh-tok-sum { display: flex; align-items: baseline; gap: 8px; margin-top: 2px; font-variant-numeric: tabular-nums; }
.uh-tok-total { font-size: 20px; line-height: 24px; font-weight: 650; letter-spacing: -.01em; }
.uh-tok-hit { margin-left: auto; font-size: 11px; color: var(--ah-fg2); }
.uh-tok-split { font-size: 11px; color: var(--ah-fg2); font-variant-numeric: tabular-nums; }
.uh-tok-list { display: flex; flex-direction: column; gap: 1px; margin: 2px -6px 0; }
.uh-tok-row {
  display: grid; grid-template-columns: minmax(0, 1fr) 3.4em 44px 2.6em; align-items: center; gap: 8px;
  padding: 4px 6px; border-radius: var(--ah-radius-sm); font-variant-numeric: tabular-nums;
}
.uh-tok-provider > summary { list-style: none; cursor: pointer; user-select: none; transition: background-color 120ms ease; }
.uh-tok-provider > summary::-webkit-details-marker { display: none; }
.uh-tok-provider > summary:hover { background: var(--ah-hover); }
.uh-tok-name { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uh-tok-provider > summary .uh-tok-name::before {
  content: ''; flex: none; width: 0; height: 0; margin: 0 1px 0 2px; border-style: solid; border-width: 3.5px 0 3.5px 5px;
  border-color: transparent transparent transparent currentColor; opacity: .5; transition: transform 150ms ease;
}
.uh-tok-provider[open] > summary .uh-tok-name::before { transform: rotate(90deg); }
.uh-tok-provider > summary .uh-dot { width: 7px; height: 7px; }
.uh-tok-row[data-model] { padding-left: 27px; font-size: 11px; }
.uh-tok-row[data-model] .uh-tok-name { display: block; color: var(--ah-fg2); }
.uh-tok-num { text-align: right; font-weight: 600; }
.uh-tok-row[data-model] .uh-tok-num { font-weight: 500; }
.uh-tok-bar { height: 4px; border-radius: 2px; overflow: hidden; background: var(--ah-line); }
.uh-tok-bar > span { display: block; height: 100%; min-width: 2px; border-radius: inherit; background: color-mix(in srgb, currentColor 62%, transparent); transition: width 300ms var(--ah-ease); }
.uh-tok-row[data-model] .uh-tok-bar > span { background: color-mix(in srgb, currentColor 40%, transparent); }
.uh-tok-pct { text-align: right; font-size: 11px; color: var(--ah-fg3); }
/* Exact counts under each model where there is no hover to reveal them. */
.uh-tok-detail { display: none; grid-column: 1 / -1; font-size: 11px; line-height: 1.4; color: var(--ah-fg3); white-space: normal; }

/* Settings: the exact table. Scrolls sideways rather than squeezing digits on a narrow screen. */
.uh-tok-section { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.uh-tok-heading { margin: 0; font-size: 14px; font-weight: 600; }
.uh-tok-scroll {
  overflow-x: auto; border-radius: var(--ah-radius-lg); border: 1px solid var(--ah-line);
  background: color-mix(in srgb, currentColor 3%, transparent); -webkit-overflow-scrolling: touch;
}
.uh-tok-table { width: 100%; min-width: 560px; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.uh-tok-table th, .uh-tok-table td { padding: 7px 12px; text-align: right; white-space: nowrap; }
.uh-tok-table th[scope="row"], .uh-tok-table thead th:first-child { text-align: left; }
.uh-tok-table thead th { font-weight: 500; font-size: 11px; color: var(--ah-fg2); border-bottom: 1px solid var(--ah-line); }
.uh-tok-table tbody + tbody tr[data-provider] > * { border-top: 1px solid color-mix(in srgb, currentColor 8%, transparent); }
.uh-tok-table tr[data-provider] { font-weight: 600; }
.uh-tok-table th .uh-dot { display: inline-block; margin-right: 7px; vertical-align: 1px; }
.uh-tok-table tbody tr:not([data-provider]) th, .uh-tok-table tbody tr:not([data-provider]) td { color: var(--ah-fg2); }
.uh-tok-table tbody tr:not([data-provider]) th { padding-left: 26px; font-weight: 400; }
.uh-tok-table td[data-total] { font-weight: 600; }
.uh-tok-table tfoot > tr > * { font-weight: 650; border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent); }

@media (pointer: coarse) {
  .uh-more > summary { min-height: 44px; display: inline-flex; align-items: center; }
  .uh-pop-close { width: 36px; height: 36px; }
  .uh-sw-chip { min-height: 36px; padding: 0 12px; }
  .uh-sw-provider { min-height: 36px; }
  .uh-seg > button { min-height: 36px; padding: 0 12px; font-size: 12px; }
  .uh-tok-provider > summary { min-height: 44px; }
  .uh-tok-detail { display: block; }
}
@media (prefers-reduced-motion: reduce) {
  .uh-tok-bar > span, .uh-tok-provider > summary .uh-tok-name::before { transition: none; }
  .uh-fill, .uh-glance, .uh-cell-bar, .uh-cell-bar > span, .uh-more > summary::before { transition: none; }
  .uh-skeleton, .uh-pop, .uh-sw-chip[data-pending] { animation: none; }
  .uh-sw-chip { transition: none; }
  .uh-glance:hover, .uh-glance[data-open], .uh-glance:active { transform: none; }
}
`

const STYLE_ID = 'dsh-agent-hub-usage-style'

/** Inject the stylesheet once; the disposer removes it. */
export function injectStyle(): () => void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
  return () => style.remove()
}
