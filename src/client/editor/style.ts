/**
 * Code editor and search stylesheet (`ce-`, `cs-`, `tok-`), on the shared
 * tokens and controls of theme/base.ts; syntax colors follow GitHub's
 * light and dark palettes, switched by the body's dark-theme attribute, so a
 * theme change needs no script. Narrow sidebars drop secondary chrome with
 * container queries; touch screens get larger targets.
 */

const CSS = `
.ce-root, .ce-editor, .cs-root {
  --ce-caret: var(--ah-accent);
  --ce-selection: color-mix(in srgb, var(--ah-accent) 22%, transparent);
  --ce-active-line: color-mix(in srgb, currentColor 3.5%, transparent);
  --ce-match: color-mix(in srgb, #f2b600 30%, transparent);
  --ce-match-strong: color-mix(in srgb, #f28b00 48%, transparent);
  --ce-match-line: color-mix(in srgb, #f2a100 55%, transparent);
  --ce-match-soft: color-mix(in srgb, var(--ah-accent) 12%, transparent);
  --ce-bracket: color-mix(in srgb, var(--ah-accent) 14%, transparent);
  --ce-bracket-line: color-mix(in srgb, var(--ah-accent) 45%, transparent);
}

.ce-root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; flex: auto; color: var(--ah-fg); }
.ce-editor {
  position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; flex: auto;
  container-type: inline-size; container-name: ce; font-size: var(--dsh-content-font-size-secondary, 13px);
}
:where(.ce-editor, .cs-root) button { font: inherit; color: inherit; }

.ce-state {
  flex: auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  padding: 24px; color: var(--ah-fg3); text-align: center; animation: ce-fade-in 240ms 160ms both;
}
.ce-state p { margin: 0; max-width: 34em; }
.ce-state[role="alert"] { color: var(--ah-fg2); }
.ce-state-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
@keyframes ce-fade-in { from { opacity: 0; } }
.ce-spinner {
  width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--ah-line-strong); border-top-color: var(--ah-fg2);
  animation: ce-spin 900ms linear infinite;
}
@keyframes ce-spin { to { transform: rotate(360deg); } }

/* Header: the path, then the actions. */
.ce-head { flex: none; display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 4px 0 12px; border-bottom: .5px solid var(--ah-line); }
.ce-path { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; overflow: hidden; white-space: nowrap; font-size: 12px; }
/* A long folder keeps its end: clipped on the left (rtl box, the text itself isolated ltr). */
.ce-dir { color: var(--ah-fg3); overflow: hidden; text-overflow: ellipsis; min-width: 0; direction: rtl; }
.ce-name { color: var(--ah-fg); flex: none; font-weight: 500; }
.ce-dot, .ce-title-dot { flex: none; width: 7px; height: 7px; margin-left: 7px; border-radius: 50%; background: var(--ah-fg2); }
.ce-title-dot { display: inline-block; margin-left: 6px; vertical-align: middle; }
.ce-title-icon { flex: none; }
.ce-actions { flex: none; display: flex; align-items: center; gap: 1px; }
.ce-editor .ah-icon-btn[data-busy] { animation: ce-pulse 900ms ease-in-out infinite alternate; }
@keyframes ce-pulse { to { opacity: .4; } }
.cs-root button:focus-visible, .cs-input:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
@container ce (max-width: 380px) {
  .ah-icon-btn[data-wide] { display: none; }
  .ce-wide { display: none; }
}

.ce-link { border: 0; padding: 0 2px; background: none; color: var(--ah-accent); cursor: pointer; font-size: 12px; white-space: nowrap; }
.ce-link:hover { text-decoration: underline; }

/* Notice bars. */
.ce-bar {
  flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; padding: 7px 10px 7px 12px;
  border-bottom: .5px solid var(--ah-line); font-size: 12px; line-height: 1.4;
  background: color-mix(in srgb, var(--ce-bar) 9%, transparent); box-shadow: inset 2px 0 0 var(--ce-bar);
  animation: ce-bar-in 180ms var(--ah-ease);
}
.ce-bar[data-kind="info"] { --ce-bar: var(--ah-info); }
.ce-bar[data-kind="warn"] { --ce-bar: var(--ah-warn); }
.ce-bar[data-kind="error"] { --ce-bar: var(--ah-del); }
.ce-bar-text { flex: 1 1 14em; min-width: 0; color: var(--ah-fg); }
.ce-bar-actions { display: flex; flex-wrap: wrap; gap: 6px; }
@keyframes ce-bar-in { from { opacity: 0; transform: translateY(-4px); } }

/* The editor. */
.ce-cm { flex: 1 1 auto; min-height: 0; position: relative; }
.ce-cm > .cm-editor { position: absolute; inset: 0; }

/* Change markers against HEAD, right of the line numbers. */
.ce-changes-gutter { width: 5px; }
.ce-changes-gutter .cm-gutterElement { position: relative; }
.ce-change { position: absolute; left: 1px; top: 0; bottom: 0; width: 3px; border-radius: 1px; }
.ce-change-added { background: var(--ah-add); }
.ce-change-modified { background: var(--ah-mod); }
.ce-change-deleted { top: auto; bottom: auto; width: 0; height: 0; left: 0; margin-top: -4px; border: 4px solid transparent; border-left: 5px solid var(--ah-del); border-radius: 0; }
.ce-def-link { text-decoration: underline; text-decoration-color: var(--ah-accent); text-underline-offset: 2px; cursor: pointer; }
.ce-flash { animation: ce-flash 1200ms ease-out; }
@keyframes ce-flash { from { background-color: color-mix(in srgb, var(--ah-accent) 22%, transparent); } }

/* Search and go-to-line panels, compact. */
.ce-cm .cm-panel.cm-search { position: relative; padding: 4px 34px 4px 8px; font-size: 12px; line-height: 30px; }
.ce-cm .cm-panel.cm-search > * { margin: 0 6px 0 0; vertical-align: middle; }
.ce-cm .cm-panel input[type="checkbox"] { margin: 0 3px 0 0; vertical-align: middle; accent-color: var(--ah-accent); }
.ce-cm .cm-panel label { display: inline-flex; align-items: center; color: var(--ah-fg2); font-size: 12px; white-space: nowrap; }
.ce-cm .cm-textfield {
  height: 24px; width: 13em; max-width: calc(100% - 12px); padding: 0 7px; border: .5px solid var(--ah-line-strong); border-radius: var(--ah-radius-sm);
  background: var(--dsw-specific-input-major-bg, transparent); color: var(--ah-fg); font: inherit; font-size: 12px; box-sizing: border-box;
}
.ce-cm .cm-textfield:focus { outline: none; border-color: var(--ah-accent); }
.ce-cm .cm-button {
  height: 24px; padding: 0 8px; margin: 0; border: .5px solid var(--ah-line-strong); border-radius: var(--ah-radius-sm);
  background: transparent; background-image: none; color: var(--ah-fg); font: inherit; font-size: 12px; cursor: pointer;
}
.ce-cm .cm-button:hover { background: var(--ah-hover); }
.ce-cm .cm-panel.cm-search [name="close"] { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: var(--ah-radius-sm); color: var(--ah-fg2); font-size: 16px; line-height: 1; }
.ce-cm .cm-panel.cm-search [name="close"]:hover { background: var(--ah-hover); }
.ce-cm .cm-panel.cm-gotoLine { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 12px; }

/* Unified diff against the disk version (conflicts). */
.ce-cm .cm-changedLine { background: color-mix(in srgb, var(--ah-add) 10%, transparent) !important; }
.ce-cm .cm-changedText { background: color-mix(in srgb, var(--ah-add) 26%, transparent) !important; }
.ce-cm .cm-deletedChunk { background: color-mix(in srgb, var(--ah-del) 9%, transparent); padding: 1px 0; }
.ce-cm .cm-deletedChunk del { text-decoration: none; background: color-mix(in srgb, var(--ah-del) 24%, transparent); }
.ce-cm .cm-deletedChunk .cm-chunkButtons { position: absolute; right: 12px; display: flex; gap: 4px; }
.ce-cm .cm-deletedChunk .cm-chunkButtons button {
  height: 20px; padding: 0 7px; border: .5px solid var(--ah-line-strong); border-radius: 4px; background: var(--ah-bg); font-size: 11px; cursor: pointer;
}
.ce-cm .cm-changeGutter { width: 3px; }
.ce-cm .cm-changedLineGutter { background: var(--ah-add); }

/* Status line. */
.ce-status {
  flex: none; display: flex; align-items: center; gap: 12px; height: 22px; padding: 0 12px; border-top: .5px solid var(--ah-line);
  color: var(--ah-fg3); font-size: 11px; white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums;
}
.ce-grow { flex: 1 1 auto; }
.ce-muted { color: var(--ah-warn-ink); overflow: hidden; text-overflow: ellipsis; }

/* Touch: the selection's actions where the thumb is. */
.ce-touchbar {
  position: absolute; left: 50%; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); z-index: 4;
  display: flex; gap: 2px; padding: 3px; border-radius: 12px; background: var(--ah-popup); box-shadow: var(--ah-shadow), 0 0 0 .5px var(--ah-line);
  animation: ce-touch-in 160ms var(--ah-ease);
}
.ce-touchbar button { height: 38px; padding: 0 12px; border: 0; border-radius: 9px; background: transparent; font-size: 13px; white-space: nowrap; }
.ce-touchbar button:active { background: var(--ah-hover); }
@keyframes ce-touch-in { from { opacity: 0; transform: translate(-50%, 6px); } }
.ce-editor[data-coarse] .ce-head { height: 40px; }
.ce-editor[data-coarse] .ah-icon-btn { width: 38px; height: 38px; }
.ce-editor[data-coarse] .ce-path { font-size: 13px; }
.ce-editor[data-coarse] .ah-btn-sm { height: 34px; padding: 0 12px; font-size: 13px; }
.ce-editor[data-coarse] .cm-textfield, .ce-editor[data-coarse] .cm-button { height: 32px; font-size: 16px; }

.ce-toast {
  position: absolute; left: 50%; bottom: 34px; transform: translateX(-50%); z-index: 5; max-width: calc(100% - 24px);
  display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-radius: 8px; font-size: 12px;
  background: var(--ah-popup); box-shadow: var(--ah-shadow), 0 0 0 .5px var(--ah-line), inset 3px 0 0 var(--ah-add);
  animation: ce-touch-in 180ms var(--ah-ease);
}
.ce-toast[data-kind="error"] { box-shadow: var(--ah-shadow), 0 0 0 .5px var(--ah-line), inset 3px 0 0 var(--ah-del); }
.ce-toast-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ce-editor[data-coarse] .ce-toast { bottom: calc(64px + env(safe-area-inset-bottom, 0px)); font-size: 13px; }

/* The 编辑 button in DSH's preview header. */
.ce-preview-edit {
  flex: none; display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; margin-left: 4px;
  border: 0; border-radius: var(--ah-radius-sm); background: transparent; color: var(--ah-fg2);
  font: inherit; font-size: 12px; cursor: pointer; transition: background-color 120ms ease, color 120ms ease;
}
.ce-preview-edit:hover { background: var(--ah-hover); color: var(--ah-fg); }
.ce-preview-edit:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
@media (pointer: coarse) { .ce-preview-edit { height: 34px; padding: 0 10px; font-size: 13px; } }

/* Syntax: GitHub light, then dark. */
.ce-cm .tok-keyword { color: #cf222e; }
.ce-cm .tok-string { color: #0a3069; }
.ce-cm .tok-string2 { color: #116329; }
.ce-cm .tok-number { color: #0550ae; }
.ce-cm .tok-comment { color: #6e7781; font-style: italic; }
.ce-cm .tok-type { color: #953800; }
.ce-cm .tok-function { color: #8250df; }
.ce-cm .tok-def { color: #953800; }
.ce-cm .tok-property { color: #0550ae; }
.ce-cm .tok-tag { color: #116329; }
.ce-cm .tok-attr { color: #0550ae; }
.ce-cm .tok-meta { color: #8250df; }
.ce-cm .tok-heading { color: #0550ae; font-weight: 600; }
.ce-cm .tok-link { color: #0a3069; text-decoration: underline; }
.ce-cm .tok-em { font-style: italic; }
.ce-cm .tok-strong { font-weight: 600; }
.ce-cm .tok-inserted { color: #116329; background: #dafbe1; }
.ce-cm .tok-deleted { color: #82071e; background: #ffebe9; }
.ce-cm .tok-invalid { color: #82071e; }
.ce-cm .tok-special { color: #953800; }
body[data-ds-dark-theme] .ce-cm .tok-keyword { color: #ff7b72; }
body[data-ds-dark-theme] .ce-cm .tok-string { color: #a5d6ff; }
body[data-ds-dark-theme] .ce-cm .tok-string2 { color: #7ee787; }
body[data-ds-dark-theme] .ce-cm .tok-number { color: #79c0ff; }
body[data-ds-dark-theme] .ce-cm .tok-comment { color: #8b949e; }
body[data-ds-dark-theme] .ce-cm .tok-type { color: #ffa657; }
body[data-ds-dark-theme] .ce-cm .tok-function { color: #d2a8ff; }
body[data-ds-dark-theme] .ce-cm .tok-def { color: #ffa657; }
body[data-ds-dark-theme] .ce-cm .tok-property { color: #79c0ff; }
body[data-ds-dark-theme] .ce-cm .tok-tag { color: #7ee787; }
body[data-ds-dark-theme] .ce-cm .tok-attr { color: #79c0ff; }
body[data-ds-dark-theme] .ce-cm .tok-meta { color: #d2a8ff; }
body[data-ds-dark-theme] .ce-cm .tok-heading { color: #79c0ff; }
body[data-ds-dark-theme] .ce-cm .tok-link { color: #a5d6ff; }
body[data-ds-dark-theme] .ce-cm .tok-inserted { color: #aff5b4; background: #033a16; }
body[data-ds-dark-theme] .ce-cm .tok-deleted { color: #ffdcd7; background: #67060c; }
body[data-ds-dark-theme] .ce-cm .tok-invalid { color: #ffa198; }
body[data-ds-dark-theme] .ce-cm .tok-special { color: #ffa657; }
body[data-ds-dark-theme] .ce-root, body[data-ds-dark-theme] .cs-root { --ce-active-line: color-mix(in srgb, currentColor 4.5%, transparent); --ce-selection: color-mix(in srgb, var(--ah-accent) 34%, transparent); }

/* Search tab. */
.cs-root {
  position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; flex: auto;
  color: var(--ah-fg); font-size: var(--dsh-content-font-size-secondary, 13px);
}
.cs-form { flex: none; position: relative; display: flex; flex-direction: column; gap: 6px; padding: 10px 10px 6px; }
.cs-refs { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--ah-fg2); font-size: 12px; }
.cs-row { display: flex; align-items: center; gap: 4px; }
.cs-box {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 1px; padding-right: 3px; height: 30px;
  border: .5px solid var(--ah-line-strong); border-radius: var(--ah-radius-sm); background: var(--dsw-specific-input-major-bg, transparent);
  transition: border-color 120ms ease;
}
.cs-box:focus-within { border-color: var(--ah-accent); }
.cs-input {
  flex: 1 1 auto; min-width: 0; height: 28px; padding: 0 9px; border: 0; background: transparent; color: var(--ah-fg); font: inherit; font-size: 13px; outline: none;
}
.cs-input::-webkit-search-cancel-button { display: none; }
.cs-filter .cs-input { height: 28px; border: .5px solid var(--ah-line-strong); border-radius: var(--ah-radius-sm); background: var(--dsw-specific-input-major-bg, transparent); }
.cs-filter .cs-input:focus { border-color: var(--ah-accent); }
.cs-toggle {
  flex: none; width: 24px; height: 22px; padding: 0; border: .5px solid transparent; border-radius: 4px; background: transparent;
  color: var(--ah-fg3); font-family: var(--ah-mono); font-size: 12px; cursor: pointer; transition: background-color 120ms ease, color 120ms ease;
}
.cs-toggle:hover { background: var(--ah-hover); color: var(--ah-fg); }
.cs-toggle[aria-pressed="true"] { color: var(--ah-accent); background: color-mix(in srgb, var(--ah-accent) 12%, transparent); border-color: color-mix(in srgb, var(--ah-accent) 45%, transparent); }
.cs-filters { display: flex; flex-direction: column; gap: 6px; animation: ce-bar-in 160ms var(--ah-ease); }
.cs-filter { display: flex; flex-direction: column; gap: 3px; }
.cs-filter > span { color: var(--ah-fg3); font-size: 11px; }
.cs-summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 18px; color: var(--ah-fg3); font-size: 12px; }
.cs-summary-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cs-error { color: var(--ah-danger-ink); }
.cs-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 1.5px; overflow: hidden; }
.cs-progress::after {
  content: ""; position: absolute; top: 0; bottom: 0; width: 30%; background: var(--ah-accent); opacity: .7;
  animation: cs-progress 1100ms var(--ah-ease) infinite;
}
@keyframes cs-progress { from { left: -30%; } to { left: 100%; } }
.cs-empty { margin: 0; padding: 16px 14px; color: var(--ah-fg3); font-size: 12px; line-height: 1.6; }
.cs-list { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; outline: none; padding-bottom: 12px; }
.cs-file, .cs-match {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 0 10px; border: 0; background: transparent;
  text-align: left; cursor: pointer; white-space: nowrap; overflow: hidden;
}
.cs-file:hover, .cs-match:hover { background: var(--ah-hover); }
.cs-chevron { flex: none; color: var(--ah-fg3); transition: transform 140ms var(--ah-ease); }
.cs-chevron[data-open] { transform: rotate(90deg); }
.cs-file-name { flex: none; font-weight: 500; }
.cs-file-dir { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ah-fg3); font-size: 12px; direction: rtl; text-align: left; }
.cs-count { flex: none; min-width: 18px; height: 16px; padding: 0 5px; border-radius: 8px; background: var(--ah-hover); color: var(--ah-fg2); font-size: 11px; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; }
.cs-match { padding-left: 28px; font-family: var(--ah-mono); font-size: 12px; }
.cs-line { flex: none; min-width: 2.5em; color: var(--ah-fg3); text-align: right; font-variant-numeric: tabular-nums; font-size: 11px; }
.cs-preview { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ah-fg2); }
.cs-preview mark { background: var(--ce-match); color: var(--ah-fg); border-radius: 2px; box-shadow: 0 0 0 .5px var(--ce-match-line); }
.cs-root[data-coarse] .cs-box, .cs-root[data-coarse] .cs-filter .cs-input { height: 40px; }
.cs-root[data-coarse] .cs-input { font-size: 16px; height: 38px; }
.cs-root[data-coarse] .cs-toggle { width: 34px; height: 32px; font-size: 13px; }
.cs-root[data-coarse] .cs-match { font-size: 13px; }

@media (prefers-reduced-motion: reduce) {
  .ce-state, .ce-bar, .ce-touchbar, .ce-toast, .cs-filters, .ce-flash, .ce-spinner, .cs-progress::after, .ce-editor .ah-icon-btn[data-busy] { animation: none !important; }
  .cs-chevron { transition: none; }
}

/* DSH's Files tree: the row a menu is open for, as if hovered. */
[data-ah-files-target] > button { background: var(--ah-hover); }
/* A row just created: a short accent wash that fades out. */
[data-ah-files-new] > button { animation: ce-files-new 1600ms ease-out; }
@keyframes ce-files-new { from, 30% { background: color-mix(in srgb, var(--ah-accent) 18%, transparent); } to { background: transparent; } }
/* New file / folder, matching the tree header's own reload button. */
.ce-files-tool {
  display: inline-flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; cursor: pointer; line-height: 1;
  color: var(--dsw-alias-label-secondary, currentColor); transition: background-color 120ms ease, color 120ms ease;
}
.ce-files-tool svg { width: 15px; height: 15px; }
.ce-files-tool:hover { background: var(--dsw-alias-interactive-bg-hover, var(--ah-hover)); color: var(--dsw-alias-label-primary, currentColor); }
.ce-files-tool:active { background: color-mix(in srgb, currentColor 12%, transparent); }
.ce-files-tool:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
@media (pointer: coarse) { .ce-files-tool { width: 36px; height: 36px; } .ce-files-tool svg { width: 17px; height: 17px; } }
/* The draft row naming a new entry, in the tree's own row box. */
[data-ah-files-draft] { position: relative; list-style: none; }
ul:has(> [data-ah-files-draft]) > [data-files-row="empty"] { display: none; }
.ce-draft-row, .ce-draft-row:hover { box-sizing: border-box; cursor: default; background: transparent; }
.ce-draft-icon { width: 16px; height: 16px; flex: none; color: var(--ah-fg2); }
.ce-draft-input {
  flex: 1 1 auto; min-width: 0; height: 22px; margin: -1.25px 0; padding: 0 6px; box-sizing: border-box;
  border: 1px solid var(--ah-focus); border-radius: 4px; outline: none; background: var(--ah-bg);
  color: var(--ah-fg); font: inherit; line-height: 20px;
}
.ce-draft-input::placeholder { color: var(--ah-fg3); }
.ce-draft-input[aria-invalid="true"] { border-color: var(--ah-danger); }
.ce-draft-row[data-busy] .ce-draft-input { color: var(--ah-fg2); border-color: var(--ah-line-strong); }
.ce-draft-error {
  position: absolute; z-index: 2; top: calc(100% - 3px); left: 32px; right: 10px; padding: 4px 8px;
  border: 1px solid var(--ah-danger); border-radius: 0 0 4px 4px; background: var(--ah-popup);
  background-image: linear-gradient(color-mix(in srgb, var(--ah-danger) 10%, transparent), color-mix(in srgb, var(--ah-danger) 10%, transparent));
  color: var(--ah-fg); font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; box-shadow: 0 4px 12px rgb(0 0 0 / .12);
}
.ce-draft-error[hidden] { display: none; }
@media (pointer: coarse) {
  .ce-draft-input { height: 32px; margin: -6px 0; font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .ce-files-tool { transition: none; }
  [data-ah-files-new] > button { animation: none; background: var(--ah-hover); }
}
`

let installed = 0
let tag: HTMLStyleElement | undefined

export function injectEditorStyle(): () => void {
  if (installed++ === 0) {
    tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-agent-hub'
    tag.dataset.pluginCss = 'dsh-agent-hub/editor'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }
  return () => {
    if (--installed === 0) {
      tag?.remove()
      tag = undefined
    }
  }
}
