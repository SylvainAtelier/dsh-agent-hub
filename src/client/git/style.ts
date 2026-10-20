/**
 * Git pane stylesheet, `gp-` prefixed. Neutrals come from the host's --dsw
 * alias tokens (with currentColor fallbacks), so both themes read correctly;
 * hue is spent only on meaning: change kinds, diff lines, lanes, danger.
 * Motion is short and transform/opacity only; reduced motion turns it off.
 * Loading indicators are slow and soft, and fade in only after a beat, so a
 * quick load shows nothing rather than a flash.
 */

const CSS = `
.gp-root, .gp-menu, .gp-dialog, .gp-scrim, .gt-notices {
  --gp-active: color-mix(in srgb, var(--ah-accent) 14%, transparent);
  --gp-con: #c2410c;
}

.gp-root {
  position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; flex: auto;
  color: var(--ah-fg); font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.45;
  -webkit-tap-highlight-color: transparent;
}
:where(.gp-root) button { font: inherit; color: inherit; }
.gp-grow { flex: 1 1 auto; }
.gp-muted { color: var(--ah-fg3); }
.gp-mono { font-family: var(--ah-mono); font-size: 12px; }

/* Buttons: .ah-btn / .ah-icon-btn (theme/base.ts) */
.gp-text-btn { border: 0; background: transparent; padding: 2px 6px; border-radius: 4px; cursor: pointer; color: var(--ah-fg2); font-size: 12px; }
.gp-text-btn:hover { background: var(--ah-hover); color: var(--ah-fg); }
.gp-link { border: 0; background: transparent; padding: 0 4px; cursor: pointer; color: inherit; opacity: .8; font-size: 12px; text-decoration: underline; text-underline-offset: 2px; }
.gp-root :focus-visible, .gp-menu :focus-visible, .gp-dialog :focus-visible {
  outline: 2px solid var(--ah-focus); outline-offset: -2px;
}
.gp-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 7px; border-radius: 11px; cursor: pointer;
  border: .5px solid var(--ah-line); background: transparent; color: var(--ah-fg2);
}
.gp-chip:hover { background: var(--ah-hover); color: var(--ah-fg); }

/* Header */
.gp-head {
  position: relative; flex: none; display: flex; align-items: center; gap: 2px; height: 38px; padding: 0 6px 0 8px; box-sizing: border-box;
  border-bottom: .5px solid var(--ah-line);
}
.gp-branch {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 60%; height: 28px; padding: 0 8px; border: 0;
  border-radius: var(--ah-radius-sm); background: transparent; cursor: pointer; font-weight: 600;
}
.gp-branch:hover { background: var(--ah-hover); }
.gp-branch > svg { flex: none; color: var(--ah-fg2); }
.gp-branch-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gp-sync {
  display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; margin-right: 2px; border-radius: 13px; cursor: pointer;
  border: .5px solid var(--ah-line-strong); background: transparent; color: var(--ah-fg2); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; flex: none;
}
.gp-sync:hover:not(:disabled) { background: var(--ah-hover); color: var(--ah-fg); }
.gp-sync:disabled { opacity: .5; }
.gp-sync-n { font-weight: 600; color: var(--ah-fg); }
.gp-progress { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; overflow: hidden; pointer-events: none; }
.gp-head[data-busy] .gp-progress::after {
  content: ''; position: absolute; top: 0; bottom: 0; width: 30%; border-radius: 1px; background: var(--ah-accent);
  animation: gp-appear 400ms ease 300ms both, gp-indeterminate 2s cubic-bezier(.45, 0, .55, 1) 300ms infinite;
}
@keyframes gp-indeterminate { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
@keyframes gp-appear { from { opacity: 0; } }
.gp-spin { animation: gp-spin 1.6s linear infinite; }
@keyframes gp-spin { to { transform: rotate(360deg); } }

/* Changes / Graph / Worktrees switch */
.gp-tabs {
  position: relative; flex: none; display: grid; grid-template-columns: repeat(3, 1fr); margin: 8px 10px 4px; padding: 2px; border-radius: var(--ah-radius);
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.gp-tab {
  position: relative; z-index: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 26px; border: 0;
  border-radius: var(--ah-radius-sm); background: transparent; cursor: pointer; color: var(--ah-fg2); transition: color 150ms ease;
}
.gp-tab[aria-selected="true"] { color: var(--ah-fg); font-weight: 600; }
.gp-tab-ink {
  position: absolute; top: 2px; bottom: 2px; left: 2px; width: calc((100% - 4px) / 3); border-radius: var(--ah-radius-sm);
  background: var(--ah-popup); box-shadow: 0 1px 2px rgb(0 0 0 / .12), 0 0 0 .5px var(--ah-line);
  transition: transform 220ms var(--ah-ease);
}
.gp-tabs[data-view="graph"] .gp-tab-ink { transform: translateX(100%); }
.gp-tabs[data-view="trees"] .gp-tab-ink { transform: translateX(200%); }
.gp-count {
  display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 16px; padding: 0 5px; box-sizing: border-box;
  border-radius: 8px; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1;
  background: color-mix(in srgb, currentColor 10%, transparent); color: var(--ah-fg2);
}

/* Body & layout */
.gp-body { position: relative; flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
.gp-base { position: relative; flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.gp-root[data-layout="split"] .gp-base { min-width: 300px; }
.gp-detail { position: relative; flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; min-height: 0; border-left: .5px solid var(--ah-line); }
.gp-detail[data-overlay] {
  position: absolute; inset: 0; z-index: 2; border-left: 0; background: var(--ah-bg);
  animation: gp-push 220ms var(--ah-ease);
}
.gp-detail[data-leaving] { animation: gp-pop-out 160ms ease-in forwards; pointer-events: none; }
.gp-base[data-covered] { visibility: hidden; transition: visibility 0s 220ms; }
@keyframes gp-push { from { transform: translateX(28px); opacity: 0; } }
@keyframes gp-pop-out { to { transform: translateX(28px); opacity: 0; } }
.gp-list { flex: 1 1 auto; min-height: 0; overflow: auto; outline: none; overscroll-behavior: contain; scrollbar-gutter: stable; }
.gp-list::-webkit-scrollbar, .gp-diff::-webkit-scrollbar, .gp-commit-detail::-webkit-scrollbar, .gp-hbar::-webkit-scrollbar { width: 10px; height: 10px; }
.gp-list::-webkit-scrollbar-thumb, .gp-diff::-webkit-scrollbar-thumb, .gp-commit-detail::-webkit-scrollbar-thumb, .gp-hbar::-webkit-scrollbar-thumb {
  border: 3px solid transparent; border-radius: 6px; background: color-mix(in srgb, currentColor 18%, transparent) padding-box;
}
.gp-state { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 16px; color: var(--ah-fg2); }
.gp-state p { margin: 0; line-height: 1.6; }
.gp-note { margin: 4px 12px; font-size: 12px; color: var(--ah-fg3); }

/* Commit box */
.gp-commit { display: flex; flex-direction: column; gap: 8px; padding: 6px 10px 10px; }
.gp-input {
  box-sizing: border-box; width: 100%; min-width: 0; padding: 7px 10px; border-radius: var(--ah-radius-sm); outline: none;
  border: .5px solid var(--ah-line-strong); background: var(--dsw-specific-input-major, var(--ah-layer)); color: var(--ah-fg); font: inherit;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.gp-input:focus { border-color: color-mix(in srgb, var(--ah-accent) 70%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ah-accent) 16%, transparent); }
.gp-input[aria-invalid="true"] { border-color: var(--ah-del); }
.gp-message { resize: none; min-height: 34px; max-height: 180px; line-height: 1.45; overflow-y: auto; }
.gp-commit-actions { display: flex; gap: 6px; min-width: 0; }
.gp-commit-actions > .gp-split { flex: 1 1 auto; min-width: 0; }
/* AI commit: the model's action, in a violet-to-blue fill that stands apart from the plain primary button. */
.gp-ai-commit {
  --gp-ai-a: #7c3aed; --gp-ai-b: #4f46e5; --gp-ai-c: #2563eb;
  position: relative; overflow: hidden; flex: none; max-width: 45%; border: 0; font-weight: 600; color: #fff;
  background: linear-gradient(115deg, var(--gp-ai-a), var(--gp-ai-b) 45%, var(--gp-ai-c), var(--gp-ai-a)) 0 0 / 220% 100%;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .12), inset 0 1px 0 rgba(255, 255, 255, .22), 0 4px 14px -6px color-mix(in srgb, var(--gp-ai-a) 70%, transparent);
  transition: background-position 500ms ease, box-shadow 160ms ease, transform 80ms ease;
}
.gp-ai-commit svg { flex: none; }
.gp-ai-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* .ah-btn too: the host button's own hover fill would otherwise replace the gradient. */
.ah-btn.gp-ai-commit:hover:not(:disabled) {
  background: linear-gradient(115deg, var(--gp-ai-a), var(--gp-ai-b) 45%, var(--gp-ai-c), var(--gp-ai-a)) 100% 0 / 220% 100%;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .12), inset 0 1px 0 rgba(255, 255, 255, .22), 0 6px 18px -6px color-mix(in srgb, var(--gp-ai-a) 85%, transparent);
}
.gp-ai-commit:focus-visible { outline: 2px solid var(--gp-ai-a); outline-offset: 2px; }
/*
 * Working: the fill holds still and only small transform-animated parts move — a spinner in place
 * of the sparkle and a thin bar along the bottom edge. Nothing repaints the gradient per frame, which
 * on Windows' compositor showed as the whole button flashing.
 */
.ah-btn.gp-ai-commit[aria-busy="true"]:disabled { opacity: 1; cursor: progress; transition: none; contain: paint; }
.gp-ai-spinner {
  flex: none; box-sizing: border-box; width: 13px; height: 13px; border-radius: 50%;
  border: 1.6px solid rgba(255, 255, 255, .32); border-top-color: #fff;
  animation: gp-spin .9s linear infinite;
}
.gp-ai-track { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; overflow: hidden; pointer-events: none; background: rgba(255, 255, 255, .16); }
.gp-ai-track::after {
  content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 35%; border-radius: 1px; background: rgba(255, 255, 255, .85);
  will-change: transform; animation: gp-ai-run 1.6s cubic-bezier(.45, 0, .55, 1) infinite;
}
@keyframes gp-ai-run { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
.ah-btn.gp-ai-commit:disabled:not([aria-busy="true"]) { background: transparent; color: inherit; box-shadow: inset 0 0 0 1px var(--ah-line-strong); }
.gp-ai-commit[data-icon-only] { padding: 0; aspect-ratio: 1; }
@media (prefers-reduced-motion: reduce) {
  .gp-ai-commit { transition: none; }
  .gp-ai-spinner { animation: none; border-right-color: #fff; }
  .gp-ai-track::after { animation: none; width: 100%; opacity: .5; }
}
.gp-split { display: flex; gap: 1px; }
.gp-split-main { flex: 1 1 auto; border-top-right-radius: 0; border-bottom-right-radius: 0; }
.gp-split-main span { overflow: hidden; text-overflow: ellipsis; }
.gp-split-more { flex: none; width: 30px; padding: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; }

/* Commit identity: who the commit box commits as, between the message and the button. */
.gp-ident-wrap { display: flex; flex-direction: column; gap: 4px; margin: -2px 0; }
.gp-ident {
  display: flex; align-items: center; gap: 6px; min-width: 0; height: 28px; padding: 0 6px 0 4px; border: .5px solid transparent;
  border-radius: var(--ah-radius-sm); background: transparent; color: var(--ah-fg2); font: inherit; font-size: 12px; text-align: left; cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.gp-ident:hover { background: var(--ah-hover); }
.gp-ident .gp-ident-avatar { width: 20px; height: 20px; font-size: 11px; }
.gp-ident-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--ah-fg); }
.gp-ident-email { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ah-fg3); font-family: var(--ah-mono); font-size: 11.5px; }
.gp-ident[data-narrow] .gp-ident-email { display: none; }
.gp-ident[data-narrow] .gp-ident-name, .gp-ident[data-state="none"] .gp-ident-name { flex: 1 1 auto; }
.gp-ident-tag {
  flex: none; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 18px; white-space: nowrap;
  background: color-mix(in srgb, var(--ah-fg3) 14%, transparent); color: var(--ah-fg2);
}
.gp-ident-chevron { flex: none; margin-left: auto; color: var(--ah-fg3); }
/* Inherited or missing: a commit from here asks first. Amber marks it; the words carry it too. */
.gp-ident[data-state="inherited"], .gp-ident[data-state="none"] {
  border-color: color-mix(in srgb, var(--ah-mod) 50%, transparent); background: color-mix(in srgb, var(--ah-mod) 8%, transparent);
}
.gp-ident[data-state="none"] { border-style: dashed; }
.gp-ident[data-state="inherited"]:hover, .gp-ident[data-state="none"]:hover { background: color-mix(in srgb, var(--ah-mod) 14%, transparent); }
.gp-ident[data-state="inherited"] .gp-ident-tag { background: color-mix(in srgb, var(--ah-mod) 20%, transparent); color: var(--ah-fg); }
.gp-ident[data-state="inherited"] .gp-ident-avatar, .gp-ident[data-state="none"] .gp-ident-avatar {
  background: color-mix(in srgb, var(--ah-mod) 22%, transparent); color: var(--ah-fg);
}
.gp-ident[data-state="env"] .gp-ident-tag { background: color-mix(in srgb, var(--ah-accent) 16%, transparent); color: var(--ah-fg); }
.gp-ident-note { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; padding: 0 6px; font-size: 12px; color: var(--ah-fg2); }
.gp-ident-link { padding: 0; }
.gp-root[data-coarse] .gp-ident { height: 38px; font-size: 13px; }
.gp-root[data-coarse] .gp-ident .gp-ident-avatar { width: 24px; height: 24px; font-size: 12px; }
.gp-root[data-coarse] .gp-ident-link { min-height: 32px; }
.gp-ident-menu:not([data-sheet]) { min-width: min(380px, calc(100vw - 16px)); }
.gp-ident-menu .gp-menu-hint { max-width: 62%; }
@media (prefers-reduced-motion: reduce) { .gp-ident { transition: none; } }
.gp-banner {
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; margin: 0 10px 8px; padding: 10px; border-radius: var(--ah-radius);
  background: color-mix(in srgb, var(--ah-mod) 12%, transparent); border: .5px solid color-mix(in srgb, var(--ah-mod) 35%, transparent);
}
.gp-banner > svg { flex: none; margin-top: 2px; color: var(--ah-mod); }
.gp-banner-text { flex: 1 1 160px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--ah-fg2); }
.gp-banner-text strong { color: var(--ah-fg); font-size: 13px; }
.gp-banner-actions { display: flex; gap: 6px; margin-left: auto; }
.gp-empty { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 28px 16px; color: var(--ah-fg3); text-align: center; }
.gp-empty > svg { color: var(--ah-add); margin-bottom: 4px; }
.gp-empty strong { color: var(--ah-fg2); font-weight: 600; }

/* Rows */
.gp-row {
  box-sizing: border-box; display: flex; align-items: center; gap: 6px; padding: 0 8px 0 12px; margin: 0 4px; border-radius: var(--ah-radius-sm);
  cursor: pointer; user-select: none; white-space: nowrap; outline: none;
}
.gp-list .gp-row { right: 4px !important; left: 4px !important; margin: 0; }
.gp-row:hover { background: var(--ah-hover); }
.gp-row[data-active], .gp-row[data-selected] { background: var(--gp-active); }
.gp-row:focus-visible { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ah-accent) 70%, transparent); outline: none; }
.gp-row-actions { display: none; flex: none; align-items: center; gap: 0; margin-left: auto; }
.gp-row:hover .gp-row-actions, .gp-row:focus-within .gp-row-actions, .gp-row[data-active] .gp-row-actions,
.gp-root[data-coarse] .gp-row-actions { display: flex; }
.gp-row-actions .ah-icon-btn { width: 24px; height: 24px; }
.gp-root[data-coarse] .gp-row-actions .ah-icon-btn { width: 32px; height: 32px; }
.gp-section { padding-left: 4px; font-size: 11px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--ah-fg2); }
.gp-section-title { overflow: hidden; text-overflow: ellipsis; }
.gp-section .gp-count { font-size: 11px; }
.gp-chevron { display: inline-flex; width: 16px; justify-content: center; color: var(--ah-fg3); transition: transform 150ms var(--ah-ease); }
.gp-chevron[data-open] { transform: rotate(90deg); }
.gp-file { padding-left: 24px; }
.gp-file-icon { flex: none; display: inline-flex; color: var(--ah-fg3); }
.gp-file-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.gp-file[data-deleted] .gp-file-name { text-decoration: line-through; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); }
.gp-file-dir { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ah-fg3); font-size: 12px; direction: rtl; text-align: left; }
.gp-row:hover .gp-file-dir, .gp-row[data-active] .gp-file-dir { flex-basis: 0; }
.gp-code {
  flex: none; width: 14px; text-align: center; font-family: var(--ah-mono); font-size: 12px; font-weight: 700;
}
.gp-code[data-c="mod"] { color: var(--ah-warn-ink); }
.gp-code[data-c="add"] { color: var(--ah-ok-ink); }
.gp-code[data-c="del"] { color: var(--ah-danger-ink); }
.gp-code[data-c="ren"] { color: var(--ah-info-ink); }
.gp-code[data-c="con"] { color: color-mix(in srgb, var(--gp-con) 65%, currentColor); }
.gp-stat { flex: none; display: inline-flex; gap: 6px; font-family: var(--ah-mono); font-size: 12px; font-variant-numeric: tabular-nums; }
.gp-stat [data-k="add"] { color: var(--ah-ok-ink); }
.gp-stat [data-k="del"] { color: var(--ah-danger-ink); }
.gp-stat-sm { font-size: 11px; gap: 4px; opacity: .9; }

/* Graph */
.gp-graph-wrap { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.gp-graph-wrap[data-resizing], .gp-graph-wrap[data-resizing] * { cursor: col-resize !important; user-select: none; }
.gp-commit-row { gap: 8px; padding: 0 4px 0 0; }
.gp-lanes { flex: none; width: var(--gp-c-graph, 48px); overflow: hidden; }
.gp-commit-main { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 4px; overflow: hidden; }
.gp-subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.gp-commit-row[data-worktree] .gp-subject { font-style: italic; color: var(--ah-fg2); }
.gp-author { flex: none; width: var(--gp-c-author); overflow: hidden; text-overflow: ellipsis; color: var(--ah-fg3); font-size: 12px; }
.gp-hash { flex: none; width: var(--gp-c-hash); overflow: hidden; font-family: var(--ah-mono); font-size: 12px; color: var(--ah-fg3); }
.gp-date { flex: none; width: var(--gp-c-date); overflow: hidden; text-overflow: ellipsis; text-align: right; color: var(--ah-fg3); font-size: 12px; font-variant-numeric: tabular-nums; }

/* Graph toolbar: scope picker + find field */
.gp-gbar { flex: none; display: flex; align-items: center; gap: 6px; min-width: 0; padding: 6px 8px 4px; }
.gp-scope {
  flex: 0 1 auto; min-width: 0; max-width: 45%; display: inline-flex; align-items: stretch; height: 28px; box-sizing: border-box;
  border: .5px solid var(--ah-line-strong); border-radius: var(--ah-radius-sm); overflow: hidden;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.gp-scope[data-on] { border-color: color-mix(in srgb, var(--ah-accent) 55%, transparent); background: color-mix(in srgb, var(--ah-accent) 10%, transparent); }
.gp-scope-btn {
  min-width: 0; display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; border: 0; background: transparent;
  color: var(--ah-fg2); font: inherit; font-size: 12px; cursor: pointer;
}
.gp-scope-btn:hover { background: var(--ah-hover); color: var(--ah-fg); }
.gp-scope-btn > svg { flex: none; }
.gp-scope[data-on] .gp-scope-btn { color: var(--ah-fg); font-weight: 600; }
.gp-scope[data-on] .gp-scope-btn > svg:first-child { color: var(--ah-accent); }
.gp-scope-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gp-scope[data-compact] { flex: none; }
.gp-scope[data-compact] .gp-scope-name, .gp-scope[data-compact] .gp-scope-btn > svg:last-child { display: none; }
.gp-who { flex: none; max-width: 40%; }
.gp-who:not([data-on]) .gp-scope-btn { padding: 0 6px; gap: 3px; }
.gp-scope-clear {
  flex: none; width: 26px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0;
  border-left: .5px solid color-mix(in srgb, var(--ah-accent) 35%, transparent); background: transparent; color: var(--ah-fg2); cursor: pointer;
}
.gp-scope-clear:hover { background: var(--ah-hover); color: var(--ah-fg); }
.gp-find {
  flex: 1 1 120px; min-width: 0; display: flex; align-items: center; gap: 2px; height: 28px; box-sizing: border-box; padding: 0 2px 0 8px;
  border: .5px solid var(--ah-line-strong); border-radius: var(--ah-radius-sm); background: var(--dsw-specific-input-major, var(--ah-layer));
  color: var(--ah-fg3); cursor: text; transition: border-color 120ms ease, box-shadow 120ms ease;
}
.gp-find > svg { flex: none; }
.gp-find:focus-within { border-color: color-mix(in srgb, var(--ah-accent) 70%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ah-accent) 16%, transparent); }
.gp-find-input {
  flex: 1 1 auto; min-width: 40px; height: 100%; padding: 0 4px; border: 0; outline: none; background: transparent;
  color: var(--ah-fg); font: inherit; font-size: 13px;
}
.gp-find-input::placeholder { color: var(--ah-fg3); }
.gp-find .gp-find-input:focus, .gp-find .gp-find-input:focus-visible { outline: none !important; box-shadow: none !important; border: 0 !important; }
.gp-find-count { flex: none; padding: 0 4px; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--ah-fg3); }
.gp-find[data-none] .gp-find-count { color: var(--ah-danger-ink); }
.gp-find .ah-icon-btn { width: 24px; height: 24px; }
.gp-root[data-coarse] .gp-gbar { padding: 8px; gap: 8px; }
.gp-root[data-coarse] .gp-scope, .gp-root[data-coarse] .gp-find { height: 36px; }
.gp-root[data-coarse] .gp-scope-clear { width: 36px; }
.gp-root[data-coarse] .gp-find-input { font-size: 16px; }
.gp-root[data-coarse] .gp-find .ah-icon-btn { width: 32px; height: 32px; }

/* Graph column headers: mirror a row's layout (insets, gaps, the more button) so edges line up */
.gp-ghead {
  flex: none; display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 8px 0 4px; overflow: hidden; scrollbar-gutter: stable;
  border-bottom: .5px solid var(--ah-line); font-size: 11px; font-weight: 500; color: var(--ah-fg3); white-space: nowrap; user-select: none;
}
.gp-root[data-coarse] .gp-ghead { height: 30px; }
.gp-hcell { position: relative; flex: none; display: flex; align-items: center; min-width: 0; height: 100%; }
.gp-hlabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.gp-hcell[data-col="graph"] { width: var(--gp-c-graph); padding-left: 8px; box-sizing: border-box; }
.gp-hcell[data-col="subject"] { flex: 1 1 auto; }
.gp-hcell[data-col="author"] { width: var(--gp-c-author); }
.gp-hcell[data-col="hash"] { width: var(--gp-c-hash); }
.gp-hcell[data-col="date"] { width: var(--gp-c-date); justify-content: flex-end; }
.gp-hcell[data-col="more"] { width: 24px; }
.gp-col-handle {
  position: absolute; top: 0; bottom: 0; z-index: 1; width: 8px; cursor: col-resize; touch-action: none; outline: none;
}
.gp-col-handle[data-edge="end"] { right: -8px; }
.gp-col-handle[data-edge="start"] { left: -8px; }
.gp-col-handle::after {
  content: ''; position: absolute; left: 50%; top: 6px; bottom: 6px; width: 1px; transform: translateX(-50%);
  background: var(--ah-line-strong); border-radius: 1px; transition: background-color 120ms ease, top 120ms ease, bottom 120ms ease, width 120ms ease;
}
.gp-col-handle:hover::after, .gp-col-handle:focus-visible::after, .gp-graph-wrap[data-resizing] .gp-col-handle:active::after {
  top: 2px; bottom: 2px; width: 2px; background: var(--ah-accent);
}
.gp-root[data-coarse] .gp-col-handle { width: 16px; }
.gp-root[data-coarse] .gp-col-handle[data-edge="end"] { right: -12px; }
.gp-root[data-coarse] .gp-col-handle[data-edge="start"] { left: -12px; }

/* Find: matches stand out, the rest step back */
.gp-mark { padding: 0 1px; border-radius: 2px; background: color-mix(in srgb, #f5c400 40%, transparent); color: inherit; }
.gp-commit-row[data-dim] > :not(.gp-lanes) { opacity: .42; }
.gp-commit-row[data-dim] > .gp-lanes { opacity: .6; }
.gp-commit-row[data-dim]:hover > *, .gp-commit-row[data-dim][data-selected] > * { opacity: 1; }
.gp-commit-row[data-found]:not([data-selected]) { background: color-mix(in srgb, #f5c400 13%, transparent); }
.gp-commit-row[data-found] .gp-mark { background: color-mix(in srgb, #f5a400 70%, transparent); }

/* Locate: HEAD's row flashes in its lane color while a ring ripples off its node */
.gp-locate { margin-left: -2px; }
.gp-commit-row[data-located] { animation: gp-locate 1800ms cubic-bezier(.2, 0, 0, 1) both; }
.gp-commit-row[data-located] > * { opacity: 1 !important; }
.gp-locate-ring { transform-box: fill-box; transform-origin: center; animation: gp-ripple 900ms cubic-bezier(.2, 0, 0, 1) 2 both; }
@keyframes gp-locate {
  0%, 55% { background: color-mix(in srgb, var(--gp-locate) 18%, transparent); box-shadow: inset 3px 0 0 var(--gp-locate); }
  100% { background: transparent; box-shadow: inset 3px 0 0 transparent; }
}
@keyframes gp-ripple { from { transform: scale(1); opacity: .9; } to { transform: scale(2.1); opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .gp-root .gp-commit-row[data-located] {
    animation: none !important; background: color-mix(in srgb, var(--gp-locate) 16%, transparent); box-shadow: inset 3px 0 0 var(--gp-locate);
  }
  .gp-root .gp-locate-ring { display: none; }
}
.gp-row-more { visibility: hidden; width: 24px !important; height: 24px !important; }
.gp-commit-row:hover .gp-row-more, .gp-commit-row[data-selected] .gp-row-more, .gp-commit-row:focus-within .gp-row-more,
.gp-root[data-coarse] .gp-row-more { visibility: visible; }
.gp-badge {
  --gp-lane: var(--ah-accent);
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 3px; min-width: 0; max-width: min(140px, 40%); height: 18px; padding: 0 6px; box-sizing: border-box;
  border-radius: 9px; border: 1px solid color-mix(in srgb, var(--gp-lane) 55%, transparent); background: color-mix(in srgb, var(--gp-lane) 12%, transparent);
  color: var(--ah-fg); font-size: 11px; font-weight: 500; line-height: 1; cursor: pointer; white-space: nowrap;
}
.gp-badge:hover { background: color-mix(in srgb, var(--gp-lane) 22%, transparent); }
.gp-badge > svg { flex: none; opacity: .8; }
.gp-badge-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.gp-badge[data-current] { background: var(--gp-lane); border-color: transparent; color: #fff; font-weight: 600; }
.gp-badge[data-kind="remote"] { background: transparent; border-style: dashed; color: var(--ah-fg2); }
.gp-badge[data-kind="tag"] { border-radius: 4px; background: transparent; border-color: var(--ah-line-strong); color: var(--ah-fg2); }
.gp-badge-sync { opacity: .7; font-size: 10px; }
.gp-badge-more { cursor: default; background: transparent; color: var(--ah-fg3); }
.gp-tip {
  --gp-lane: var(--ah-accent);
  position: fixed; top: 0; left: 0; z-index: var(--ah-z-menu); box-sizing: border-box; max-width: min(420px, calc(100vw - 16px));
  padding: 6px 10px 6px 12px; border-radius: 8px; pointer-events: none;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, Canvas)); color: var(--ah-fg);
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  box-shadow: inset 3px 0 0 var(--gp-lane), var(--dsw-elevation-prominent, 0 8px 24px rgb(0 0 0 / .18)), 0 0 0 .5px var(--ah-line-strong);
  opacity: 0; visibility: hidden; translate: 0 3px;
  transition: opacity 110ms var(--ah-ease), translate 110ms var(--ah-ease), visibility 0s linear 110ms;
}
.gp-tip[data-side="bottom"] { translate: 0 -3px; }
.gp-tip[data-open] { opacity: 1; visibility: visible; translate: 0 0; transition-delay: 0s; }
.gp-tip-name { font: 600 12px/17px var(--ah-mono); overflow-wrap: anywhere; }
.gp-tip-dir { color: var(--ah-fg3); font-weight: 400; }
.gp-tip-list { margin: 4px 0 0; padding: 0; list-style: none; font: 12px/18px var(--ah-mono); color: var(--ah-fg2); overflow-wrap: anywhere; }
.gp-tip-meta { margin-top: 2px; color: var(--ah-fg2); font-size: 11px; line-height: 16px; }
@media (prefers-reduced-motion: reduce) { .gp-tip, .gp-tip[data-side="bottom"] { translate: none; transition: none; } }

/* Worktrees */
.gw-list { padding-bottom: 12px; }
.gw-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px 6px 12px; }
.gw-row {
  display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; column-gap: 8px; margin: 0 6px; padding: 8px 4px 8px 8px;
  border-radius: var(--ah-radius); outline: none; user-select: none; transition: background-color 120ms ease;
}
.gw-row[data-openable] { cursor: pointer; }
.gw-row:hover { background: var(--ah-hover); }
.gw-row[data-current] { background: var(--gp-active); }
.gw-row:focus-visible { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ah-accent) 70%, transparent); }
.gw-row[data-gone] .gw-main { opacity: .55; }
.gw-icon { align-self: start; display: flex; padding-top: 2px; color: var(--ah-fg3); }
.gw-row[data-current] .gw-icon { color: var(--ah-accent); }
.gw-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.gw-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.gw-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.gw-tag {
  flex: none; height: 16px; padding: 0 6px; border-radius: 8px; font-size: 11px; line-height: 16px; color: var(--ah-fg2);
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.gw-issue {
  flex: 0 1 auto; min-width: 0; display: inline-flex; align-items: center; gap: 5px; max-width: 45%; height: 18px; padding: 0 7px; border-radius: 9px; white-space: nowrap;
  font-size: 11px; color: var(--ah-fg2); text-decoration: none; background: color-mix(in srgb, currentColor 8%, transparent);
}
.gw-issue:hover { color: var(--ah-fg); background: color-mix(in srgb, currentColor 14%, transparent); }
.gw-issue .gp-pick-dot { width: 7px; height: 7px; }
.gw-issue-id { flex: none; font-family: var(--ah-mono); }
.gw-issue-state { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-tag[data-kind="current"] { color: var(--ah-fg); font-weight: 600; background: color-mix(in srgb, var(--ah-fg) 16%, transparent); }
.gw-sub { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 10px; min-width: 0; font-size: 12px; color: var(--ah-fg3); }
.gw-path { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--ah-mono); font-size: 12px; }
.gw-fact { white-space: nowrap; }
.gw-fact[data-dirty] { color: var(--ah-warn-ink); }
.gw-actions { display: flex; align-items: center; gap: 2px; }
.gw-open { opacity: 0; transition: opacity 120ms ease; }
.gw-row:hover .gw-open, .gw-row:focus-within .gw-open, .gp-root[data-coarse] .gw-open { opacity: 1; }
.gp-root[data-coarse] .gw-row { padding-top: 11px; padding-bottom: 11px; }
.gw-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 24px 24px 8px; text-align: center; color: var(--ah-fg3); }
.gw-empty > svg { color: var(--ah-accent); }
.gw-empty strong { color: var(--ah-fg2); font-weight: 600; }
.gw-empty p { margin: 0; max-width: 340px; font-size: 12px; line-height: 1.6; }

/* Skeletons */
.gp-skeleton-list { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; }
.gp-skeleton-row { height: 12px; border-radius: 6px; background: color-mix(in srgb, currentColor 8%, transparent);
  animation: gp-appear 360ms ease 180ms both, gp-breathe 2.8s ease-in-out 540ms infinite; }
.gp-skeleton-row:nth-child(3n) { width: 70%; }
.gp-skeleton-row:nth-child(3n+1) { width: 88%; }
@keyframes gp-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .6; } }

/* Panels */
.gp-panel { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; outline: none; }
.gp-root .ah-icon-btn[aria-pressed="true"] { color: var(--ah-fg); background: color-mix(in srgb, currentColor 14%, transparent); }
.gp-root .gp-panel:focus-visible, .gp-root .gp-list:focus-visible, .gp-root .gp-diff:focus-visible { outline: none; }
.gp-panel-head {
  flex: none; display: flex; align-items: center; gap: 4px; height: 38px; padding: 0 6px 0 4px; box-sizing: border-box;
  border-bottom: .5px solid var(--ah-line);
}
.gp-panel-title { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; }
.gp-panel-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 600; flex: 0 1 auto; }
.gp-panel-title .gp-file-dir { flex: 1 1 auto; }
.gp-panel-actions { flex: none; display: flex; align-items: center; gap: 2px; }
.gp-diff { flex: 1 1 auto; min-height: 0; overflow: auto; outline: none; overscroll-behavior: contain; }
.gp-dl { display: flex; align-items: center; white-space: pre; tab-size: 4; line-height: 20px; }
.gp-dl { --gp-line-bg: transparent; background: var(--gp-line-bg); }
.gp-dl[data-k="add"] { --gp-line-bg: color-mix(in srgb, var(--ah-add) 13%, transparent); }
.gp-dl[data-k="del"] { --gp-line-bg: color-mix(in srgb, var(--ah-del) 12%, transparent); }
.gp-dl[data-k="add"] mark { background: color-mix(in srgb, var(--ah-add) 32%, transparent); color: inherit; border-radius: 2px; }
.gp-dl[data-k="del"] mark { background: color-mix(in srgb, var(--ah-del) 30%, transparent); color: inherit; border-radius: 2px; }
.gp-dl[data-k="hunk"] { color: var(--ah-fg3); --gp-line-bg: color-mix(in srgb, var(--ah-ren) 7%, transparent); padding-left: 8px; }
.gp-dl[data-k="note"] { color: var(--ah-fg3); font-style: italic; padding-left: 8px; }
.gp-dl[data-k="none"] { background: repeating-linear-gradient(-45deg, transparent 0 4px, color-mix(in srgb, currentColor 4%, transparent) 4px 5px); }
.gp-ln {
  flex: none; box-sizing: content-box; padding: 0 6px 0 4px; text-align: right; color: var(--ah-fg3); opacity: .75; user-select: none;
  position: sticky; left: 0; z-index: 1;
  background: linear-gradient(var(--gp-line-bg), var(--gp-line-bg)), var(--ah-bg);
}
.gp-half .gp-ln { position: relative; }
.gp-half .gp-dt { transform: translateX(calc(-1 * var(--gp-sx, 0px))); }
.gp-dm { flex: none; width: 14px; text-align: center; color: var(--ah-fg3); user-select: none; }
.gp-dl[data-k="add"] .gp-dm { color: var(--ah-ok-ink); }
.gp-dl[data-k="del"] .gp-dm { color: var(--ah-danger-ink); }
.gp-dt { flex: 1 0 auto; padding-right: 16px; }
.gp-wrap .gp-dl { align-items: flex-start; overflow: hidden; }
.gp-wrap .gp-dt { flex: none; padding-right: 0; white-space: pre-wrap; word-break: break-all; }
.gp-split-row { display: grid; grid-template-columns: 1fr 1fr; }
.gp-half { min-width: 0; overflow: hidden; }
.gp-half + .gp-half { border-left: .5px solid var(--ah-line); }
.gp-split-wrap { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; position: relative; }
.gp-split-wrap .gp-diff { overflow-x: hidden; }
.gp-probe { position: absolute; visibility: hidden; white-space: pre; pointer-events: none; }
.gp-hbar { flex: none; height: 10px; overflow-x: auto; overflow-y: hidden; border-top: .5px solid var(--ah-line); }
.gp-hbar > div { height: 1px; }
.gp-img-diff { flex: 1 1 auto; min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; padding: 12px; align-content: start; }
.gp-img-side { margin: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.gp-img-side figcaption { display: flex; gap: 8px; align-items: baseline; font-size: 12px; font-weight: 600; }
.gp-img-side[data-k="del"] figcaption > :first-child { color: var(--ah-danger-ink); }
.gp-img-side[data-k="add"] figcaption > :first-child { color: var(--ah-ok-ink); }
.gp-img-side figcaption .gp-muted { font-weight: 400; }
.gp-img-frame {
  display: flex; align-items: center; justify-content: center; min-height: 120px; padding: 8px; border-radius: 6px;
  border: 1px solid var(--ah-line);
  background: repeating-conic-gradient(color-mix(in srgb, currentColor 7%, transparent) 0 25%, transparent 0 50%) 0 0 / 16px 16px;
}
.gp-img-side[data-k="del"] .gp-img-frame { border-color: color-mix(in srgb, var(--ah-del) 45%, transparent); }
.gp-img-side[data-k="add"] .gp-img-frame { border-color: color-mix(in srgb, var(--ah-add) 45%, transparent); }
.gp-img-frame img { display: block; max-width: 100%; max-height: 70vh; object-fit: contain; image-rendering: auto; }
.gp-dl[data-region="ours"] { --gp-line-bg: color-mix(in srgb, var(--ah-add) 12%, transparent); }
.gp-dl[data-region="theirs"] { --gp-line-bg: color-mix(in srgb, var(--ah-ren) 13%, transparent); }
.gp-dl[data-region="base"] { --gp-line-bg: color-mix(in srgb, currentColor 6%, transparent); }
.gp-dl[data-region="marker"] { --gp-line-bg: color-mix(in srgb, var(--gp-con) 20%, transparent); font-weight: 600; }
.gp-conflict-bar {
  flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: .5px solid var(--ah-line);
  font-size: 12px; color: var(--ah-fg2);
}
.gp-commit-detail { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 14px 20px; overscroll-behavior: contain; }
.gp-detail-subject { margin: 0 0 6px; font-size: 15px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.gp-detail-body { margin: 0 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; color: var(--ah-fg2); }
.gp-detail-refs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
.gp-detail-meta { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
.gp-avatar {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%;
  background: color-mix(in srgb, var(--ah-accent) 18%, transparent); color: var(--ah-accent); font-weight: 700; font-size: 13px;
}
.gp-detail-who { display: flex; flex-direction: column; min-width: 0; font-size: 13px; }
.gp-detail-who > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gp-detail-hashes { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 14px; font-size: 12px; }
.gp-detail-files-head {
  display: flex; align-items: center; justify-content: space-between; padding: 8px 2px 6px; border-top: .5px solid var(--ah-line);
  font-size: 12px; font-weight: 600; color: var(--ah-fg2);
}
.gp-detail-files .gp-row { height: 28px; margin: 0 -8px; padding-left: 8px; }
.gp-root[data-coarse] .gp-detail-files .gp-row { height: 38px; }

/* Toasts */
.gp-toasts {
  position: absolute; left: 10px; right: 10px; bottom: calc(10px + env(safe-area-inset-bottom, 0px)); z-index: 5;
  max-width: 560px; margin-inline: auto; display: flex; flex-direction: column; gap: 6px; pointer-events: none;
}
.gp-toast {
  position: relative; overflow: hidden; pointer-events: auto; padding: 7px 6px 7px 12px; border-radius: var(--ah-radius); font-size: 13px;
  background: var(--dsw-specific-menu, var(--ah-popup)); color: var(--ah-fg);
  box-shadow: var(--ah-shadow), 0 0 0 .5px var(--ah-line);
  animation: gp-toast-in 200ms var(--ah-ease);
}
.gp-toast[data-kind="error"] { box-shadow: var(--ah-shadow), inset 3px 0 0 var(--ah-del), 0 0 0 .5px var(--ah-line); }
.gp-toast[data-kind="ok"] { box-shadow: var(--ah-shadow), inset 3px 0 0 var(--ah-add), 0 0 0 .5px var(--ah-line); }
.gp-toast-row { display: flex; align-items: flex-start; gap: 6px; }
/* Wrap in full: git errors carry long paths and are worth reading whole. */
.gp-toast-text {
  flex: 1 1 auto; min-width: 0; padding: 2px 0; line-height: 1.45; white-space: normal; overflow-wrap: anywhere; user-select: text;
}
.gp-toast-actions { flex: none; display: flex; align-items: center; gap: 2px; }
.gp-toast-close { width: 22px; height: 22px; }
.gp-root[data-coarse] .gp-toast-close { width: 36px; height: 36px; }
.gp-root[data-coarse] .gp-toast-actions .gp-link { min-height: 36px; padding-inline: 8px; }
.gp-toast-detail {
  margin: 6px 4px 2px 0; max-height: 160px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--ah-mono); font-size: 12px; color: var(--ah-fg2);
}
/* Countdown hairline: drains over the toast's lifetime, freezes while held. */
.gp-toast-ttl {
  position: absolute; left: 0; right: 0; bottom: 0; height: 2px; transform-origin: left; opacity: .55; pointer-events: none;
  background: var(--ah-add); animation: gp-toast-ttl var(--gp-toast-ttl, 10s) linear forwards;
}
.gp-toast[data-kind="error"] .gp-toast-ttl { background: var(--ah-del); }
.gp-toast[data-held] .gp-toast-ttl { animation-play-state: paused; }
@keyframes gp-toast-ttl { to { transform: scaleX(0); } }
@keyframes gp-toast-in { from { transform: translateY(8px); opacity: 0; } }

/* Touch selection actions float over the corner: showing them never resizes the diff or the terminal
   (a resized terminal refits its PTY and can drop the very selection the toolbar acts on). */
.gp-selection-actions {
  position: absolute; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); z-index: 4;
  display: none; align-items: center; gap: 4px; padding: 4px; border-radius: var(--ah-radius);
  background: var(--dsw-specific-menu, var(--ah-popup)); box-shadow: var(--ah-shadow), 0 0 0 .5px var(--ah-line);
}
@media (pointer: coarse), (max-width: 559px) {
  .gp-selection-actions { display: flex; }
  .gp-selection-actions button { min-height: 44px; padding: 0 12px; }
}

/* Menu & sheet */
.gp-menu {
  position: fixed; z-index: var(--ah-z-menu); box-sizing: border-box; min-width: 200px; max-width: min(340px, calc(100vw - 16px)); max-height: min(440px, calc(100vh - 16px));
  display: flex; flex-direction: column; padding: 4px; border-radius: 10px; outline: none; overflow: hidden;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, Canvas)); color: var(--ah-fg);
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 40px rgb(0 0 0 / .22)), 0 0 0 .5px var(--ah-line-strong);
  font-size: 13px; animation: gp-menu-in 130ms var(--ah-ease);
}
@keyframes gp-menu-in { from { opacity: 0; transform: scale(.96); } }
.gp-menu-items { overflow-y: auto; overscroll-behavior: contain; }
.gp-menu-item {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 0 10px 0 6px; box-sizing: border-box;
  border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.gp-menu-item[data-active]:not(:disabled) { background: var(--ah-hover); }
.gp-menu-item:disabled { opacity: .4; cursor: default; }
.gp-menu-item[data-danger] { color: var(--ah-danger-ink); }
.gp-menu-icon { flex: none; display: inline-flex; justify-content: center; width: 18px; color: var(--ah-fg2); font-size: 12px; }
.gp-menu-item[data-danger] .gp-menu-icon { color: inherit; }
.gp-menu-box { width: 11px; height: 11px; box-sizing: border-box; border: 1.2px solid currentColor; border-radius: 3px; opacity: .7; }
.gp-menu-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gp-menu-hint { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ah-fg3); font-size: 12px; font-family: var(--ah-mono); }
.gp-menu-row { position: relative; }
.gp-menu-row > .gp-menu-item { padding-right: 34px; }
.gp-menu-trail {
  position: absolute; top: 50%; right: 4px; transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--ah-fg3); cursor: pointer; opacity: 0;
}
.gp-menu-row[data-active] > .gp-menu-trail, .gp-menu-trail:focus-visible, .gp-menu-trail[data-on], .gp-menu[data-sheet] .gp-menu-trail { opacity: 1; }
.gp-menu-trail:hover { background: var(--ah-hover); color: var(--ah-fg); }
.gp-menu-trail[data-on] { color: #f5a524; }
.gp-menu-sep { height: .5px; margin: 4px 6px; background: var(--ah-line); }
.gp-menu-heading { padding: 8px 10px 4px; font-size: 11px; font-weight: 600; color: var(--ah-fg3); }
.gp-picker { width: 300px; }
.gp-picker-search { margin: 2px 2px 6px; width: calc(100% - 4px); height: 30px; }
.gp-menu[data-sheet] {
  left: 0 !important; right: 0; top: auto !important; bottom: 0; width: 100%; max-width: none; min-width: 0; max-height: 72vh;
  padding: 8px 8px calc(8px + env(safe-area-inset-bottom)); border-radius: 16px 16px 0 0; animation: gp-sheet-in 240ms var(--ah-ease);
}
.gp-menu[data-sheet]::before { content: ''; align-self: center; flex: none; width: 36px; height: 4px; margin: 0 0 8px; border-radius: 2px; background: var(--ah-line-strong); }
.gp-menu[data-sheet] .gp-menu-item { min-height: 44px; font-size: 15px; }
.gp-scrim { position: fixed; inset: 0; z-index: calc(var(--ah-z-menu) - 1); background: rgb(0 0 0 / .32); animation: gp-fade 200ms ease; }
@keyframes gp-sheet-in { from { transform: translateY(100%); } }
@keyframes gp-fade { from { opacity: 0; } }

/* Dialog */
.gp-dialog-scrim {
  position: fixed; inset: 0; z-index: var(--ah-z-modal); display: flex; align-items: center; justify-content: center; padding: 16px;
  background: rgb(0 0 0 / .36); animation: gp-fade 160ms ease;
}
.gp-dialog {
  box-sizing: border-box; width: min(420px, 100%); max-height: calc(100vh - 32px); overflow: auto; display: flex; flex-direction: column; gap: 12px;
  padding: 18px; border-radius: 16px; background: var(--dsw-alias-bg-layer-2, Canvas); color: var(--ah-fg); font-size: 13px;
  box-shadow: var(--dsw-elevation-prominent, 0 20px 60px rgb(0 0 0 / .3)), 0 0 0 .5px var(--ah-line-strong);
  animation: gp-dialog-in 180ms var(--ah-ease);
}
@keyframes gp-dialog-in { from { opacity: 0; transform: translateY(6px) scale(.98); } }
.gp-dialog-title { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.gp-dialog-body { margin: 0; color: var(--ah-fg2); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
.gp-field { display: flex; flex-direction: column; gap: 5px; }
.gp-field-label { font-size: 12px; color: var(--ah-fg2); }
.gp-field-error { font-size: 12px; color: var(--ah-danger-ink); }
.gp-field textarea { resize: vertical; min-height: 64px; }
.gp-check, .gp-radio { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.gp-check input, .gp-radio input { margin: 0; accent-color: var(--ah-accent); }
.gp-radios { display: flex; flex-direction: column; gap: 4px; max-height: min(264px, 40vh); overflow: auto; }
.gp-radio { padding: 7px 10px; min-height: 36px; box-sizing: border-box; border-radius: 8px; border: .5px solid var(--ah-line); transition: border-color 120ms, background-color 120ms; }
.gp-radio:hover { background: color-mix(in srgb, var(--ah-fg) 4%, transparent); }
.gp-radio:has(input:focus-visible) { outline: 2px solid var(--ah-accent); outline-offset: 1px; }
.gp-radio-text { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.gp-radio-detail { font-size: 12px; color: var(--ah-fg3); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.gp-radio:has(input:checked) { border-color: color-mix(in srgb, var(--ah-accent) 60%, transparent); background: color-mix(in srgb, var(--ah-accent) 8%, transparent); }
.gp-radio[data-danger]:has(input:checked) { border-color: color-mix(in srgb, var(--ah-del) 60%, transparent); background: color-mix(in srgb, var(--ah-del) 8%, transparent); }
/* Combo field: the ticket picker under the branch name */
.gp-combo-list {
  display: flex; flex-direction: column; max-height: 232px; overflow: auto; margin-top: 2px; padding: 4px;
  border-radius: 10px; border: .5px solid var(--ah-line); background: color-mix(in srgb, var(--ah-fg) 3%, transparent);
}
.gp-combo-title { padding: 4px 8px 2px; font-size: 11px; color: var(--ah-fg3); }
.gp-combo-row {
  display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 0 8px; border-radius: var(--ah-radius-sm); cursor: pointer;
}
.gp-combo-row[aria-selected="true"] { background: color-mix(in srgb, var(--ah-accent) 14%, transparent); }
.gp-combo-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gp-combo-detail { flex: none; max-width: 32%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--ah-fg3); }
.gp-pick-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--ah-fg3); box-sizing: border-box; }
[data-tone="started"] > .gp-pick-dot { border-color: var(--ah-stage-started); background: var(--ah-stage-started); }
[data-tone="unstarted"] > .gp-pick-dot, [data-tone="triage"] > .gp-pick-dot { border-color: var(--ah-stage-unstarted); }
[data-tone="completed"] > .gp-pick-dot { border-color: var(--ah-stage-completed); background: var(--ah-stage-completed); }
[data-tone="canceled"] > .gp-pick-dot, [data-tone="cancelled"] > .gp-pick-dot { border-color: var(--ah-stage-canceled); background: var(--ah-stage-canceled); }
.gp-pick-tag { flex: none; font-family: var(--ah-mono); font-size: 12px; color: var(--ah-fg2); }
.gp-pick {
  display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 4px 4px 10px; border-radius: 8px;
  background: color-mix(in srgb, var(--ah-accent) 10%, transparent);
}
.gp-pick-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.gp-pick-clear { flex: none; width: 24px; height: 24px; }
.gp-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.gp-dialog-note { margin: -4px 0 0; font-family: var(--ah-mono); font-size: 12px; color: var(--ah-fg3); overflow-wrap: anywhere; }
@media (max-width: 520px) {
  .gp-dialog-scrim { align-items: flex-end; padding: 0; }
  .gp-dialog { width: 100%; border-radius: 16px 16px 0 0; padding-bottom: calc(18px + env(safe-area-inset-bottom)); animation: gp-sheet-in 240ms var(--ah-ease); }
  .gp-dialog-actions .ah-btn { flex: 1; height: 40px; }
  .gp-combo-row { min-height: 44px; }
  .gp-combo-list { max-height: 40vh; }
  .gp-radio { min-height: 44px; }
}
@media (pointer: coarse) { .gp-radio { min-height: 44px; } }

/* Touch: bigger targets, no hover-only affordances */
.gp-root[data-coarse] .ah-icon-btn { width: 36px; height: 36px; }
.gp-root[data-coarse] .gp-head, .gp-root[data-coarse] .gp-panel-head { height: 46px; }
.gp-root[data-coarse] .gp-tab { height: 32px; }
.gp-root[data-coarse] .ah-btn { height: 38px; }

/* Commit message drafting */
.gp-message-wrap { position: relative; display: flex; }
.gp-message-wrap .gp-message { padding-right: 34px; }
.gp-suggest { position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; color: var(--ah-fg3); }
.gp-suggest:hover:not(:disabled), .gp-suggest[data-busy] { color: var(--ah-accent); }
.gp-suggest[data-busy] { opacity: 1; }
.gp-pulse { animation: gp-pulse 2.2s ease-in-out infinite; }
@keyframes gp-pulse { 0%, 100% { opacity: 1; transform: none; } 50% { opacity: .55; transform: scale(.94); } }

@media (prefers-reduced-motion: reduce) {
  .gp-root *, .gp-menu, .gp-dialog, .gp-dialog-scrim, .gp-scrim, .gp-toast { animation-duration: 1ms !important; transition-duration: 1ms !important; }
  .gp-toast-ttl { display: none; }
}

/* Tree mode: folder rows */
.gp-dir { gap: 6px; }
.gp-dir .gp-file-icon { color: var(--ah-fg3); }
.gp-dir .gp-file-name { color: var(--ah-fg2); }
.gp-dir-count { flex: none; margin-left: auto; font-size: 11px; color: var(--ah-fg3); font-variant-numeric: tabular-nums; }
.gp-list .gp-dir:hover .gp-dir-count, .gp-list .gp-dir:focus-within .gp-dir-count, .gp-root[data-coarse] .gp-list .gp-dir .gp-dir-count { display: none; }
.gp-dir .gp-row-actions { margin-left: auto; }
.gp-detail-files .gp-dir { height: 28px; margin: 0 -8px; }
.gp-detail-files-head { gap: 8px; }
.gp-detail-files-head .ah-icon-btn { width: 24px; height: 24px; margin: -4px 0; }

/* Command line drawer */
.gc-drawer {
  --gc-black: var(--ah-fg3); --gc-red: #e5484d; --gc-green: #2f9e62; --gc-yellow: #c98a00; --gc-blue: #3e7cf0;
  --gc-magenta: #b55ad6; --gc-cyan: #0f9fae; --gc-white: var(--ah-fg2);
  --gc-bright-black: var(--ah-fg3); --gc-bright-red: #f2555a; --gc-bright-green: #3cb371; --gc-bright-yellow: #d9a514;
  --gc-bright-blue: #5b8ff9; --gc-bright-magenta: #c77ce0; --gc-bright-cyan: #22b8c8; --gc-bright-white: var(--ah-fg);
  --gc-fg: var(--ah-fg); --gc-bg: var(--ah-bg); --gc-prompt: var(--ah-accent);
  position: relative; flex: none; display: flex; flex-direction: column; height: 36%; min-height: 150px; max-height: 75%;
  border-top: .5px solid var(--ah-line-strong); background: color-mix(in srgb, currentColor 2.5%, var(--ah-bg));
  animation: gc-rise 180ms var(--ah-ease);
}
@keyframes gc-rise { from { transform: translateY(12px); opacity: 0; } }
.gc-grip { position: absolute; left: 0; right: 0; top: -4px; height: 8px; cursor: row-resize; z-index: 2; touch-action: none; }
.gc-grip::after {
  content: ''; position: absolute; left: 50%; top: 2px; width: 36px; height: 3px; margin-left: -18px; border-radius: 2px;
  background: var(--ah-line-strong); opacity: 0; transition: opacity 120ms ease;
}
.gc-grip:hover::after, .gp-root[data-coarse] .gc-grip::after { opacity: 1; }
.gp-root[data-coarse] .gc-grip { top: -10px; height: 20px; }
.gc-head { flex: none; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 4px 0 10px; color: var(--ah-fg2); font-size: 12px; }
.gc-head > svg { flex: none; color: var(--ah-fg3); }
.gc-title { flex: none; font-weight: 600; color: var(--ah-fg); }
.gc-context { min-width: 0; display: inline-flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; }
.gc-branch { flex: none; display: inline-flex; align-items: center; gap: 3px; padding: 0 6px; border-radius: 9px; line-height: 18px; font-size: 11px;
  background: color-mix(in srgb, var(--ah-accent) 12%, transparent); color: var(--ah-accent); font-weight: 600; }
.gc-folder { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ah-fg3); }
.gc-running { flex: none; display: inline-flex; align-items: center; gap: 5px; color: var(--ah-fg3); font-size: 11px; }
.gc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ah-add); animation: gp-breathe 2.4s ease-in-out infinite; }
.gc-stop { color: var(--ah-danger-ink); }
.gc-head .ah-icon-btn { width: 24px; height: 24px; }
.gc-output { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0; outline: none; font-size: 12px; overscroll-behavior: contain; }
.gc-line { white-space: pre; line-height: 18px; color: var(--gc-fg); padding: 0 10px; }
.gp-root[data-coarse] .gc-line { line-height: 20px; }
.gc-empty { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 6px 10px; }
.gc-hint { font-size: 12px; color: var(--ah-fg3); }
.gc-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.gc-chips .gp-chip { height: 24px; font-size: 12px; }
.gc-input-row {
  flex: none; display: flex; align-items: center; gap: 8px; margin: 4px 8px 8px; padding: 0 10px; height: 32px; border-radius: var(--ah-radius-sm);
  border: .5px solid var(--ah-line-strong); background: var(--dsw-specific-input-major, var(--ah-layer)); cursor: text;
}
.gc-input-row:focus-within { border-color: color-mix(in srgb, var(--ah-accent) 70%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ah-accent) 14%, transparent); }
.gc-prompt { flex: none; color: var(--ah-accent); font-weight: 600; white-space: nowrap; max-width: 40%; overflow: hidden; text-overflow: ellipsis; }
.gc-input { flex: 1 1 auto; min-width: 0; border: 0; outline: none; background: transparent; color: var(--ah-fg); font-size: 13px; }
.gc-input::placeholder { color: var(--ah-fg3); }
.gp-root .gc-input:focus-visible { outline: none; }
.gp-root[data-coarse] .gc-input-row { height: 40px; }
.gp-root[data-coarse] .gc-input { font-size: 16px; }
.gp-root[data-layout="overlay"] .gc-drawer { height: 42%; }

/* Terminal panel (DSH PTYs, VS Code layout) */
.gt-drawer { background: var(--ah-bg); }
.gt-head { gap: 2px; padding: 0 4px 0 4px; height: 32px; border-bottom: .5px solid var(--ah-line); }
.gt-tabs { flex: 0 1 auto; min-width: 0; display: flex; align-items: stretch; align-self: stretch; overflow-x: auto; scrollbar-width: none; }
.gt-tabs::-webkit-scrollbar { display: none; }
.gt-tab {
  position: relative; flex: none; display: inline-flex; align-items: center; gap: 5px; max-width: 180px; padding: 0 4px 0 8px;
  color: var(--ah-fg3); cursor: pointer; user-select: none; outline: none; border-radius: 0;
}
.gt-tab:hover { color: var(--ah-fg2); background: var(--ah-hover); }
.gt-tab[aria-selected="true"] { color: var(--ah-fg); }
.gt-tab[aria-selected="true"]::after { content: ""; position: absolute; left: 6px; right: 6px; bottom: 0; height: 1.5px; border-radius: 1px; background: var(--ah-accent); }
.gt-tab:focus-visible { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ah-accent) 70%, transparent); }
.gt-tab[data-drop]::before { content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px; border-radius: 1px; background: var(--ah-accent); }
.gt-tab > svg { flex: none; }
.gt-tab[data-ended] .gt-tab-title { text-decoration: line-through; opacity: .7; }
.gt-tab-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.gt-tab-close {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px;
  background: transparent; color: inherit; cursor: pointer; opacity: 0;
}
.gt-tab:hover .gt-tab-close, .gt-tab[aria-selected="true"] .gt-tab-close, .gt-tab:focus-within .gt-tab-close, .gp-root[data-coarse] .gt-tab-close { opacity: 1; }
.gt-tab-close:hover { background: var(--ah-hover); color: var(--ah-fg); }
.gt-rename {
  width: 110px; min-width: 48px; height: 20px; padding: 0 4px; font: inherit; font-size: 12px; color: var(--ah-fg);
  background: var(--ah-bg); border: .5px solid var(--ah-line-strong); border-radius: 4px; outline: none;
}
.gt-head .gt-shell-btn { width: 18px; }
.gt-tab-count {
  flex: none; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px; font-size: 10px; line-height: 15px; text-align: center;
  font-variant-numeric: tabular-nums; color: inherit; background: color-mix(in srgb, currentColor 12%, transparent);
}
.gt-body { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.gt-pane { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
/* Split panes: side by side, stacked when the panel is too narrow (see SplitPanes). */
.gt-split { flex: 1 1 auto; min-height: 0; display: flex; }
.gt-split[data-axis="column"] { flex-direction: column; }
.gt-split[data-dragging] { user-select: none; }
.gt-split[data-dragging] .gt-screen { pointer-events: none; }
.gt-cell { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.gt-sash { position: relative; z-index: 1; flex: none; width: 1px; background: var(--ah-line); cursor: col-resize; touch-action: none; outline: none; }
.gt-split[data-axis="column"] > .gt-sash { width: auto; height: 1px; cursor: row-resize; }
/* A wider grip than the line; the accent shows after a short hover, as in VS Code, at once while dragged or focused. */
.gt-sash::before { content: ""; position: absolute; inset: 0 -3px; }
.gt-sash::after { content: ""; position: absolute; inset: 0 -1px; background: var(--ah-accent); opacity: 0; transition: opacity 120ms ease; }
.gt-split[data-axis="column"] > .gt-sash::before { inset: -3px 0; }
.gt-split[data-axis="column"] > .gt-sash::after { inset: -1px 0; }
.gt-sash:hover::after { opacity: 1; transition-delay: 200ms; }
.gt-sash:active::after, .gt-sash:focus-visible::after { opacity: 1; transition-delay: 0s; }
.gp-root[data-coarse] .gt-sash::before { inset: 0 -10px; }
.gp-root[data-coarse] .gt-split[data-axis="column"] > .gt-sash::before { inset: -10px 0; }
.gt-pane-head {
  flex: none; display: flex; align-items: center; gap: 5px; height: 24px; padding: 0 3px 0 10px; font-size: 12px;
  color: var(--ah-fg3); border-bottom: .5px solid var(--ah-line); transition: color 120ms ease;
}
.gt-pane-head > svg { flex: none; }
.gt-cell[data-focused] .gt-pane-head { color: var(--ah-fg); box-shadow: inset 0 -1.5px 0 var(--ah-accent); }
.gt-pane-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-pane-head[data-ended] .gt-pane-title { text-decoration: line-through; opacity: .7; }
.gt-pane-btn {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px;
  background: transparent; color: inherit; cursor: pointer; opacity: 0; transition: opacity 120ms ease;
}
.gt-cell:hover .gt-pane-btn, .gt-pane-head:focus-within .gt-pane-btn, .gp-root[data-coarse] .gt-pane-btn { opacity: 1; }
.gt-pane-btn:hover:not(:disabled) { background: var(--ah-hover); color: var(--ah-fg); }
.gt-pane-btn:disabled { opacity: .35 !important; cursor: default; }
.gt-pane-btn:focus-visible { outline: 1.5px solid color-mix(in srgb, var(--ah-accent) 70%, transparent); outline-offset: -1.5px; }
.gp-root[data-coarse] .gt-pane-head { height: 34px; }
.gp-root[data-coarse] .gt-pane-btn { width: 32px; height: 32px; }
@media (prefers-reduced-motion: reduce) { .gt-sash::after, .gt-pane-btn, .gt-pane-head { transition: none; } }
.gt-pane[hidden] { display: none; }
.gt-status { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 4px 10px; font-size: 12px; color: var(--ah-fg2); background: var(--ah-layer); }
.gt-error { flex: none; margin: 0; padding: 8px 10px; font-size: 12px; color: var(--ah-fg); background: var(--ah-layer); overflow-wrap: anywhere; }
.gt-screen { flex: 1 1 auto; min-width: 0; min-height: 0; padding: 4px 0 2px 10px; overflow: hidden; color: var(--ah-fg); background: var(--ah-bg); touch-action: none; overscroll-behavior: contain; }
.gt-screen .xterm { height: 100%; }
.gt-screen .xterm-viewport { background: var(--ah-bg) !important; }
/* xterm blinks on a fixed 1s cycle; a calmer 1.6s (0.8s on, 0.8s off). */
.gt-screen .xterm-cursor.xterm-cursor-blink { animation-duration: 1.6s !important; }

/* Finished-task notices, over the whole window: bottom right; on a phone, across the top. */
.gt-notices {
  position: fixed; z-index: var(--ah-z-float); right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); width: min(360px, calc(100vw - 32px));
  display: flex; flex-direction: column; gap: 8px; pointer-events: none;
  font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.45;
}
.gt-notice {
  pointer-events: auto; display: flex; align-items: center; gap: 8px; min-height: 40px; box-sizing: border-box; padding: 6px 6px 6px 12px;
  border-radius: var(--ah-radius); background: var(--dsw-specific-menu, var(--ah-popup)); color: var(--ah-fg);
  /* DSH's menu surface is translucent and meant to be read over a blur, as its menus are. */
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(24px)); backdrop-filter: var(--dsw-menu-backdrop-filter, blur(24px));
  box-shadow: var(--ah-shadow), 0 0 0 .5px var(--ah-line);
  animation: gt-notice-in 220ms var(--ah-ease);
}
.gt-notice-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.gt-notice-title, .gt-notice-session { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-notice-title { font-weight: 600; }
.gt-notice-session { font-size: 12px; color: var(--ah-fg3); }
.gt-notices .gt-notice-view { flex: none; height: 28px; padding: 0 10px; color: var(--ah-info-ink); font-weight: 600; font-size: inherit; }
.gt-notices .gt-notice-close { flex: none; width: 28px; height: 28px; }
.gt-notices button:focus-visible { outline: 2px solid color-mix(in srgb, var(--ah-accent) 70%, transparent); outline-offset: -2px; }
@keyframes gt-notice-in { from { opacity: 0; transform: translateY(8px); } }
@media (max-width: 640px) {
  .gt-notices { left: 12px; right: 12px; width: auto; bottom: auto; top: calc(12px + env(safe-area-inset-top)); }
  .gt-notice { animation-name: gt-notice-drop; }
}
@keyframes gt-notice-drop { from { opacity: 0; transform: translateY(-8px); } }
@media (pointer: coarse) {
  .gt-notice { min-height: 48px; }
  .gt-notices .gt-notice-view, .gt-notices .gt-notice-close { height: 40px; }
  .gt-notices .gt-notice-close { width: 40px; }
}
@media (prefers-reduced-motion: reduce) { .gt-notice { animation: none; } }

/* Diff stage: over the middle column */
.gs-stage {
  position: absolute; z-index: 1; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden;
  background: var(--dsw-alias-bg-base, Canvas); border-radius: var(--dsh-windows-content-radius, 0) 0 0 0;
  box-shadow: inset .5px 0 0 var(--ah-line);
  animation: gs-in 170ms var(--ah-ease);
}
.gs-stage[data-full] { border-radius: 0; box-shadow: none; animation-name: gs-in-full; }
@keyframes gs-in { from { opacity: 0; transform: translateY(6px); } }
@keyframes gs-in-full { from { opacity: 0; transform: translateY(24px); } }
.gs-context {
  flex: none; display: flex; align-items: center; gap: 10px; height: 28px; padding: 0 12px 0 14px; box-sizing: border-box;
  border-bottom: .5px solid var(--ah-line); font-size: 12px; color: var(--ah-fg3); white-space: nowrap;
}
.gs-context-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ah-fg2); }
.gs-hint { flex: none; margin-left: auto; }
.gs-stage[data-coarse] .gs-hint { display: none; }
.gs-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.gs-stage .gp-panel-head { padding-left: 8px; }
.gs-stage[data-full] .gp-panel-head { padding-top: env(safe-area-inset-top); height: calc(38px + env(safe-area-inset-top)); }

/* Inline commit details (Git Graph's commit view), expanded under the row */
.gi-wrap { box-sizing: border-box; padding: 4px 8px 10px 0; container-type: inline-size; }
.gi-lanes { position: absolute; left: 0; top: 0; height: 100%; overflow: visible; }
.gi-card {
  position: relative; display: grid; grid-template-columns: minmax(0, 1fr); border-radius: 10px; overflow: hidden;
  border: .5px solid var(--ah-line-strong); background: color-mix(in srgb, currentColor 2.5%, var(--ah-bg));
  box-shadow: 0 1px 3px rgb(0 0 0 / .06); animation: gi-open 180ms var(--ah-ease);
}
@keyframes gi-open { from { opacity: 0; transform: translateY(-4px); } }
.gi-tools { position: absolute; top: 5px; right: 5px; z-index: 1; display: flex; gap: 0; }
.gi-tools .ah-icon-btn { width: 24px; height: 24px; }
.gi-meta { position: relative; min-width: 0; max-height: 210px; overflow: auto; padding: 10px 64px 12px 14px; box-sizing: border-box; overscroll-behavior: contain; }
.gi-subject { font-weight: 600; font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; margin-bottom: 4px; }
.gi-body { margin: 0 0 6px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 13px; color: var(--ah-fg2); }
.gi-refs { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 6px; }
.gi-fields { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 12px; margin: 8px 0 0; font-size: 12px; line-height: 20px; }
.gi-fields dt { color: var(--ah-fg3); white-space: nowrap; }
.gi-fields dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.gi-ids { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; margin: 0 0 10px; }
.gi-id { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.gi-id-label { font-size: 11px; font-weight: 500; color: var(--ah-fg3); white-space: nowrap; }
.gi-parent { display: inline-flex; align-items: center; }
.gi-hash {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 7px; border: 0; border-radius: 5px; cursor: pointer;
  background: color-mix(in srgb, currentColor 7%, transparent); color: var(--ah-fg); font-size: 12px; letter-spacing: .01em;
  transition: background-color 120ms var(--ah-ease), color 120ms var(--ah-ease);
}
.gi-hash:hover { background: color-mix(in srgb, var(--ah-accent) 16%, transparent); }
.gi-hash:focus-visible, .gi-jump:focus-visible { outline: 2px solid var(--ah-accent); outline-offset: 1px; }
.gi-hash svg { opacity: .6; flex: none; }
.gi-hash[data-copied] { color: var(--ah-accent); }
.gi-hash[data-copied] svg { opacity: 1; }
.gi-parent .gi-hash { border-radius: 5px 0 0 5px; }
.gi-jump {
  display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; cursor: pointer;
  border-left: .5px solid color-mix(in srgb, currentColor 12%, transparent); border-radius: 0 5px 5px 0;
  background: color-mix(in srgb, currentColor 7%, transparent); color: var(--ah-fg2); transition: background-color 120ms var(--ah-ease);
}
.gi-jump:hover { background: color-mix(in srgb, var(--ah-accent) 16%, transparent); color: var(--ah-fg); }
.gp-root[data-coarse] .gi-hash { height: 32px; padding: 0 10px; }
.gp-root[data-coarse] .gi-jump { width: 32px; height: 32px; }
.gi-foot { margin-top: 12px; padding-top: 8px; border-top: .5px solid var(--ah-line); color: var(--ah-fg2); }
.gi-action { margin-top: 10px; }
.gi-files { min-width: 0; display: flex; flex-direction: column; max-height: 260px; border-top: .5px solid var(--ah-line); }
.gi-files-head { flex: none; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 6px 0 12px; font-size: 12px; font-weight: 600; color: var(--ah-fg2); }
.gi-files-head .ah-icon-btn { width: 24px; height: 24px; }
.gi-files-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 0 6px; overscroll-behavior: contain; }
.gi-group { display: flex; align-items: center; gap: 6px; padding: 6px 12px 2px; font-size: 11px; font-weight: 600; color: var(--ah-fg3); }
.gi-file { height: 26px; margin: 0 4px; padding-left: 8px; }
.gp-root[data-coarse] .gi-file { height: 36px; }
@container (min-width: 620px) {
  .gi-card { grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); }
  .gi-meta { max-height: 300px; padding-right: 14px; border-right: .5px solid var(--ah-line); }
  .gi-files { max-height: 300px; border-top: 0; }
  .gi-files-head { padding-right: 62px; }
}
`

let installed = 0
let tag: HTMLStyleElement | undefined

export function injectGitStyle(): () => void {
  if (installed++ === 0) {
    tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-agent-hub'
    tag.dataset.pluginCss = 'dsh-agent-hub/git'
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
