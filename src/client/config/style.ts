/**
 * 设置 → Agent Hub stylesheet, `ac-` prefixed, on the shared tokens and
 * controls of theme/base.ts.
 */
const CSS = `
.ac-row[data-wide] .ac-automation-body { display:flex; flex-direction:column; gap:12px; min-width:0; width:100%; }
/* A template that fits this machine: one line on what it does, one button to fill a draft from it. */
.ac-template { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; padding:10px 12px; border:1px dashed var(--ah-line); border-radius:var(--ah-radius); min-width:0; }
.ac-template-icon { flex:none; align-self:flex-start; margin-top:1px; fill:none; stroke:var(--ah-fg2); stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.ac-template-text { flex:1 1 220px; min-width:0; margin:0; font-size:var(--ac-fs-body); line-height:18px; overflow-wrap:anywhere; }
.ac-template-text strong { display:block; font-size:var(--ac-fs-label); line-height:20px; font-weight:600; }
.ac-template-text span { color:var(--ah-fg2); }
.ac-template > .ah-btn { flex:none; margin-inline-start:auto; }
@media (pointer: coarse) { .ac-template > .ah-btn { min-height:44px; } }
.ac-automation-task { border:1px solid var(--ah-line); border-radius:var(--ah-radius); padding:12px; min-width:0; overflow-wrap:anywhere; }
.ac-automation-task .ac-row-head { flex-wrap:wrap; }
.ac-automation-editor { display:flex; flex-direction:column; align-items:flex-start; gap:12px; min-width:0; }
.ac-automation-editor fieldset { display:flex; flex-direction:column; gap:8px; border:1px solid var(--ah-line); border-radius:var(--ah-radius); padding:12px; width:100%; box-sizing:border-box; min-width:0; }
.ac-automation-field { display:flex; flex-direction:column; gap:6px; font-size: var(--ac-fs-body); line-height:18px; }
.ac-automation-preview { white-space:pre-wrap; overflow-wrap:anywhere; font-size: var(--ac-fs-body); }
.ac-automation .ac-input { width:100%; box-sizing:border-box; min-width:0; }
.ac-automation button { min-height:36px; }
.ac-local-time { display:inline-block; margin-inline-start:8px; color:var(--ah-fg2); }
.ac-next-run { display:inline-flex; flex-wrap:wrap; align-items:center; gap:4px 8px; }
.ac-countdown { display:inline-flex; align-items:center; padding:0 8px; min-height:20px; border-radius:999px; border:1px solid var(--ah-line); color:var(--ah-fg2); font-variant-numeric:tabular-nums; white-space:nowrap; }
.ac-countdown[data-due] { color:var(--ah-fg); }
.ac-task-state[data-on] { color:var(--ah-ok-ink); background:color-mix(in srgb, var(--ah-ok) 12%, transparent); }
.ac-runs { display:flex; flex-direction:column; gap:8px; margin:10px 0; min-width:0; }
.ac-run-empty { margin:10px 0; font-size: var(--ac-fs-body); line-height:18px; color:var(--ah-fg2); }
.ac-run-latest, .ac-run-row { --tone:var(--ah-fg3); --ink:var(--ah-fg2); display:flex; align-items:flex-start; gap:10px; min-width:0; }
.ac-run-latest { padding:10px 12px; border-radius:var(--ah-radius); border:1px solid color-mix(in srgb, var(--tone) 28%, var(--ah-line)); background:color-mix(in srgb, var(--tone) 8%, transparent); }
.ac-runs [data-tone=ok] { --tone:var(--ah-ok); --ink:var(--ah-ok-ink); }
.ac-runs [data-tone=error] { --tone:var(--ah-danger); --ink:var(--ah-danger-ink); }
.ac-runs [data-tone=unknown], .ac-runs [data-tone=stalled] { --tone:var(--ah-warn); --ink:var(--ah-warn-ink); }
.ac-runs [data-tone=running], .ac-runs [data-tone=pending] { --tone:var(--ah-info); --ink:var(--ah-info-ink); }
.ac-run-icon { flex:none; margin-top:1px; fill:none; stroke:var(--ink); stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }
.ac-runs [data-tone=running] > .ac-run-icon { animation:ac-run-spin .9s linear infinite; }
@keyframes ac-run-spin { to { transform:rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { .ac-runs [data-tone=running] > .ac-run-icon { animation:none; } }
.ac-run-body { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
.ac-run-line { margin:0; display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 12px; font-size: var(--ac-fs-label); line-height:20px; }
.ac-run-label { color:var(--ink); font-weight:600; }
.ac-run-meta { display:inline-flex; flex-wrap:wrap; gap:0 6px; font-size: var(--ac-fs-body); color:var(--ah-fg2); font-variant-numeric:tabular-nums; }
.ac-run-meta > span + span::before { content:"·"; margin-inline-end:6px; color:var(--ah-fg3); }
.ac-run-summary { margin:0; font-size: var(--ac-fs-body); line-height:18px; color:var(--ah-fg); overflow-wrap:anywhere; }
.ac-run-hint { margin:2px 0 0; font-size: var(--ac-fs-body); line-height:18px; color:var(--ah-fg2); }
.ac-run-history > summary { cursor:pointer; display:inline-flex; align-items:center; min-height:28px; font-size: var(--ac-fs-body); color:var(--ah-fg2); border-radius:var(--ah-radius-sm); }
.ac-run-history > summary:hover { color:var(--ah-fg); }
.ac-run-history > summary { list-style:none; gap:8px; }
.ac-run-history > summary::-webkit-details-marker { display:none; }
.ac-run-history > summary::before { content:""; width:5px; height:5px; margin-inline:2px; border:solid currentColor; border-width:0 1.5px 1.5px 0; transform:rotate(-45deg); transition:transform .15s var(--ah-ease); }
.ac-run-history[open] > summary::before { transform:rotate(45deg); }
@media (prefers-reduced-motion: reduce) { .ac-run-history > summary::before { transition:none; } }
.ac-run-history > summary:focus-visible { outline:2px solid var(--ah-focus); outline-offset:2px; }
.ac-run-list { list-style:none; margin:4px 0 0; padding:0 0 0 12px; border-inline-start:1px solid var(--ah-line); display:flex; flex-direction:column; gap:10px; }
.ac-run-row .ac-run-line { font-size: var(--ac-fs-body); line-height:18px; }
.ac-run-row .ac-run-summary { color:var(--ah-fg2); }
@container ac-page (max-width:440px) {
  .ac-automation button { min-height:44px; }
  .ac-run-latest { padding:10px; gap:8px; }
  .ac-run-history > summary { min-height:44px; }
}

/* One type scale for the settings pages and their notices: group headings, option labels, descriptions and values, tags and details. */
:root { --ac-fs-heading: 14px; --ac-fs-label: 13px; --ac-fs-body: 12px; --ac-fs-meta: 11px; }
.ac-page {
  display: flex; flex-direction: column; gap: 16px; color: inherit; container: ac-page / inline-size;
}
/* Touch screens zoom into fields under 16px when they take the focus: only there do fields grow. */
@media (pointer: coarse) { .ac-page .ac-input, .ac-page textarea, .ac-page select { font-size: 16px; } }
.ac-visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
/* 功能模块: one tile per optional module above the groups, the whole tile its switch. */
.ac-modules {
  display: flex; flex-direction: column; gap: 12px; padding: 14px 16px 16px; border-radius: var(--ah-radius-lg);
  background: color-mix(in srgb, currentColor 3%, transparent); border: 1px solid var(--ah-line);
}
.ac-modules-head h2 { margin: 0; font-size: var(--ac-fs-heading); line-height: 20px; font-weight: 600; }
.ac-modules-head p { margin: 2px 0 0; font-size: var(--ac-fs-body); line-height: 18px; color: var(--ah-fg2); }
.ac-modules-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr)); gap: 8px; }
.ac-module {
  appearance: none; display: flex; flex-direction: column; gap: 4px; min-width: 0; min-height: 64px; padding: 10px 12px;
  border: 1px solid var(--ah-line); border-radius: var(--ah-radius); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
  transition: background-color 160ms var(--ah-ease), border-color 160ms var(--ah-ease);
}
.ac-module:hover:not(:disabled) { background: color-mix(in srgb, currentColor 4%, transparent); }
.ac-module:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; }
.ac-module:disabled { opacity: .55; cursor: default; }
.ac-module[aria-checked="true"] { border-color: color-mix(in srgb, var(--ah-ok) 45%, var(--ah-line)); background: color-mix(in srgb, var(--ah-ok) 6%, transparent); }
.ac-module-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ac-module-icon { flex: none; fill: none; stroke: var(--ah-fg2); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.ac-module[aria-checked="true"] .ac-module-icon { stroke: var(--ah-ok-ink); }
.ac-module-name { min-width: 0; font-size: var(--ac-fs-label); line-height: 20px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-module-tag { flex: none; padding: 0 6px; border: 1px solid var(--ah-line); border-radius: 999px; font-size: var(--ac-fs-meta); line-height: 16px; color: var(--ah-fg2); white-space: nowrap; }
.ac-module-switch { margin-inline-start: auto; pointer-events: none; }
.ac-module[aria-checked="true"] .ac-module-switch { background: var(--ah-ok); }
.ac-module[aria-checked="true"] .ac-module-switch .ac-thumb { transform: translateX(16px); }
.ac-module-hint { padding-inline-start: 24px; font-size: var(--ac-fs-body); line-height: 18px; color: var(--ah-fg2); overflow-wrap: anywhere; }
.ac-module-needs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; margin-top: 2px; font-size: var(--ac-fs-meta); color: var(--ah-fg2); }
.ac-module-plugin { padding: 0 6px; border-radius: var(--ah-radius-sm); line-height: 16px; white-space: nowrap; }
.ac-module-plugin[data-state="on"] { color: var(--ah-ok-ink); background: color-mix(in srgb, var(--ah-ok) 12%, transparent); }
.ac-module-plugin[data-state="missing"], .ac-module-plugin[data-state="off"] { color: var(--ah-warn-ink); background: color-mix(in srgb, var(--ah-warn) 14%, transparent); }
@container ac-page (max-width:440px) {
  .ac-modules { padding: 12px; }
  .ac-module { min-height: 56px; }
}
@media (prefers-reduced-motion: reduce) { .ac-module { transition: none; } }

/* The groups under four headings; a heading names its groups for assistive technology too. */
.ac-category { display: flex; flex-direction: column; gap: 8px; }
.ac-category-title { margin: 4px 0 0; font-size: var(--ac-fs-body); line-height: 18px; font-weight: 600; letter-spacing: .02em; color: var(--ah-fg2); }
.ac-lead { margin: 0; font-size: var(--ac-fs-body); line-height: 18px; color: var(--ah-fg2); }
.ac-notice {
  margin: 0; padding: 10px 12px; border-radius: var(--ah-radius); font-size: var(--ac-fs-body); line-height: 18px;
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.ac-group {
  border-radius: var(--ah-radius-lg); padding: 4px 16px;
  background: color-mix(in srgb, currentColor 3%, transparent);
  border: 1px solid var(--ah-line);
}
.ac-group-head { padding: 12px 0 10px; border-bottom: 1px solid var(--ah-line); }
.ac-group-head h3 { margin: 0; font-size: var(--ac-fs-heading); line-height: 20px; font-weight: 600; }
.ac-group-head p { margin: 2px 0 0; font-size: var(--ac-fs-body); line-height: 18px; color: var(--ah-fg2); }
/* Foldable groups: the whole title row toggles; folded, it carries a one-line summary. */
.ac-group-title { margin: 0; font: inherit; }
.ac-group-toggle {
  appearance: none; display: flex; align-items: center; gap: 8px; width: calc(100% + 32px); min-height: 44px; margin: 0 -16px; padding: 10px 16px;
  border: none; border-radius: var(--ah-radius-lg); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.ac-group-toggle:hover { background: color-mix(in srgb, currentColor 4%, transparent); }
.ac-group-toggle:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.ac-group-chevron {
  flex: none; width: 12px; text-align: center; font-size: 15px; line-height: 1; color: var(--ah-fg3);
  transition: transform 160ms var(--ah-ease);
}
.ac-group[data-open] .ac-group-chevron { transform: rotate(90deg); }
.ac-group-name { flex: none; font-size: var(--ac-fs-heading); line-height: 20px; font-weight: 600; }
.ac-group-flag {
  flex: none; padding: 0 6px; border-radius: var(--ah-radius-sm); font-size: var(--ac-fs-meta); line-height: 18px; font-weight: 500;
  color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 12%, transparent);
}
.ac-group-summary {
  flex: 1; min-width: 0; margin-left: 4px; font-size: var(--ac-fs-body); line-height: 18px; color: var(--ah-fg2); text-align: right;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ac-group-note {
  margin: 0; padding: 0 0 10px 20px; font-size: var(--ac-fs-body); line-height: 18px; color: var(--ah-fg2);
  border-bottom: 1px solid var(--ah-line);
}
.ac-group[data-attention] { border-color: color-mix(in srgb, var(--ah-danger) 35%, transparent); }
.ac-transfer { flex: none; font-size: var(--ac-fs-body); white-space: nowrap; }
/* Fold all: always in the toolbar; narrow, it keeps its icon only, still a finger-sized target. */
.ac-fold-all {
  appearance: none; flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; min-width: 32px; padding: 0 10px;
  border: 1px solid var(--ah-line); border-radius: var(--ah-radius); background: transparent; color: inherit; font: inherit; font-size: var(--ac-fs-body); white-space: nowrap; cursor: pointer;
  transition: background-color 120ms ease;
}
.ac-fold-all:hover { background: var(--ah-hover); }
.ac-fold-all:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; }
.ac-fold-all svg { flex: none; }
@container ac-page (max-width: 480px) {
  .ac-fold-label { display: none; }
  .ac-fold-all { min-width: 40px; min-height: 40px; padding: 0; }
}
@media (pointer: coarse) { .ac-fold-all { min-width: 44px; min-height: 44px; } }
.ac-transfer-panel { display: flex; flex-direction: column; gap: 4px; }
.ac-transfer-panel p { margin: 0; }
p.ac-transfer-panel { display: block; }
.ac-transfer-panel[data-tone="ok"] { color: var(--ah-ok-ink); }
.ac-transfer-panel[data-tone="bad"] { color: var(--ah-danger-ink); }
.ac-transfer-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
/* Review automation: read-only native timing and a single task toggle. */
.ac-review-schedule-body { display: flex; flex-direction: column; align-items: stretch; gap: 12px; min-width: 0; }
.ac-review-schedule-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ac-review-schedule-actions .ah-btn { min-height: 36px; }
.ac-review-task-meta { margin: 0; display: grid; gap: 8px; font-size: var(--ac-fs-body); line-height: 18px; }
.ac-review-task-meta > div { display: grid; grid-template-columns: minmax(72px, auto) minmax(0, 1fr); gap: 8px 16px; }
.ac-review-task-meta dt { color: var(--ah-fg2); }
.ac-review-task-summary > summary { cursor: pointer; min-height: 24px; }
.ac-review-task-summary > summary:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 2px; }
.ac-review-task-summary pre { margin: 8px 0 0; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
.ac-review-task-meta dd { margin: 0; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.ac-review-confirm { display: flex; flex-direction: column; gap: 8px; }
.ac-review-confirm p, .ac-review-error { margin: 0; }
.ac-review-error { color: var(--ah-danger-ink); font-size: var(--ac-fs-body); line-height: 18px; overflow-wrap: anywhere; }
@container ac-page (max-width: 640px) {
  .ac-review-schedule-actions .ah-btn { min-height: 44px; }
  .ac-review-task-meta > div { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}
@media (pointer: coarse) { .ac-review-schedule-actions .ah-btn { min-height: 44px; } }
/* Settings sync: a status bar with the sync button, the conflicts, the last run, the history. */
.ac-sync { gap: 12px; font-size: var(--ac-fs-body); line-height: 18px; container: ac-sync / inline-size; }
.ac-sync p { margin: 0; }
.ac-sync-icon { flex: none; display: block; }
.ac-sync-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.ac-sync-bar-text { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; min-width: 0; font-size: var(--ac-fs-body); line-height: 18px; }
.ac-sync-state { display: inline-flex; align-items: center; gap: 4px; font-size: var(--ac-fs-label); line-height: 20px; font-weight: 600; }
.ac-sync-state[data-tone="ok"] { color: var(--ah-ok-ink); }
.ac-sync-state[data-tone="attention"] { color: var(--ah-warn-ink); }
.ac-sync-fetch { flex: none; gap: 6px; white-space: nowrap; }
.ac-sync-counts { font-family: var(--ah-mono); font-size: var(--ac-fs-body); font-variant-numeric: tabular-nums; color: var(--ah-fg2); }
.ac-sync .ac-sync-message { align-items: flex-start; }
.ac-sync .ac-sync-message .ac-input { align-self: stretch; }
/* Conflicts: one row per setting, the two sides as a pair of radio cards holding their values. */
.ac-sync-choice { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ac-sync-choice-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.ac-sync-choice-head h4 { margin: 0; font-size: var(--ac-fs-label); line-height: 20px; font-weight: 600; }
.ac-sync-bulk { display: flex; gap: 16px; }
.ac-sync-bulk .ac-link { font-size: var(--ac-fs-body); }
.ac-sync-conflicts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
.ac-sync-conflict { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ac-sync-conflict-name { font-family: var(--ah-mono); font-size: var(--ac-fs-body); color: var(--ah-fg2); overflow-wrap: anywhere; }
.ac-sync-sides { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 8px; }
.ac-sync-side-pick {
  appearance: none; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; min-height: 44px; padding: 8px 12px; box-sizing: border-box;
  border: 1px solid var(--ah-line-strong); border-radius: var(--ah-radius); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
}
.ac-sync-side-pick:hover:not(:disabled) { background: var(--ah-hover); }
.ac-sync-side-pick[aria-checked="true"] { border-color: var(--ah-accent); box-shadow: inset 0 0 0 1px var(--ah-accent); background: color-mix(in srgb, var(--ah-accent) 6%, transparent); }
.ac-sync-side-pick:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; }
.ac-sync-side-pick:disabled { cursor: default; opacity: .6; }
.ac-sync-side-label { display: inline-flex; align-items: center; gap: 6px; font-size: var(--ac-fs-body); line-height: 18px; font-weight: 600; }
.ac-sync-side-label::before {
  content: ''; flex: none; width: 12px; height: 12px; box-sizing: border-box; border-radius: 50%; border: 1px solid var(--ah-line-strong);
}
.ac-sync-side-pick[aria-checked="true"] .ac-sync-side-label::before { border: 4px solid var(--ah-accent); }
.ac-sync-side-pick .ac-sync-value { max-width: 100%; }
.ac-sync-choice > .ac-sync-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
/* The last run: what it did, what did not take effect, undo. */
.ac-sync-outcome { display: flex; flex-direction: column; gap: 6px; }
.ac-sync-outcome-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.ac-sync-outcome-head .ac-link { font-size: var(--ac-fs-body); }
.ac-sync-outcome details > summary { cursor: pointer; color: var(--ah-fg2); }
.ac-sync-changelist { margin: 4px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.ac-sync-changelist li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
.ac-sync-changelist code { font-family: var(--ah-mono); overflow-wrap: anywhere; }
.ac-sync-fetch[aria-busy] .ac-sync-icon { animation: ac-sync-spin 900ms linear infinite; }
@keyframes ac-sync-spin { to { transform: rotate(360deg); } }
.ac-sync .ac-notice[data-tone="bad"] { color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 8%, transparent); }
.ac-sync .ac-notice[data-tone="ok"] { color: var(--ah-ok-ink); background: color-mix(in srgb, var(--ah-ok) 8%, transparent); }

.ac-sync .ac-tag { font-size: var(--ac-fs-meta); white-space: nowrap; }
.ac-sync-value {
  display: inline; padding: 1px 6px; border-radius: var(--ah-radius-sm); font-family: var(--ah-mono); font-size: var(--ac-fs-body); line-height: 20px;
  white-space: pre-wrap; overflow-wrap: anywhere; box-decoration-break: clone; -webkit-box-decoration-break: clone;
  background: color-mix(in srgb, currentColor 7%, transparent);
}
.ac-sync-value[data-absent] { padding: 0; font-family: inherit; font-style: italic; color: var(--ah-fg3); background: none; }
.ac-sync-message { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.ac-sync-confirm-actions { flex: none; display: flex; justify-content: flex-end; gap: 8px; margin-left: auto; }
.ac-sync-confirm-actions .ah-btn { white-space: nowrap; }
.ac-sync-progress { display: flex; flex-direction: column; gap: 6px; }
.ac-sync-progress-head { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.ac-sync-progress[data-stage="installing"] .ac-sync-icon, .ac-sync-progress[data-stage="applying"] .ac-sync-icon { animation: ac-sync-spin 900ms linear infinite; }
.ac-sync-progress-result { font-family: var(--ah-mono); overflow-wrap: anywhere; }
.ac-sync-progress-log > summary { cursor: pointer; color: var(--ah-fg2); }
.ac-sync-progress-log pre {
  margin: 6px 0 0; padding: 8px 10px; max-height: 220px; overflow: auto; border-radius: var(--ah-radius);
  font-family: var(--ah-mono); font-size: var(--ac-fs-meta); line-height: 16px; white-space: pre-wrap; overflow-wrap: anywhere;
  color: var(--ah-fg); background: color-mix(in srgb, currentColor 6%, transparent);
}

.ac-sync-more { display: flex; flex-wrap: wrap; gap: 4px 16px; }
/* Overwrite: two options side by side, stacked when narrow; the side being replaced is tinted. */
.ac-sync-force { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.ac-sync-force h4 { margin: 0; font-size: var(--ac-fs-label); line-height: 20px; font-weight: 600; }
.ac-sync-force-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 8px; }
.ac-sync-force-option {
  display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 12px; box-sizing: border-box;
  border: 1px solid var(--ah-line-strong); border-radius: var(--ah-radius); transition: border-color 120ms ease, box-shadow 120ms ease;
}
.ac-sync-force-option[data-asking] { border-color: color-mix(in srgb, var(--ah-danger) 60%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ah-danger) 60%, transparent); }
.ac-sync-force-option h5 { margin: 0; font-size: var(--ac-fs-body); line-height: 18px; font-weight: 600; }
.ac-sync-force-route { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ac-sync-force-end {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: var(--ah-radius-sm); font-size: var(--ac-fs-meta); line-height: 18px;
  background: color-mix(in srgb, currentColor 8%, transparent); color: var(--ah-fg2);
}
.ac-sync-force-end[data-target] { color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 10%, transparent); }
.ac-sync-force-arrow { flex: none; color: var(--ah-fg3); }
.ac-sync-force-impact { font-variant-numeric: tabular-nums; }
.ac-sync-force-impact[data-tone="attention"] { color: var(--ah-warn-ink); }
.ac-sync-force-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: auto; padding-top: 4px; }
.ac-sync-force-actions .ah-btn { gap: 6px; white-space: nowrap; }
.ac-sync-force-actions .ah-btn[aria-busy] .ac-sync-icon { animation: ac-sync-spin 900ms linear infinite; }
.ac-sync-more .ac-link { font-size: var(--ac-fs-body); }
.ac-sync-history { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: var(--ac-fs-body); line-height: 18px; }
.ac-sync-history li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.ac-sync-history code { font-family: var(--ah-mono); color: var(--ah-fg3); }
.ac-sync-subject { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }

/* Narrow: the actions take the full width, finger-sized. */
@container ac-sync (max-width: 560px) {
  .ac-sync-fetch { flex: 1 1 100%; justify-content: center; min-height: 44px; }
  .ac-sync-confirm-actions, .ac-sync-choice > .ac-sync-confirm-actions { flex: 1 1 100%; }
  .ac-sync-confirm-actions .ah-btn { flex: 1; min-height: 44px; }
  .ac-sync-message .ac-input { min-height: 44px; }
  .ac-sync-force-actions .ah-btn { flex: 1; justify-content: center; min-height: 44px; }
  .ac-sync-more .ac-link { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .ac-sync-side-pick, .ac-sync-force-option, .ac-fold-all { transition: none; }
  .ac-sync-fetch[aria-busy] .ac-sync-icon, .ac-sync-force-actions .ah-btn[aria-busy] .ac-sync-icon { animation: none; }
}
.ac-sync-notice > span { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
.ac-sync-notice[data-tone="bad"] { border-color: color-mix(in srgb, var(--ah-danger) 45%, transparent); }
.ac-sync-notice {
  position: fixed; right: 16px; bottom: max(16px, env(safe-area-inset-bottom)); z-index: var(--ah-z-float); display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  max-width: min(480px, calc(100vw - 32px)); box-sizing: border-box;
  padding: 10px 12px; border-radius: var(--ah-radius); font-size: var(--ac-fs-body); line-height: 18px;
  background: var(--ah-popup); color: var(--ah-fg); border: 1px solid var(--ah-line-strong); box-shadow: var(--ah-shadow);
}
.ac-rows > .ac-row + .ac-row { border-top: 1px solid var(--ah-line); }
.ac-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 14px 0; }
.ac-row[data-wide] { flex-direction: column; align-items: stretch; gap: 8px; }
.ac-row-text { min-width: 0; flex: 1; }
.ac-row-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ac-label { font-size: var(--ac-fs-label); line-height: 20px; }
.ac-hint { margin: 2px 0 0; font-size: var(--ac-fs-body); line-height: 18px; color: var(--ah-fg2); }
.ac-hint[data-invalid] { color: var(--ah-danger-ink); }
.ac-badges { display: inline-flex; align-items: center; gap: 6px; font-size: var(--ac-fs-meta); }
.ac-muted { color: var(--ah-fg3); }
.ac-tag { padding: 0 6px; border-radius: var(--ah-radius-sm); font-size: var(--ac-fs-meta); line-height: 18px; background: color-mix(in srgb, currentColor 10%, transparent); }
.ac-link {
  appearance: none; border: none; background: none; padding: 0; color: inherit; font: inherit; font-size: var(--ac-fs-meta);
  text-decoration: underline; text-underline-offset: 2px; color: var(--ah-fg2); cursor: pointer;
}
.ac-link:hover:not(:disabled) { color: var(--ah-fg); }
.ac-link:disabled { cursor: default; opacity: .35; }
.ac-control { flex: none; display: flex; justify-content: flex-end; }
.ac-row[data-wide] .ac-control { display: block; }
.ac-input {
  box-sizing: border-box; width: 100%; min-width: 0; padding: 6px 10px; border-radius: var(--ah-radius);
  border: 1px solid var(--ah-line-strong); background: transparent;
  color: inherit; font: inherit; font-size: var(--ac-fs-label); line-height: 20px; resize: vertical;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
textarea.ac-input { resize: vertical; line-height: 1.55; }
.ac-input[data-markdown] { font-family: var(--ah-mono); font-size: var(--ac-fs-body); tab-size: 2; min-height: 120px; }
.ac-input[data-numeric] { width: 120px; text-align: right; font-variant-numeric: tabular-nums; }
.ac-input::placeholder { color: var(--ah-fg3); opacity: 1; }
.ac-input:focus { outline: none; border-color: color-mix(in srgb, currentColor 45%, transparent); }
.ac-input[aria-invalid] { border-color: var(--ah-danger); }
.ac-input:disabled { opacity: .5; }
.ac-route { display: flex; flex-direction: column; gap: 6px; }
.ac-select { cursor: pointer; }
.ac-stepper {
  flex: none; display: grid; grid-template-columns: 36px minmax(64px, auto) 36px; align-items: stretch; min-height: 36px;
  border: 1px solid var(--ah-line-strong); border-radius: var(--ah-radius); overflow: hidden;
  font-variant-numeric: tabular-nums;
}
.ac-stepper[data-compact] { grid-template-columns: 32px 80px 32px; min-height: 32px; border-color: var(--ah-line); }
.ac-stepper-step {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; min-width: 32px;
  border: 0; background: transparent; color: inherit; font: inherit; font-size: 17px; line-height: 1; cursor: pointer;
  transition: background-color 120ms ease, opacity 120ms ease;
}
.ac-stepper-step:hover:not(:disabled) { background: var(--ah-hover); }
.ac-stepper-step:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.ac-stepper-step:disabled { cursor: default; opacity: .28; }
.ac-stepper-value {
  display: inline-flex; align-items: baseline; justify-content: center; gap: 2px; min-width: 0; padding: 6px 8px;
  border-inline: 1px solid var(--ah-line); font-size: var(--ac-fs-label); line-height: 22px; white-space: nowrap;
}
.ac-stepper[data-compact] .ac-stepper-value { padding: 4px 6px; font-size: var(--ac-fs-label); line-height: 22px; }
.ac-stepper-value small { font-size: var(--ac-fs-meta); color: var(--ah-fg3); }
.ac-stepper-follow { font-size: var(--ac-fs-body); color: var(--ah-fg3); }
/* 界面文字大小: the whole on the row itself, the regions in a fold under it. */
.ac-scale { gap: 10px; }
.ac-scale-main { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.ac-scale-toggle {
  appearance: none; align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; min-height: 32px; margin-left: -8px; padding: 4px 8px;
  border: none; border-radius: var(--ah-radius-sm); background: transparent; color: var(--ah-fg2); font: inherit; font-size: var(--ac-fs-body); line-height: 18px; cursor: pointer;
}
.ac-scale-toggle:hover { background: var(--ah-hover); color: var(--ah-fg); }
.ac-scale-toggle:focus-visible, .ac-scale-reset:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; }
.ac-scale-toggle[aria-expanded="true"] .ac-group-chevron { transform: rotate(90deg); }
.ac-scale-count {
  padding: 0 6px; border-radius: var(--ah-radius-sm); font-size: var(--ac-fs-meta); line-height: 18px;
  color: var(--ah-info-ink); background: color-mix(in srgb, var(--ah-info) 12%, transparent);
}
.ac-scale-regions {
  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: var(--ah-radius);
  background: color-mix(in srgb, currentColor 3%, transparent); border: 1px solid var(--ah-line);
}
.ac-scale-regions > .ac-hint { margin: 0; }
.ac-scale-list { margin: 0; padding: 0; list-style: none; }
.ac-scale-region { display: grid; grid-template-columns: minmax(0, 1fr) auto 28px; align-items: center; gap: 4px 10px; padding: 8px 0; }
.ac-scale-region + .ac-scale-region { border-top: 1px solid var(--ah-line); }
.ac-scale-region-text { display: flex; flex-direction: column; min-width: 0; }
.ac-scale-region-name { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 8px; font-size: var(--ac-fs-label); line-height: 20px; }
.ac-scale-region-name small { font-size: var(--ac-fs-meta); color: var(--ah-info-ink); font-variant-numeric: tabular-nums; }
.ac-scale-region-hint { font-size: var(--ac-fs-body); line-height: 18px; color: var(--ah-fg2); }
.ac-scale-region[data-tuned] .ac-stepper { border-color: color-mix(in srgb, var(--ah-info) 45%, transparent); }
.ac-scale-reset {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0;
  border: none; border-radius: var(--ah-radius-sm); background: transparent; color: var(--ah-fg3); font: inherit; font-size: 15px; line-height: 1; cursor: pointer;
}
.ac-scale-reset:hover:not(:disabled) { background: var(--ah-hover); color: var(--ah-fg); }
/* Hidden at "follows", yet holding its column so the steppers stay aligned. */
.ac-scale-reset[hidden] { display: inline-flex; visibility: hidden; }
.ac-select option, .ac-select optgroup {
  color: var(--ah-fg); background: var(--ah-layer);
}
.ac-route-status { font-size: var(--ac-fs-body); line-height: 18px; }
.ac-switch {
  appearance: none; position: relative; flex: none; width: 36px; height: 20px; padding: 0; border: none; border-radius: 10px;
  background: color-mix(in srgb, currentColor 20%, transparent); cursor: pointer; transition: background-color 160ms ease;
}
.ac-switch[aria-checked="true"] { background: var(--ah-ok); }
.ac-thumb {
  position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .25); transition: transform 160ms var(--ah-ease);
}
.ac-switch[aria-checked="true"] .ac-thumb { transform: translateX(16px); }
.ac-switch:disabled { opacity: .5; cursor: default; }
.ac-switch:focus-visible, .ac-link:focus-visible {
  outline: 2px solid var(--ah-focus); outline-offset: 1px;
}
.ac-head {
  position: sticky; top: 0; z-index: 3; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  margin: 0 -4px; padding: 8px 4px; background: var(--ah-popup); border-bottom: 1px solid var(--ah-line);
}
.ac-head .ac-lead { flex: 1 1 200px; min-width: 0; }
.ac-head .ac-status { margin-right: auto; }
/* What waits for a restart, on 同步与更新: the reason, the queued upgrades, the restart itself. */
.ac-restart-banner {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px;
  background: color-mix(in srgb, var(--ah-warn) 12%, transparent); border: 1px solid color-mix(in srgb, var(--ah-warn) 30%, transparent);
}
.ac-restart-text { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
.ac-restart-text p { margin: 0; }
.ac-restart-banner .ah-btn { flex: none; }
.ac-updates-plugins { padding: 16px; }
.ac-status { flex: none; font-size: var(--ac-fs-body); color: var(--ah-fg2); white-space: nowrap; }
.ac-status[data-tone="saved"] { color: var(--ah-ok-ink); }
.ac-status[data-tone="failed"] { color: var(--ah-danger-ink); }
/* A quick autosave goes straight to "saved": "saving" shows only if it takes a while. */
.ac-status[data-tone="saving"], .ac-route-status { animation: ac-appear 400ms ease 400ms both; }
.ac-status[data-tone="saved"], .ac-status[data-tone="failed"] { animation: ac-appear 320ms ease both; }
@keyframes ac-appear { from { opacity: 0; } }
/* Model visibility */
.ac-bulk { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px; margin: 0 0 6px; font-size: var(--ac-fs-body); }
.ac-bulk > .ac-muted { margin-right: auto; font-variant-numeric: tabular-nums; }
.ac-hint.ac-warn { margin: 0 0 6px; color: var(--ah-warn-ink); }
.ac-checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); gap: 6px 16px; }
.ac-checks .ac-check-label { flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; }
.ac-checks .ac-check { min-height: 32px; box-sizing: border-box; }
@media (pointer: coarse) {
  .ac-checks .ac-check, .ac-bulk .ac-link { min-height: 44px; }
}
.ac-check { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 4px 0; font-size: var(--ac-fs-label); line-height: 20px; cursor: pointer; }
.ac-check[data-disabled] { cursor: default; }
.ac-check input { flex: none; margin: 0; transform: translateY(2px); accent-color: var(--ah-ok); cursor: inherit; }
.ac-check-label { flex: none; }
.ac-check-detail { min-width: 0; font-size: var(--ac-fs-meta); color: var(--ah-fg3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Cursor's models by billing: a tick-all head per section (a colored dot names the kind), its models under it. */
.ac-billing { display: flex; flex-direction: column; gap: 12px; }
.ac-billing-section { --ac-billing: var(--ah-ok); --ac-billing-ink: var(--ah-ok-ink); display: flex; flex-direction: column; gap: 4px; }
.ac-billing-section[data-billing="on-demand"] { --ac-billing: var(--ah-warn); --ac-billing-ink: var(--ah-warn-ink); }
.ac-billing-section + .ac-billing-section { padding-top: 12px; border-top: 1px solid var(--ah-line); }
.ac-billing-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; }
.ac-check.ac-billing-title { flex: none; padding: 2px 0; }
.ac-billing-name { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
.ac-billing-name::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--ac-billing); }
.ac-billing-count {
  padding: 0 6px; border-radius: var(--ah-radius-sm); font-size: var(--ac-fs-meta); line-height: 18px; font-variant-numeric: tabular-nums;
  color: var(--ac-billing-ink); background: color-mix(in srgb, var(--ac-billing) 12%, transparent);
}
.ac-billing-hint { flex: 1 1 200px; min-width: 0; font-size: var(--ac-fs-body); line-height: 18px; color: var(--ah-fg2); }
.ac-billing .ac-checks { padding-left: 22px; }
/* Blocked commands: commands read as code; the custom list sits above its add field. */
/* Exactly as typed: no ligature may turn -- into a dash. */
.ac-checks[data-mono] .ac-check-label, .ac-rule-text, .ac-rule-form .ac-input {
  font-family: var(--ah-mono); font-size: var(--ac-fs-body); font-variant-ligatures: none;
}
/* Command labels are long and must not overflow their cell: wider columns, capped at the row on narrow screens, and the label may wrap. */
.ac-checks[data-mono] { grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); }
.ac-checks[data-mono] .ac-check-label { flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; }
.ac-rules { display: flex; flex-direction: column; gap: 8px; }
.ac-row[data-wide] .ac-rules { display: flex; }
.ac-rule-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.ac-rule {
  display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 2px 4px 2px 10px; border-radius: var(--ah-radius);
  background: color-mix(in srgb, currentColor 5%, transparent);
}
.ac-rule-text { flex: 1; min-width: 0; line-height: 18px; overflow-wrap: anywhere; }
.ac-rule-remove {
  appearance: none; flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  padding: 0; border: none; border-radius: var(--ah-radius-sm); background: transparent; color: var(--ah-fg3); font: inherit; font-size: 16px; line-height: 1;
  cursor: pointer; transition: background-color 120ms ease, color 120ms ease;
}
.ac-rule-remove:hover:not(:disabled) { color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 10%, transparent); }
.ac-rule-remove:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; color: var(--ah-fg); }
.ac-rule-remove:disabled { cursor: default; opacity: .4; }
.ac-rule-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ac-rule-form .ac-input { flex: 1 1 220px; }
.ac-rule-form .ah-btn { flex: none; white-space: nowrap; }
.ac-rule-problem { flex-basis: 100%; margin: 0; }

/* 不参与同步: the listed keys as chips, then the entries and settings to tick, as a tree. */
.ac-exclude { container: ac-exclude / inline-size; }
.ac-row[data-wide] .ac-exclude-control { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.ac-exclude-control > .ac-notice { align-self: stretch; }
.ac-exclude-none { margin: 0; font-size: var(--ac-fs-body); }
.ac-exclude-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.ac-exclude-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-height: 28px; padding: 0 0 0 10px; border-radius: 999px;
  border: 1px solid var(--ah-line); background: color-mix(in srgb, currentColor 5%, transparent); font-size: var(--ac-fs-body); line-height: 18px;
}
.ac-exclude-chip code { font-family: var(--ah-mono); min-width: 0; overflow-wrap: anywhere; }
.ac-exclude-chip-path { color: var(--ah-fg2); }
.ac-exclude-chip[data-stale] { border-style: dashed; color: var(--ah-fg3); }
.ac-exclude-chip .ac-rule-remove { width: 26px; height: 26px; border-radius: 999px; }
.ac-exclude-picker { align-self: stretch; border: 1px solid var(--ah-line); border-radius: var(--ah-radius); overflow: hidden; }
.ac-exclude-search { position: relative; display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--ah-line); background: color-mix(in srgb, currentColor 3%, transparent); }
.ac-exclude-search > svg { position: absolute; left: 18px; color: var(--ah-fg3); pointer-events: none; }
.ac-exclude-search .ac-input { flex: 1; padding-left: 30px; }
.ac-exclude-count { flex: none; font-size: var(--ac-fs-body); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ac-exclude-empty { margin: 0; padding: 16px; font-size: var(--ac-fs-body); text-align: center; }
.ac-exclude-tree { max-height: min(60vh, 420px); margin: 0; padding: 4px 0; overflow: auto; overscroll-behavior: contain; list-style: none; }
.ac-exclude-tree ul { margin: 0; padding: 0 0 0 22px; list-style: none; }
.ac-exclude-node {
  display: grid; grid-template-columns: 24px 16px minmax(0, 1fr) auto; align-items: center; gap: 8px;
  min-height: 34px; padding: 0 12px 0 6px; font-size: var(--ac-fs-body); line-height: 18px;
}
.ac-exclude-node:hover { background: var(--ah-hover); }
.ac-exclude-node[data-implied] { color: var(--ah-fg3); }
.ac-exclude-node input { margin: 0; accent-color: var(--ah-accent); cursor: pointer; }
.ac-exclude-node input:disabled { cursor: default; }
.ac-exclude-twist {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0;
  border: none; border-radius: var(--ah-radius-sm); background: transparent; color: var(--ah-fg3); cursor: pointer;
}
.ac-exclude-twist:hover { color: var(--ah-fg); background: color-mix(in srgb, currentColor 8%, transparent); }
.ac-exclude-twist:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.ac-exclude-twist svg { transition: transform 160ms var(--ah-ease); }
.ac-exclude-twist[aria-expanded="true"] svg { transform: rotate(90deg); }
.ac-exclude-name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0; cursor: pointer; }
.ac-exclude-node[data-implied] .ac-exclude-name { cursor: default; }
.ac-exclude-name code { font-family: var(--ah-mono); overflow-wrap: anywhere; }
.ac-exclude-name .ac-tag { font-size: var(--ac-fs-meta); white-space: nowrap; }
.ac-exclude-package { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--ac-fs-meta); color: var(--ah-fg3); }
.ac-exclude-value { max-width: 28ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--ah-mono); color: var(--ah-fg3); }
@container ac-exclude (max-width: 520px) {
  .ac-exclude-value, .ac-exclude-package { display: none; }
  .ac-exclude-toggle { align-self: stretch; justify-content: center; min-height: 44px; }
  .ac-exclude-search .ac-input { min-height: 40px; }
}
@media (pointer: coarse) {
  .ac-exclude-node { min-height: 44px; }
  .ac-exclude-twist, .ac-exclude-chip .ac-rule-remove { width: 36px; height: 36px; }
  .ac-exclude-node input { width: 20px; height: 20px; }
  .ac-exclude-node { grid-template-columns: 36px 20px minmax(0, 1fr) auto; }
}
@media (prefers-reduced-motion: reduce) { .ac-exclude-twist svg { transition: none; } }

.ac-ident { gap: 10px; padding-left: 6px; }
.ac-ident-avatar {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%;
  background: color-mix(in srgb, var(--ah-accent) 18%, transparent); color: var(--ah-accent); font-size: var(--ac-fs-body); font-weight: 700;
}
.ac-ident-text { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 4px 0; }
.ac-ident-name { font-size: var(--ac-fs-label); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-ident-email { color: var(--ah-fg3); font-family: var(--ah-mono); font-size: var(--ac-fs-body); overflow-wrap: anywhere; }
.ac-ident-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
.ac-ident-input { flex: 1 1 160px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ac-ident-label { font-size: var(--ac-fs-body); color: var(--ah-fg2); }
.ac-ident-form .ah-btn { white-space: nowrap; }
@media (max-width: 560px) { .ac-ident-form .ah-btn { flex: 1 1 100%; } }
.ac-efforts { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 6px 16px; }
.ac-effort { display: flex; align-items: center; gap: 10px; min-width: 0; font-size: var(--ac-fs-label); line-height: 20px; }
.ac-effort-name { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; overflow: hidden; }
.ac-effort .ac-select { flex: none; width: auto; max-width: 60%; padding-top: 3px; padding-bottom: 3px; }
/* Composer shortcuts: the key shown as keycaps; the field itself is the recorder. */
.ac-shortcut { align-items: center; gap: 12px; }
.ac-keys { width: auto; min-width: 120px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer; font-size: var(--ac-fs-body); }
.ac-keys[data-recording] { border-color: var(--ah-focus); color: var(--ah-fg2); }
.ac-keys kbd { font: inherit; padding: 0 5px; border-radius: 4px; background: color-mix(in srgb, currentColor 10%, transparent); }
/* Team members */
.ac-agents { display: flex; flex-direction: column; gap: 8px; padding: 14px 0; }
.ac-agents-empty { display: flex; flex-direction: column; gap: 10px; font-size: var(--ac-fs-body); color: var(--ah-fg2); }
.ac-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.ac-chip {
  appearance: none; display: inline-flex; align-items: baseline; gap: 6px; padding: 6px 12px; border-radius: 16px; cursor: pointer;
  border: 1px dashed color-mix(in srgb, currentColor 28%, transparent); background: transparent; color: inherit; font: inherit; font-size: var(--ac-fs-body);
  transition: background-color 120ms ease, border-color 120ms ease;
}
.ac-chip:hover:not(:disabled) { background: color-mix(in srgb, currentColor 7%, transparent); border-style: solid; }
.ac-chip-id { font-family: var(--ah-mono); font-size: var(--ac-fs-meta); color: var(--ah-fg3); }
.ac-agent {
  border-radius: var(--ah-radius); border: 1px solid var(--ah-line);
  background: color-mix(in srgb, currentColor 2%, transparent); transition: border-color 120ms ease;
}
.ac-agent[data-open] { border-color: color-mix(in srgb, currentColor 20%, transparent); }
.ac-agent[data-invalid] { border-color: color-mix(in srgb, var(--ah-danger) 60%, transparent); }
.ac-agent-head {
  appearance: none; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 48px; padding: 8px 12px; border: none; border-radius: var(--ah-radius);
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.ac-agent-head:hover { background: color-mix(in srgb, currentColor 4%, transparent); }
.ac-agent-head:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; }
.ac-avatar {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%;
  color: #fff; font-size: var(--ac-fs-label); font-weight: 600;
}
.ac-agent-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ac-agent-name { font-size: var(--ac-fs-label); font-weight: 600; line-height: 18px; font-family: var(--ah-mono); }
.ac-agent-desc { font-size: var(--ac-fs-body); line-height: 17px; color: var(--ah-fg2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-agent-model {
  flex: none; max-width: 40%; padding: 2px 8px; border-radius: 10px; font-size: var(--ac-fs-meta); line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: color-mix(in srgb, currentColor 8%, transparent); color: var(--ah-fg2);
}
.ac-agent-chevron { flex: none; width: 12px; text-align: center; color: var(--ah-fg3); transition: transform 160ms var(--ah-ease); }
.ac-agent[data-open] .ac-agent-chevron { transform: rotate(90deg); }
.ac-agent-body {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px 16px; padding: 4px 12px 12px 50px;
}
.ac-agent-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ac-agent-wide { grid-column: 1 / -1; }
.ac-agent-foot { grid-column: 1 / -1; display: flex; justify-content: flex-end; }
.ac-danger { color: var(--ah-danger-ink); }
.ac-agents-add { align-self: flex-start; }
/* Connectors */
.ac-conns { display: flex; flex-direction: column; gap: 8px; padding: 14px 0; container-type: inline-size; }
.ac-conn-head { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 8px 12px; }
.ac-conn-name { display: inline-flex; align-items: baseline; gap: 8px; font-size: var(--ac-fs-label); font-weight: 600; line-height: 18px; }
.ac-conn-state {
  display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--ac-fs-body); line-height: 17px; color: var(--ah-fg2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ac-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--ah-fg3); }
.ac-conn[data-tone="ok"] .ac-dot { background: var(--ah-ok); }
.ac-conn[data-tone="bad"] .ac-dot { background: var(--ah-danger); }
.ac-conn[data-tone="bad"] .ac-conn-state { color: var(--ah-fg); }
.ac-conn[data-tone="busy"] .ac-dot { background: var(--ah-warn); animation: ac-pulse 2.4s ease-in-out infinite; }
@keyframes ac-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
.ac-conn-actions { flex: none; display: flex; align-items: center; gap: 10px; }
.ac-conn-actions .ac-link { font-size: var(--ac-fs-body); }
.ac-conn-actions .ah-btn, .ac-conn-actions .ac-link, .ac-conn-form .ah-btn { white-space: nowrap; }
.ac-conn-remove { color: var(--ah-fg2); }
.ac-conn-remove:hover:not(:disabled) { color: var(--ah-danger-ink); }
.ac-conn-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 12px 12px 50px; }
.ac-conns > .ac-conn-form { padding: 0; }
.ac-conn-form .ac-input { flex: 1 1 240px; }
.ac-conn-form-hint { flex-basis: 100%; margin: 0; }
/* A Linear account's repositories */
.ac-conn-repos { margin: 0 12px 10px 50px; border-top: 1px solid var(--ah-line); }
.ac-conn-repos-head {
  appearance: none; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 36px; padding: 6px 0; border: none;
  background: transparent; color: inherit; font: inherit; font-size: var(--ac-fs-body); text-align: left; cursor: pointer;
}
.ac-conn-repos-head:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; border-radius: var(--ah-radius-sm); }
.ac-conn-repos-label { flex: none; color: var(--ah-fg2); }
.ac-conn-repos-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-conn-repos[data-open] .ac-agent-chevron { transform: rotate(90deg); }
.ac-conn-repos-body { display: flex; flex-direction: column; gap: 6px; padding-bottom: 6px; }
.ac-conn-repos-body .ac-hint { margin: 0; }
.ac-conn-site { display: flex; align-items: center; gap: 10px; font-size: var(--ac-fs-label); }
.ac-conn-site .ac-select { width: auto; }
/* Cardputer: devices, pairing, what this computer still needs. */
.ac-dev { gap: 12px; container: ac-dev / inline-size; }
.ac-dev p { margin: 0; }
.ac-dev-list { padding: 0; }
.ac-dev-avatar { display: inline-flex; align-items: center; justify-content: center; color: var(--ah-fg2); background: color-mix(in srgb, currentColor 8%, transparent); }
.ac-conn-remove[data-confirm] { color: var(--ah-danger-ink); border-color: color-mix(in srgb, var(--ah-danger) 45%, transparent); }
.ac-hotkey { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ac-hotkey .ac-hint { flex-basis: 100%; margin: 0; }
.ac-hotkey-input { width: 14em; font-family: var(--ah-mono, ui-monospace, monospace); }
.ac-kbd { padding: 2px 8px; border: 1px solid var(--ah-line); border-bottom-width: 2px; border-radius: 6px; font: 12px/18px var(--ah-mono, ui-monospace, monospace); background: color-mix(in srgb, currentColor 6%, transparent); }
.ac-dev-add { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.ac-dev-pair {
  display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-radius: var(--ah-radius-lg);
  border: 1px solid var(--ah-line-strong); background: color-mix(in srgb, currentColor 3%, transparent);
}
.ac-dev-pair[data-tone="bad"] { border-color: color-mix(in srgb, var(--ah-danger) 40%, transparent); }
.ac-dev-steps { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0; padding: 0; list-style: none; counter-reset: ac-dev; font-size: var(--ac-fs-body); line-height: 18px; color: var(--ah-fg3); }
.ac-dev-steps li { counter-increment: ac-dev; display: inline-flex; align-items: center; gap: 6px; }
.ac-dev-steps li::before {
  content: counter(ac-dev); flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
  border-radius: 50%; border: 1px solid currentColor; font-size: var(--ac-fs-meta); font-variant-numeric: tabular-nums;
}
.ac-dev-steps li[data-current] { color: var(--ah-fg); font-weight: 600; }
.ac-dev-steps li[data-done] { color: var(--ah-ok-ink); }
.ac-dev-steps li[data-done]::before { content: '✓'; }
.ac-dev-code {
  font-family: var(--ah-mono); font-size: 32px; line-height: 40px; font-weight: 600; letter-spacing: .08em;
  font-variant-numeric: tabular-nums; user-select: all;
}
.ac-dev-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ac-dev-actions .ah-btn { white-space: nowrap; min-height: 36px; }
.ac-dev-rename { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; }
.ac-dev-rename .ac-input { flex: 1 1 160px; }
.ac-dev .ac-notice[data-tone="bad"] { color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 8%, transparent); }
.ac-dev .ac-notice[data-tone="ok"] { color: var(--ah-ok-ink); background: color-mix(in srgb, var(--ah-ok) 8%, transparent); }
.ac-dev-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ac-dev-notice .ah-btn { flex: none; white-space: nowrap; }
.ac-dev-key { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 6px 10px; }
.ac-dev-key .ac-hint { grid-column: 1 / -1; margin: 0; }
@container ac-dev (max-width: 520px) {
  .ac-dev .ac-conn-head { flex-wrap: wrap; }
  .ac-dev .ac-conn-actions { width: 100%; justify-content: flex-end; }
  .ac-dev-actions .ah-btn, .ac-dev-add .ah-btn { flex: 1; min-height: 44px; }
  .ac-dev-add { align-items: stretch; }
  .ac-dev-key { grid-template-columns: 1fr; }
  .ac-dev-key .ac-input { min-height: 40px; }
  .ac-dev-notice { flex-direction: column; align-items: stretch; }
  .ac-dev-code { font-size: 28px; }
}
/* Bot advanced options */
.ac-agent-more > summary {
  display: inline-flex; align-items: center; gap: 6px; min-height: 28px; font-size: var(--ac-fs-body); color: var(--ah-fg2); cursor: pointer; list-style: none; user-select: none;
}
.ac-agent-more > summary::-webkit-details-marker { display: none; }
.ac-agent-more > summary::before { content: '›'; display: inline-block; width: 10px; text-align: center; transition: transform 160ms var(--ah-ease); }
.ac-agent-more[open] > summary::before { transform: rotate(90deg); }
.ac-agent-more > summary:hover { color: var(--ah-fg); }
.ac-agent-more[open] > summary { margin-bottom: 8px; }
/* The page may sit in a narrow column (settings dialog, small window): lay cards out by their own width. */
@container (max-width: 440px) {
  .ac-conn-head { flex-wrap: wrap; }
  .ac-conn-head .ac-agent-text { flex: 1 1 calc(100% - 40px); }
  .ac-conn-actions { flex: 1 1 100%; flex-wrap: wrap; justify-content: flex-end; }
  .ac-conn-form { padding-left: 12px; }
  .ac-conn-repos { margin-left: 12px; }
  .ac-conn-form .ah-btn { flex: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .ac-group-chevron, .ac-switch, .ac-thumb, .ac-input, .ac-chip, .ac-rule-remove, .ac-agent, .ac-agent-chevron, .ac-agent-more > summary::before, .ac-stepper-step { transition: none; }
  .ac-conn[data-tone="busy"] .ac-dot, .ac-status, .ac-route-status { animation: none; }
}
@media (max-width: 560px) {
  .ac-group-toggle { flex-wrap: wrap; row-gap: 2px; }
  .ac-group-summary { flex-basis: calc(100% - 20px); margin-left: 20px; text-align: left; white-space: normal; }
  .ac-conn-actions .ah-btn, .ac-conn-form .ah-btn { min-height: 36px; }
  .ac-agent-body { padding-left: 12px; }
  .ac-agent-model { max-width: 34%; }
  .ac-row { flex-direction: column; align-items: stretch; gap: 8px; }
  .ac-input[data-numeric] { width: 100%; text-align: left; }
  .ac-control { justify-content: flex-start; }
  .ac-scale-main { flex-direction: column; align-items: stretch; gap: 8px; }
  .ac-stepper { grid-template-columns: 44px minmax(72px, auto) 44px; min-height: 44px; align-self: flex-start; }
  .ac-stepper[data-compact] { grid-template-columns: 44px 88px 44px; min-height: 44px; justify-self: start; }
  .ac-stepper-step { min-width: 44px; }
  .ac-scale-toggle { min-height: 44px; }
  .ac-scale-region { grid-template-columns: minmax(0, 1fr) 44px; }
  .ac-scale-region-text { grid-column: 1 / -1; }
  .ac-scale-reset, .ac-scale-reset[hidden] { width: 44px; height: 44px; }
  /* Touch: full-size targets, and the add button takes its own row under the field. */
  .ac-rule { min-height: 40px; }
  .ac-rule-remove { width: 36px; height: 36px; }
  .ac-rule-form .ac-input { flex-basis: 100%; min-height: 36px; }
  .ac-rule-form .ah-btn { flex: 1; min-height: 36px; }
  .ac-billing .ac-checks { padding-left: 0; }
  .ac-billing .ac-check { min-height: 36px; align-items: center; }
  .ac-billing .ac-check input { transform: none; }
}
`

export function injectConfigStyle(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.config'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}
