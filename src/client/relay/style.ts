/**
 * 接力 stylesheet, `rl-` prefixed, on the shared tokens and controls of theme/base.ts.
 * Two columns side by side from 720px of the page's own width (a container query, so a
 * squeezed middle column reflows too); below that, two steps, the detail over the list.
 */

const CSS = `
.rl-page {
  height: 100%; min-height: 0; container-type: inline-size; container-name: rl;
  color: var(--ah-fg); font-size: 13px; line-height: 20px;
}
.rl-split { height: 100%; min-height: 0; display: grid; grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); }
.rl-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* The list. */
.rl-list { min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--ah-line); }
.rl-list-head { display: flex; align-items: center; gap: 4px; padding: 16px 12px 8px 16px; }
.rl-title { flex: 1; margin: 0; font-size: 15px; line-height: 24px; font-weight: 600; }
.rl-tools { display: flex; flex-direction: column; gap: 8px; padding: 0 12px 8px 16px; }
.rl-seg { align-self: flex-start; }
.rl-count { font-size: 11px; color: var(--ah-fg3); font-weight: 400; font-variant-numeric: tabular-nums; }
.rl-input {
  box-sizing: border-box; width: 100%; min-width: 0; padding: 5px 10px; border: 1px solid var(--ah-line-strong); border-radius: var(--ah-radius);
  background: transparent; color: var(--ah-fg); font: inherit; font-size: 13px; line-height: 20px;
}
.rl-input::placeholder { color: var(--ah-fg3); }
.rl-input:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -1px; border-color: transparent; }
.rl-scroll { flex: 1; min-height: 0; overflow: auto; padding: 0 8px 16px; overscroll-behavior: contain; }

.rl-row {
  appearance: none; box-sizing: border-box; width: 100%; display: flex; align-items: flex-start; gap: 10px; min-height: 52px;
  padding: 8px; border: 0; border-radius: var(--ah-radius); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
  -webkit-tap-highlight-color: transparent; transition: background-color 120ms ease;
}
.rl-row:hover { background: var(--ah-hover); }
.rl-row[aria-current="true"] { background: color-mix(in srgb, var(--ah-info) 12%, transparent); }
.rl-row:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.rl-row-pin { align-items: center; margin-bottom: 4px; }
.rl-row-icon {
  --rl-tint: var(--ah-fg2);
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--ah-radius-sm);
  color: color-mix(in srgb, var(--rl-tint) 80%, currentColor); background: color-mix(in srgb, var(--rl-tint) 12%, transparent);
}
.rl-row-icon[data-agent="qoder"], .rl-d-mark[data-agent="qoder"] { --rl-tint: var(--ah-info); }
.rl-row-icon[data-agent="hermes"], .rl-d-mark[data-agent="hermes"] { --rl-tint: var(--ah-mine); }
.rl-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.rl-row-top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.rl-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.rl-time { flex: none; font-size: 11px; color: var(--ah-fg3); white-space: nowrap; font-variant-numeric: tabular-nums; }
.rl-row-sub { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--ah-fg2); }
.rl-row-sub[data-tone="warn"] { color: var(--ah-warn-ink); }
.rl-row-who { flex: none; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ah-fg3); }
.rl-row-detail { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rl-row-detail[data-tone="danger"] { color: var(--ah-danger-ink); }
.rl-row-chevron { flex: none; color: var(--ah-fg3); display: inline-flex; }
.rl-chip {
  flex: none; height: 16px; padding: 0 5px; border-radius: 4px; font-size: 10px; line-height: 16px; font-weight: 600; letter-spacing: .02em;
  color: var(--ah-ok-ink); background: color-mix(in srgb, var(--ah-ok) 14%, transparent);
}
.rl-phase { --rl-tone: var(--ah-fg3); flex: none; display: inline-flex; color: color-mix(in srgb, var(--rl-tone) 75%, currentColor); }
.rl-phase[data-phase="running"], .rl-badge[data-phase="running"] { --rl-tone: var(--ah-info); }
.rl-phase[data-phase="failed"], .rl-badge[data-phase="failed"] { --rl-tone: var(--ah-danger); }
.rl-phase[data-phase="cloud"], .rl-badge[data-phase="cloud"] { --rl-tone: var(--ah-mine); }
.rl-badge[data-phase="idle"] { --rl-tone: var(--ah-ok); }
.rl-group-title { margin: 12px 8px 2px; font-size: 11px; line-height: 16px; font-weight: 600; color: var(--ah-fg3); }
.rl-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.rl-none { margin: 16px 8px; color: var(--ah-fg2); font-size: 12px; }
.rl-none p { margin: 4px 0 0; }
.rl-empty-title { margin: 0; font-weight: 600; color: var(--ah-fg); font-size: 13px; }

/* The detail column. */
.rl-detail { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.rl-thread, .rl-ov { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.rl-d-head { flex: none; display: flex; align-items: flex-start; gap: 10px; padding: 16px clamp(12px, 3cqi, 24px) 12px; border-bottom: 1px solid var(--ah-line); }
.rl-back { display: none; }
.rl-d-mark {
  --rl-tint: var(--ah-info);
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--ah-radius);
  color: color-mix(in srgb, var(--rl-tint) 80%, currentColor); background: color-mix(in srgb, var(--rl-tint) 12%, transparent);
}
.rl-d-id { flex: 1; min-width: 0; }
.rl-d-title {
  margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.rl-d-title:focus { outline: none; }
.rl-d-title:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 2px; border-radius: 2px; }
.rl-d-lead { margin: 2px 0 0; color: var(--ah-fg2); max-width: 72ch; }
.rl-d-meta { margin: 4px 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 0; font-size: 12px; color: var(--ah-fg2); }
.rl-meta-part { white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.rl-meta-part::before { content: "·"; margin: 0 6px; color: var(--ah-fg3); }
.rl-badge {
  --rl-tone: var(--ah-fg3);
  display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: 999px; font-weight: 500;
  color: color-mix(in srgb, var(--rl-tone) 70%, currentColor); background: color-mix(in srgb, var(--rl-tone) 12%, transparent);
}
.rl-badge + .rl-meta-part::before { content: none; margin: 0 0 0 8px; }
.rl-badge + .rl-meta-part { margin-left: 8px; }
.rl-d-actions { flex: none; display: flex; align-items: center; gap: 4px; }
.rl-flash { font-size: 12px; color: var(--ah-ok-ink); margin-right: 4px; }
.rl-live {
  flex: none; margin: 0; padding: 6px clamp(12px, 3cqi, 24px); display: flex; flex-wrap: wrap; gap: 4px 16px;
  font-size: 12px; color: var(--ah-fg2); background: var(--ah-soft); border-bottom: 1px solid var(--ah-line); font-variant-numeric: tabular-nums;
}
.rl-live-tool { display: inline-flex; align-items: center; gap: 6px; color: var(--ah-info-ink); min-width: 0; overflow-wrap: anywhere; }
.rl-d-alert { flex: none; margin: 8px clamp(12px, 3cqi, 24px) 0 !important; }

.rl-transcript { flex: 1; min-height: 0; overflow: auto; padding: 16px clamp(12px, 3cqi, 24px) 24px; display: flex; flex-direction: column; gap: 12px; overscroll-behavior: contain; }
.rl-transcript:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.rl-turn { display: flex; flex-direction: column; gap: 2px; max-width: 76ch; min-width: 0; }
.rl-turn-who { font-size: 11px; line-height: 16px; font-weight: 600; color: var(--ah-fg3); }
.rl-turn-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.rl-turn-text.rv-md { white-space: normal; }
.rl-turn-text.rv-md table { font-size: 12px; }
.rl-turn[data-role="user"] { align-self: flex-end; align-items: flex-end; max-width: min(76ch, 88%); }
.rl-turn[data-role="user"] .rl-turn-text { padding: 8px 12px; border-radius: var(--ah-radius-lg); background: var(--ah-hover); }
.rl-tool, .rl-tools-group summary {
  margin: 0; display: flex; align-items: center; gap: 6px; min-width: 0; font: 12px/18px var(--ah-mono); color: var(--ah-fg3); overflow-wrap: anywhere;
}
.rl-tool svg, .rl-tools-group summary svg { flex: none; }
.rl-tools-group summary { cursor: pointer; list-style: none; width: fit-content; border-radius: 4px; }
.rl-tools-group summary::-webkit-details-marker { display: none; }
.rl-tools-group summary svg { transition: transform 120ms ease; }
.rl-tools-group[open] summary svg { transform: rotate(90deg); }
.rl-tools-group summary:hover { color: var(--ah-fg2); }
.rl-tools-group summary:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 2px; }
.rl-tools-group ul { list-style: none; margin: 4px 0 0; padding: 0 0 0 18px; display: flex; flex-direction: column; gap: 2px; border-left: 1px solid var(--ah-line); margin-left: 5px; }
.rl-note { margin: 0; font-size: 12px; color: var(--ah-fg3); }
.rl-center { text-align: center; }

.rl-compose { flex: none; padding: 8px clamp(12px, 3cqi, 24px) max(12px, env(safe-area-inset-bottom)); border-top: 1px solid var(--ah-line); }
.rl-compose-box {
  display: flex; align-items: flex-end; gap: 8px; padding: 6px 6px 6px 12px; border: 1px solid var(--ah-line-strong); border-radius: var(--ah-radius-lg);
  background: var(--ah-layer); transition: border-color 120ms ease;
}
.rl-compose-box:focus-within { border-color: var(--ah-fg3); }
.rl-compose-box[data-disabled] { background: var(--ah-soft); }
.rl-compose-text {
  flex: 1; min-width: 0; box-sizing: border-box; min-height: 28px; max-height: 168px; margin: 0; padding: 4px 0; border: 0; resize: none; outline: none;
  background: transparent; color: var(--ah-fg); font: inherit; font-size: 13px; line-height: 20px;
}
.rl-compose-text::placeholder { color: var(--ah-fg3); }
.rl-compose-text:disabled { cursor: not-allowed; }
.rl-send {
  appearance: none; flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--ah-radius);
  background: var(--dsw-alias-button-primary-fill, var(--ah-fg)); color: var(--ah-bg); cursor: pointer; transition: opacity 120ms ease, transform 120ms ease;
}
.rl-send:hover:not(:disabled) { opacity: .88; }
.rl-send:active:not(:disabled) { transform: scale(.96); }
.rl-send:disabled { opacity: .3; cursor: default; }
.rl-send:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 2px; }
.rl-send[aria-busy="true"] svg { animation: rl-pulse 1s ease-in-out infinite; }
.rl-hint { margin: 6px 2px 0; font-size: 12px; line-height: 18px; color: var(--ah-fg3); overflow-wrap: anywhere; }
.rl-hint[data-tone="warn"] { color: var(--ah-warn-ink); }
.rl-hint[data-tone="danger"] { color: var(--ah-danger-ink); }
.rl-hint a { color: var(--ah-info-ink); }

.rl-alert { margin: 0; padding: 8px 12px; border-radius: var(--ah-radius); font-size: 12px; overflow-wrap: anywhere; }
.rl-list > .rl-alert { margin: 0 12px 8px 16px; }
.rl-alert[data-tone="danger"] { color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 10%, transparent); }
.rl-alert[data-tone="warn"] { color: var(--ah-warn-ink); background: color-mix(in srgb, var(--ah-warn) 12%, transparent); }

/* The overview: the glasses' workspaces and the cloud form. */
.rl-ov-body { flex: 1; min-height: 0; overflow: auto; padding: 16px clamp(12px, 3cqi, 24px) 32px; display: flex; flex-direction: column; gap: 16px; }
.rl-ov-body > * { max-width: 880px; }
.rl-ws { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--ah-line); border-radius: var(--ah-radius-lg); background: var(--ah-layer); }
.rl-ws-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.rl-ws-id { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.rl-ws-name { font-weight: 600; overflow-wrap: anywhere; }
.rl-ws-path { font: 11px/16px var(--ah-mono); color: var(--ah-fg3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rl-ws-actions { display: flex; align-items: center; gap: 4px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
.rl-ws-actions a.ah-btn { gap: 6px; text-decoration: none; }
.rl-state {
  --rl-tone: var(--ah-fg3);
  flex: none; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px;
  font-size: 12px; font-weight: 500; color: color-mix(in srgb, var(--rl-tone) 70%, currentColor); background: color-mix(in srgb, var(--rl-tone) 12%, transparent);
}
.rl-state[data-phase="online"] { --rl-tone: var(--ah-ok); }
.rl-state[data-phase="starting"], .rl-state[data-phase="retrying"] { --rl-tone: var(--ah-warn); }
.rl-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--rl-tone); }
.rl-state[data-phase="online"] .rl-dot { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ah-ok) 25%, transparent); }
.rl-state[data-phase="starting"] .rl-dot, .rl-state[data-phase="retrying"] .rl-dot { animation: rl-pulse 1.4s ease-in-out infinite; }
.rl-stats { margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px 16px; }
.rl-stat { min-width: 0; display: flex; flex-direction: column; }
.rl-stat dt { font-size: 11px; line-height: 16px; color: var(--ah-fg3); }
.rl-stat dd { margin: 0; font-size: 12px; color: var(--ah-fg); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rl-stat dd[data-mono="true"] { font: 11px/20px var(--ah-mono); }
.rl-ws-tasks { list-style: none; margin: 0 -8px; padding: 0; display: flex; flex-direction: column; border-top: 1px solid var(--ah-line); padding-top: 8px; }
.rl-ws-task {
  width: 100%; min-height: 44px; display: flex; align-items: center; gap: 10px; padding: 6px 8px; border: 0; border-radius: var(--ah-radius);
  background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.rl-ws-task:hover { background: var(--ah-hover); }
.rl-ws-task:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.rl-empty-card { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 24px; border: 1px dashed var(--ah-line-strong); border-radius: var(--ah-radius-lg); }
.rl-empty-card .rl-empty-title { font-size: 13px; }
.rl-empty-hint { margin: 0; color: var(--ah-fg2); overflow-wrap: anywhere; }
.rl-empty-hint code { font: 12px/18px var(--ah-mono); }
.rl-cloud-head { display: flex; align-items: flex-start; gap: 10px; }
.rl-cloud-head .rl-d-mark { --rl-tint: var(--ah-mine); }
.rl-cloud-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; }
.rl-cloud-lead { margin: 2px 0 0; color: var(--ah-fg2); font-size: 12px; }
.rl-field { display: flex; flex-direction: column; gap: 4px; }
.rl-field-label { font-size: 12px; font-weight: 500; color: var(--ah-fg2); }
.rl-field textarea.rl-input { resize: vertical; min-height: 64px; }
.rl-cloud-foot { display: flex; align-items: flex-start; gap: 12px; }
.rl-cloud-foot .rl-hint { flex: 1; margin-top: 6px; }

/* Notices, over the whole window: bottom right; on a phone, across the top. */
.rl-notices {
  position: fixed; z-index: var(--ah-z-float); right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); width: min(360px, calc(100vw - 32px));
  display: flex; flex-direction: column; gap: 8px; pointer-events: none; font-size: 13px; line-height: 1.45; color: var(--ah-fg);
}
.rl-notice {
  pointer-events: auto; display: flex; align-items: center; gap: 8px; min-height: 44px; box-sizing: border-box; padding: 6px 6px 6px 12px;
  border-radius: var(--ah-radius); background: var(--dsw-specific-menu, var(--ah-popup));
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(24px)); backdrop-filter: var(--dsw-menu-backdrop-filter, blur(24px));
  box-shadow: var(--ah-shadow), 0 0 0 .5px var(--ah-line); animation: rl-in 220ms var(--ah-ease);
}
.rl-notice-mark { flex: none; display: inline-flex; color: var(--ah-ok-ink); }
.rl-notice[data-phase="failed"] .rl-notice-mark { color: var(--ah-danger-ink); }
.rl-notice-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.rl-notice-title, .rl-notice-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rl-notice-title { font-weight: 600; }
.rl-notice-sub { font-size: 12px; color: var(--ah-fg3); }
.rl-notice-view {
  appearance: none; flex: none; height: 28px; padding: 0 10px; border: 0; border-radius: var(--ah-radius-sm); background: transparent;
  color: var(--ah-info-ink); font: inherit; font-weight: 600; cursor: pointer;
}
.rl-notice-view:hover { background: var(--ah-hover); }
.rl-notices button:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }

.rl-spin { animation: rl-spin 1s linear infinite; }
@keyframes rl-spin { to { transform: rotate(360deg); } }
@keyframes rl-pulse { 50% { opacity: .35; } }
@keyframes rl-in { from { opacity: 0; transform: translateY(8px); } }
@keyframes rl-drop { from { opacity: 0; transform: translateY(-8px); } }
@media (prefers-reduced-motion: reduce) {
  .rl-spin, .rl-state .rl-dot, .rl-send[aria-busy="true"] svg, .rl-notice { animation: none; }
  .rl-row, .rl-send, .rl-compose-box, .rl-tools-group summary svg { transition: none; }
}

/* Two steps on a narrow page: the list, or the detail with a way back. */
@container rl (max-width: 719px) {
  .rl-split { grid-template-columns: minmax(0, 1fr); }
  .rl-split[data-view="list"] > .rl-detail, .rl-split[data-view="detail"] > .rl-list { display: none; }
  .rl-list { border-right: 0; }
  .rl-back { display: inline-flex; margin-left: -6px; }
  .rl-d-head { flex-wrap: wrap; padding-top: 12px; }
  .rl-d-mark { display: none; }
  .rl-d-actions { width: 100%; justify-content: flex-end; }
  .rl-d-actions:empty { display: none; }
  .rl-turn[data-role="user"] { max-width: 92%; }
  .rl-ws { padding: 12px; }
  .rl-ws-head { flex-wrap: wrap; }
  .rl-ws-id { order: -1; flex-basis: 100%; }
  .rl-ws-actions { margin-left: auto; }
  .rl-cloud-foot { flex-direction: column; align-items: stretch; }
  /* No zoom on focus in iOS Safari: 16px text in fields. */
  .rl-input, .rl-compose-text { font-size: 16px; line-height: 22px; }
}
@media (pointer: coarse) {
  .rl-row { min-height: 56px; }
  .rl-send { width: 40px; height: 40px; }
  .rl-notice { min-height: 48px; }
  .rl-notice-view, .rl-notices .ah-icon-btn { height: 40px; }
}
@media (max-width: 640px) {
  .rl-notices { left: 12px; right: 12px; width: auto; bottom: auto; top: calc(12px + env(safe-area-inset-top)); }
  .rl-notice { animation-name: rl-drop; }
}
`

export function injectRelayStyle(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.relay'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}
