/**
 * Board stylesheet, `ab-` prefixed, on the shared tokens and controls of
 * theme/base.ts; layout follows the page's own width (the middle column), not
 * the window's.
 */

const CSS = `
.ab-page {
  position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;
  color: var(--ah-fg); font-size: 13px; line-height: 20px; container-type: inline-size;
}
.ab-grow { flex: 1; }
.ab-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 14px 20px 10px; }
.ab-select, .ab-search, .ab-input {
  box-sizing: border-box; min-width: 0; height: 30px; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--ah-line);
  background: transparent; color: inherit; font: inherit; font-size: 12px;
}
.ab-select { max-width: 200px; cursor: pointer; padding-right: 6px; }
.ab-select option, .ab-select optgroup { color: var(--ah-fg); background: var(--ah-layer); }
/* The search: the bar's widest part, its icon inside. */
.ab-search-wrap { position: relative; display: flex; align-items: center; flex: 1 1 240px; max-width: 440px; min-width: 0; }
.ab-search-wrap > svg { position: absolute; left: 10px; color: var(--ah-fg3); pointer-events: none; }
.ab-search { width: 100%; padding-left: 30px; text-overflow: ellipsis; }
.ab-bar > .ah-icon-btn { margin-left: auto; }
.ab-sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.ab-input { width: 100%; height: auto; font-size: 13px; line-height: 20px; resize: vertical; }
.ab-select:focus-visible, .ab-search:focus, .ab-input:focus { outline: none; border-color: color-mix(in srgb, currentColor 40%, transparent); }
.ah-icon-btn.ah-icon-sm { width: 24px; height: 24px; }
.ab-page .ah-icon-btn[data-busy] svg { animation: ab-spin 1.6s linear infinite; }
@keyframes ab-spin { to { transform: rotate(360deg); } }
.ab-card:focus-visible, .ab-link:focus-visible, .ab-tabs button:focus-visible, .ab-col-folded:focus-visible, .ab-menu button:focus-visible {
  outline: 2px solid var(--ah-focus); outline-offset: 1px;
}
.ab-link {
  appearance: none; border: none; background: none; padding: 0 2px; margin-left: 6px; color: inherit; font: inherit; font-size: 12px;
  text-decoration: underline; text-underline-offset: 2px; color: var(--ah-fg2); cursor: pointer;
}
.ab-link:hover { color: var(--ah-fg); }
.ab-hint, .ab-muted { color: var(--ah-fg2); font-size: 12px; }
.ab-hint-bar, .ab-banner {
  display: flex; align-items: center; gap: 6px; margin: 0 20px 8px; padding: 8px 12px; border-radius: var(--ah-radius); font-size: 12px; line-height: 18px;
  background: var(--ah-soft);
}
.ab-banner { color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 9%, transparent); }
.ab-loading { margin: 24px 20px; color: var(--ah-fg2); animation: ab-appear 400ms ease 300ms both; }
@keyframes ab-appear { from { opacity: 0; } }
/* Linear's mark, in Linear's colour. */
.ab-mark { flex: none; color: var(--ah-stage-completed); }

/* Columns, by zone */
.ab-columns {
  flex: 1; min-height: 0; display: flex; gap: 20px; padding: 4px 20px 20px; overflow-x: auto; overflow-y: hidden;
  scroll-snap-type: x proximity; scroll-padding: 0 20px; overscroll-behavior-x: contain;
  /* The alerts and review lanes arrive after the stages, in front of them: anchoring would scroll them out of view to the left. */
  overflow-anchor: none;
}
.ab-col {
  flex: 1 0 248px; max-width: 360px; min-width: 0; display: flex; flex-direction: column; min-height: 0; scroll-snap-align: start;
  border-radius: var(--ah-radius-lg); background: var(--ah-soft); border: 1px solid transparent; transition: border-color 120ms ease, background-color 120ms ease;
}
/*
 * A zone: one service's columns under its head. Both rows of every head are one height, so the
 * filters line up across the zones; the line under the name, in the zone's colour, spans its columns.
 * Each zone is as wide as its columns at their least: its contents never size it.
 */
.ab-page { --ab-zone-row: 28px; }
.ab-zone { --ab-zone-accent: var(--ah-fg3); flex: 1 0 248px; display: flex; flex-direction: column; min-width: 0; min-height: 0; max-width: 360px; container-type: inline-size; }
.ab-zone[data-zone="alerts"] { --ab-zone-accent: #7c6fde; flex-basis: 300px; max-width: 340px; animation: ab-appear 200ms ease-out both; }
.ab-zone[data-zone="review"] { --ab-zone-accent: var(--ah-mine); }
.ab-zone[data-zone="linear"] { --ab-zone-accent: var(--ah-stage-completed); }
.ab-zone[data-zone="linear"], .ab-zone[data-zone="local"] { max-width: none; }
.ab-zone[data-folded] { flex: 0 0 40px; }
.ab-zone-cols { flex: 1; min-height: 0; display: flex; gap: 12px; }
.ab-zone-head { flex: none; display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 0 2px 8px; }
.ab-zone-title {
  display: flex; align-items: center; gap: 6px; min-width: 0; height: var(--ab-zone-row); padding: 0 2px 4px;
  border-bottom: 1.5px solid color-mix(in srgb, var(--ab-zone-accent) 45%, transparent);
}
.ab-zone-title h3 { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 20px; font-weight: 600; }
.ab-zone-mark { flex: none; color: var(--ab-zone-accent); }
.ab-zone[data-zone="review"] .ab-zone-mark, .ab-zone[data-zone="local"] .ab-zone-mark { color: var(--ah-fg2); }
.ab-zone[data-folded] .ab-zone-title { justify-content: center; padding-inline: 0; }
.ab-zone-tools { display: flex; align-items: center; gap: 6px; min-width: 0; height: var(--ab-zone-row); }
.ab-zone-tools > * { min-width: 0; }
.ab-zone-title .ab-new { flex: none; gap: 4px; height: 24px; padding: 0 9px; font-size: 12px; }
/* Reading GitHub again stands apart from what acts on the pull requests. */
.ab-zone-title .rv-sync { margin-right: 4px; }
.ab-zone-title .aa-bot { width: 96px; max-width: 40cqw; height: 24px; padding-block: 0; font-size: 11px; }
.ab-zone-tools .rv-scope { display: flex; width: 100%; }
.ab-zone-tools .rv-scope > button { flex: 1 1 0; min-height: 0; font-size: 12px; }
.ab-zone-tools .aa-tools { display: flex; align-items: center; gap: 6px; width: 100%; padding: 0; }
.ab-zone-tools .aa-tools > .ah-seg { flex: none; }
.ab-zone-tools .aa-sort-row { display: flex; flex: 1; gap: 2px; min-width: 0; }
.ab-zone-tools .aa-sort { flex: 1; min-height: 26px; }
.ab-zone-tools .aa-progress { left: 0; right: 0; bottom: -5px; }
.ab-zone-note { display: flex; align-items: center; gap: 2px; min-width: 0; margin: 0; font-size: 12px; color: var(--ah-fg2); }
.ab-zone-note-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@container (max-width: 224px) {
  .rv-scope-n { display: none; }
}
/* A zone's first read: its place held, its cards in outline; the cards fade in when they come. */
.ab-skeleton { display: flex; flex-direction: column; gap: 8px; }
.ab-skeleton-card, .ab-skeleton-bar {
  border-radius: var(--ah-radius); background: linear-gradient(90deg, var(--ah-soft) 25%, color-mix(in srgb, currentColor 8%, transparent) 50%, var(--ah-soft) 75%) 0 0 / 200% 100%;
  animation: ab-shimmer 1.2s linear infinite;
}
.ab-skeleton-card { height: 96px; border: 1px solid var(--ah-line); }
.ab-skeleton-card:nth-child(2) { opacity: .7; }
.ab-skeleton-card:nth-child(3) { opacity: .45; }
.ab-skeleton-bar { display: block; width: 70%; height: 20px; }
@keyframes ab-shimmer { to { background-position: -200% 0; } }
.aa-list > .aa-card { animation: ab-rise-in 180ms ease-out both; }
.aa-list > .aa-card:nth-child(2) { animation-delay: 30ms; }
.aa-list > .aa-card:nth-child(3) { animation-delay: 60ms; }
.aa-list > .aa-card:nth-child(n + 4) { animation-delay: 90ms; }
@keyframes ab-rise-in { from { opacity: 0; transform: translateY(4px); } }
/* Narrow: a column's zone filters atop it, staying in view as it scrolls. */
.ab-lane-bar {
  position: sticky; top: 0; z-index: 2; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: -4px -12px 0; padding: 8px 12px;
  background: var(--ah-layer); border-bottom: 1px solid var(--ah-line);
}
.ab-lane-bar > .aa-tools { width: 100%; padding: 0; }
.ab-col[data-drop] { border-color: color-mix(in srgb, currentColor 30%, transparent); border-style: dashed; background: color-mix(in srgb, currentColor 7%, transparent); }
.ab-col[data-folded] { flex: 0 0 40px; }
.ab-col-folded {
  appearance: none; display: flex; flex-direction: column; align-items: center; gap: 8px; width: 100%; height: 100%; padding: 12px 0;
  border: none; border-radius: var(--ah-radius-lg); background: transparent; color: var(--ah-fg2); font: inherit; font-size: 12px; cursor: pointer;
}
.ab-col-folded:hover { color: var(--ah-fg); background: var(--ah-soft); }
.ab-col-folded-name { writing-mode: vertical-rl; letter-spacing: .05em; }
.ab-col-head { display: flex; align-items: center; gap: 6px; padding: 10px 8px 6px 12px; }
.ab-col-head h3 { margin: 0; font-size: 12px; line-height: 18px; font-weight: 600; }
.ab-count { font-size: 11px; color: var(--ah-fg3); font-variant-numeric: tabular-nums; }
.ab-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; box-sizing: border-box; }
[data-stage="backlog"] .ab-dot, .ab-dot[data-stage="backlog"] { border: 1.5px dashed var(--ah-stage-backlog); }
[data-stage="unstarted"] .ab-dot, .ab-dot[data-stage="unstarted"] { border: 1.5px solid var(--ah-stage-unstarted); }
[data-stage="started"] .ab-dot, .ab-dot[data-stage="started"] { border: 1.5px solid var(--ah-stage-started); background: linear-gradient(90deg, var(--ah-stage-started) 50%, transparent 50%); }
[data-stage="completed"] .ab-dot, .ab-dot[data-stage="completed"] { background: var(--ah-stage-completed); }
[data-stage="canceled"] .ab-dot, .ab-dot[data-stage="canceled"] { background: var(--ah-stage-canceled); }
.ab-col-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 2px 8px 10px; }
/* A full column scrolls; its cards never squeeze (a clamped title would let them, cutting it off) */
.ab-col-body > * { flex-shrink: 0; }
.ab-empty { margin: 8px 4px; font-size: 12px; color: var(--ah-fg3); text-align: center; }

/* Cards */
.ab-card {
  display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: var(--ah-radius); cursor: pointer; user-select: none;
  background: var(--ah-layer); border: 1px solid var(--ah-line); box-shadow: 0 1px 2px rgba(0, 0, 0, .04);
  transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}
.ab-card:hover { border-color: color-mix(in srgb, currentColor 22%, transparent); box-shadow: 0 2px 6px rgba(0, 0, 0, .07); }
.ab-card:active { cursor: grabbing; }
.ab-card[data-selected] { border-color: color-mix(in srgb, currentColor 45%, transparent); }
/* The cards linked to the one under the pointer: a pull request, its Linear ticket and its Sentry issues, across the columns */
.ab-card[data-pair] {
  border-color: color-mix(in srgb, var(--ah-stage-completed) 60%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ah-stage-completed) 16%, transparent), 0 2px 6px rgba(0, 0, 0, .07);
}
@media (prefers-reduced-motion: reduce) { .ab-card { transition: none; } }
[data-stage="completed"] .ab-card-title, [data-stage="canceled"] .ab-card-title { color: var(--ah-fg2); }
[data-stage="canceled"] .ab-card-title { text-decoration: line-through; }
.ab-card-top { display: flex; align-items: center; gap: 6px; min-height: 18px; }
.ab-id { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 16px; color: var(--ah-fg3); font-variant-numeric: tabular-nums; }
.ab-id[data-local] { padding: 0 6px; border-radius: var(--ah-radius-sm); background: color-mix(in srgb, currentColor 8%, transparent); color: var(--ah-fg2); }
.ab-prio { flex: none; color: var(--ah-fg2); }
.ab-prio[data-urgent] {
  display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 4px;
  background: color-mix(in srgb, var(--ah-danger) 85%, #000); color: #fff; font-size: 10px; font-weight: 700; line-height: 1;
}
.ab-card-title {
  margin: 0; font-size: 13px; line-height: 19px; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.ab-card-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.ab-chip {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 0 6px; border-radius: 6px; font-size: 11px; line-height: 18px;
  background: color-mix(in srgb, currentColor 7%, transparent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ab-chip[data-tree] { color: var(--ah-ok-ink); background: color-mix(in srgb, var(--ah-ok) 12%, transparent); }
.ab-chip[data-muted] { color: var(--ah-fg2); }
a.ab-chip { color: inherit; text-decoration: none; }
.ab-chip[data-pr] { color: var(--ah-mine-ink); background: color-mix(in srgb, var(--ah-mine) 12%, transparent); }
a.ab-chip[data-pr]:hover { text-decoration: underline; }
.ab-chip[data-project] { max-width: 160px; }
.ab-chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ab-chip[data-project][aria-pressed="true"] { color: var(--ah-fg); background: color-mix(in srgb, currentColor 14%, transparent); }
/* A project's colour (Linear's, else from its name), beside its name: never the colour alone. */
.ab-pdot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ab-pc); box-shadow: inset 0 0 0 1px color-mix(in srgb, #000 12%, transparent); }
.ab-chip svg { flex: none; }
button.ab-chip { border: 0; font: inherit; color: inherit; cursor: pointer; }
button.ab-chip[data-tree] { color: var(--ah-ok-ink); }
button.ab-chip:hover { filter: brightness(.92); text-decoration: underline; }
.ab-chip[data-busy]::before {
  content: ''; flex: none; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid currentColor; border-right-color: transparent;
  animation: ab-spin 800ms linear infinite;
}
@keyframes ab-spin { to { transform: rotate(360deg); } }
/* Start on the card: shown on hover or focus where there is a pointer, always on touch. */
.ab-go-wrap { position: relative; flex: none; }
.ab-go {
  display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: var(--ah-radius-sm); border: 1px solid var(--ah-line);
  background: var(--ah-layer); color: inherit; font: inherit; font-size: 11px; cursor: pointer; opacity: 0; transition: opacity 120ms ease;
}
.ab-go:hover { background: var(--ah-soft); }
.ab-card:hover .ab-go, .ab-card:focus-within .ab-go, .ab-go[aria-expanded="true"] { opacity: 1; }
@media (hover: none) { .ab-go { opacity: 1; } }
.ab-menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 5; min-width: 160px; max-width: 260px; padding: 4px; border-radius: var(--ah-radius);
  background: var(--ah-popup); border: 1px solid var(--ah-line); box-shadow: var(--ah-shadow); display: flex; flex-direction: column;
}
.ab-menu-title { padding: 4px 8px; font-size: 11px; color: var(--ah-fg2); }
.ab-menu button {
  text-align: left; padding: 6px 8px; border: 0; border-radius: var(--ah-radius-sm); background: transparent; color: inherit; font: inherit; font-size: 12px;
  cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ab-menu button:hover { background: var(--ah-hover); }
.ab-avatar {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%;
  font-size: 10px; font-weight: 600; background: color-mix(in srgb, currentColor 14%, transparent);
}

/* New ticket: the detail's panel, the card before it exists */
/* As tall as what is in it, the board still in view below. */
.ab-detail[data-new] { width: min(460px, calc(100% - 16px)); bottom: auto; max-height: calc(100% - 16px); }
.ab-new-heading { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--ah-fg2); }
.ab-target > button { display: inline-flex; align-items: center; gap: 5px; }
.ab-draft { gap: 12px; }
.ab-detail .ab-new-title { field-sizing: content; min-height: 34px; max-height: 120px; margin: 0; padding: 4px 10px; }
.ab-new-title::placeholder, .ab-new-note::placeholder { color: var(--ah-fg3); }
.ab-new-note { field-sizing: content; min-height: 120px; max-height: 45vh; resize: none; padding: 8px 10px; border-color: transparent; background: var(--ah-soft); }
.ab-new-note:focus { background: transparent; }
.ab-new-bot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: -4px; }
.ab-new-bot .ab-select { flex: 0 1 220px; }
.ab-new-bot .ab-link { margin-left: 2px; }
.ab-new-props { display: flex; flex-wrap: wrap; gap: 6px; }
.ab-pick-wrap { position: relative; min-width: 0; max-width: 100%; }
.ab-pchip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 28px; padding: 0 10px; border-radius: 14px;
  border: 1px solid var(--ah-line); background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.ab-pchip:hover:not(:disabled):not([data-static]) { background: var(--ah-soft); border-color: color-mix(in srgb, currentColor 22%, transparent); }
.ab-pchip[aria-expanded="true"] { background: var(--ah-soft); border-color: color-mix(in srgb, currentColor 40%, transparent); }
.ab-pchip[data-empty] { color: var(--ah-fg2); border-style: dashed; }
.ab-pchip[data-static] { cursor: default; color: var(--ah-fg2); }
.ab-pchip:disabled { opacity: .5; cursor: default; }
.ab-pchip:focus-visible, .ab-pick button:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; }
.ab-pchip-text { min-width: 0; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ab-pchip > svg, .ab-pchip > .ab-dot, .ab-pchip > .ab-avatar, .ab-pchip > .ab-prio { flex: none; }
.ab-pick { left: 0; right: auto; width: 260px; max-width: calc(100vw - 16px); z-index: 7; gap: 2px; }
.ab-pick-search { height: 30px; margin: 0 0 4px; font-size: 12px; }
.ab-pick-list { max-height: 280px; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; }
.ab-pick-item { display: contents; }
.ab-pick-group { padding: 6px 8px 2px; font-size: 11px; color: var(--ah-fg3); }
.ab-menu.ab-pick button { display: flex; align-items: center; gap: 8px; flex: none; }
.ab-menu.ab-pick button[data-active] { background: var(--ah-hover); }
.ab-pick-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ab-pick-check { flex: none; color: var(--ah-fg2); }
.ab-pick-empty { padding: 6px 8px; font-size: 12px; color: var(--ah-fg3); }
.ab-pick-hint { flex: none; display: inline-flex; align-items: center; gap: 6px; }
.ab-pick-foot {
  display: block; margin-top: 4px; padding: 8px 8px 4px; border-top: 1px solid var(--ah-line); font-size: 12px; color: var(--ah-fg2); text-decoration: none;
}
.ab-pick-foot:hover { color: var(--ah-fg); text-decoration: underline; text-underline-offset: 2px; }
.ab-pick-foot:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; border-radius: var(--ah-radius-sm); }
/* The bar's project filter: a control like the repository's, emphasised while it filters. */
.ab-pfilter { display: inline-flex; align-items: center; gap: 2px; min-width: 0; }
.ab-bar .ab-pchip { height: 30px; border-radius: 8px; }
.ab-bar .ab-pchip[data-empty] { color: inherit; border-style: solid; }
.ab-pfilter .ab-pchip-text { max-width: 160px; }
.ab-pfilter[data-active] .ab-pchip { background: var(--ah-soft); border-color: color-mix(in srgb, currentColor 40%, transparent); font-weight: 500; }
.ab-progress { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.ab-progress-bar { flex: none; display: inline-block; width: 28px; height: 4px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, currentColor 14%, transparent); }
.ab-progress-bar > span { display: block; height: 100%; border-radius: inherit; background: var(--ah-stage-started); }
.ab-new-error {
  margin: 0; padding: 6px 10px; border-radius: var(--ah-radius); font-size: 12px; line-height: 18px;
  color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 9%, transparent);
}
.ab-keys { font-size: 11px; color: var(--ah-fg3); }
.ab-spin {
  display: inline-block; width: 10px; height: 10px; border-radius: 50%; box-sizing: border-box; vertical-align: -1px;
  border: 1.5px solid currentColor; border-right-color: transparent; animation: ab-spin 800ms linear infinite;
}

/* Detail */
.ab-scrim { position: absolute; inset: 0; z-index: 4; background: transparent; }
.ab-detail {
  position: absolute; z-index: 5; top: 8px; right: 8px; bottom: 8px; width: min(400px, calc(100% - 16px));
  display: flex; flex-direction: column; border-radius: var(--ah-radius-lg); outline: none;
  background: var(--ah-layer); border: 1px solid var(--ah-line); box-shadow: 0 12px 32px rgba(0, 0, 0, .18);
  animation: ab-slide 180ms var(--ah-ease);
}
@keyframes ab-slide { from { transform: translateX(16px); opacity: 0; } }
.ab-detail-head { display: flex; align-items: center; gap: 6px; padding: 10px 10px 6px 16px; }
.ab-detail-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding: 4px 16px 16px; }
.ab-detail-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; word-break: break-word; }
.ab-title-input {
  box-sizing: border-box; width: 100%; padding: 4px 6px; margin: 0 -6px; border: 1px solid transparent; border-radius: 8px; resize: none;
  background: transparent; color: inherit; font: inherit; font-size: 16px; line-height: 24px; font-weight: 600;
}
.ab-title-input:hover { border-color: var(--ah-line); }
.ab-title-input:focus { outline: none; border-color: color-mix(in srgb, currentColor 40%, transparent); }
.ab-props { display: grid; grid-template-columns: 72px 1fr; align-items: center; gap: 8px 12px; margin: 0; font-size: 12px; }
.ab-props dt { color: var(--ah-fg2); }
.ab-props dd { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ab-props .ab-select { max-width: 100%; }
.ab-prio-cell { display: inline-flex; align-items: center; gap: 6px; }
/* Detail: the ticket's project */
.ab-props .ab-dt-top { align-self: start; line-height: 20px; }
.ab-project { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ab-project-line { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 20px; }
.ab-project-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: inherit; text-decoration: none; }
a.ab-project-name:hover { text-decoration: underline; text-underline-offset: 2px; }
a.ab-project-name:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; border-radius: var(--ah-radius-sm); }
.ab-project-line .ab-link { flex: none; margin-left: 0; }
.ab-project-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; font-size: 11px; line-height: 16px; color: var(--ah-fg2); }
.ab-project-status { display: inline-flex; align-items: center; gap: 5px; }
.ab-project-summary {
  margin: 0; font-size: 12px; line-height: 18px; color: var(--ah-fg2); white-space: normal;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.ab-code { font-family: var(--ah-mono); font-size: 11px; padding: 1px 5px; border-radius: var(--ah-radius-sm); background: var(--ah-soft); }
.ab-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.ab-field > span { color: var(--ah-fg2); }
/* Detail: pull requests, description, activity */
.ab-section { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.ab-section-head { display: flex; align-items: center; gap: 6px; min-height: 24px; }
.ab-section-head h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--ah-fg2); }
.ab-labels { display: flex; flex-wrap: wrap; gap: 4px; }
.ab-prs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.ab-prs a {
  display: flex; align-items: baseline; gap: 6px; padding: 6px 8px; border-radius: var(--ah-radius); border: 1px solid var(--ah-line);
  color: inherit; text-decoration: none; min-width: 0;
}
.ab-prs a:hover { background: var(--ah-soft); }
.ab-pr-label { flex: none; color: var(--ah-mine-ink); font-variant-numeric: tabular-nums; }
.ab-pr-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ah-fg2); }
.ab-text { margin: 0; white-space: pre-wrap; word-break: break-word; line-height: 18px; }
.ab-text[data-clamped] { display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden; }
.ab-timeline { list-style: none; margin: 0; padding: 0 0 0 4px; display: flex; flex-direction: column; }
.ab-event { position: relative; display: flex; flex-direction: column; gap: 2px; padding: 0 0 12px 18px; }
.ab-event::before { content: ''; position: absolute; left: 3.5px; top: 12px; bottom: 0; width: 1px; background: var(--ah-line); }
.ab-event:last-child::before { display: none; }
.ab-event > .ab-dot { position: absolute; left: 0; top: 6px; }
.ab-event[data-kind="comment"] > .ab-dot, .ab-event[data-kind="created"] > .ab-dot { background: color-mix(in srgb, currentColor 30%, transparent); }
.ab-event-line { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.ab-event-time { margin-left: auto; font-size: 11px; color: var(--ah-fg3); white-space: nowrap; font-variant-numeric: tabular-nums; }
.ab-comment { margin: 2px 0 0; padding: 6px 8px; border-radius: var(--ah-radius); background: var(--ah-soft); }
.ab-event[data-reply] .ab-comment { margin-left: 8px; border-left: 2px solid var(--ah-line); }
.ab-detail-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--ah-line); }
.ab-start { display: flex; align-items: center; gap: 6px; min-width: 0; }

/* Sentry alerts: dense evidence-first cards and one calm accent. */
.aa-col { flex-basis: 300px; max-width: 340px; }
.aa-tools { position: relative; display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 10px; }
/* A filter switch shows at once: a thin bar under the filters and the old list dimmed, both delayed so a cached switch never flickers. */
.aa-progress { position: absolute; left: 10px; right: 10px; bottom: 0; height: 2px; overflow: hidden; border-radius: 1px; opacity: 0; pointer-events: none; transition: opacity 150ms ease; }
.aa-progress::after { content: ''; position: absolute; inset: 0; width: 35%; border-radius: inherit; background: #7c6fde; animation: aa-indeterminate 1.1s ease-in-out infinite; }
.aa-tools[data-busy] .aa-progress { opacity: 1; transition-delay: 120ms; }
@keyframes aa-indeterminate { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
.aa-sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.aa-tools .ah-seg { min-width: 0; }
.aa-bot { width: 108px; max-width: 108px; height: 28px; padding-block: 2px; }
.aa-sort-row { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
.aa-sort { appearance: none; display: flex; justify-content: center; align-items: center; gap: 4px; min-height: 28px; border: 0; border-radius: 7px; color: var(--ah-fg2); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
.aa-sort:hover, .aa-sort[aria-pressed="true"] { color: var(--ah-fg); background: color-mix(in srgb, currentColor 7%, transparent); }
.aa-nomatch { display: flex; flex-direction: column; align-items: center; gap: 6px; margin: 16px 8px; padding: 16px 12px; border: 1px dashed var(--ah-line); border-radius: var(--ah-radius); }
.aa-nomatch > p { margin: 0; overflow-wrap: anywhere; color: var(--ah-fg2); }
.aa-nomatch > .aa-nomatch-sub { font-size: 11px; color: var(--ah-fg3); }
.aa-nomatch > .ah-btn { margin-top: 4px; min-height: 28px; }
.ab-page[data-narrow] .aa-nomatch > .ah-btn { min-height: 40px; padding: 0 16px; }
.aa-note { margin: 0 10px 8px; color: var(--ah-fg2); font-size: 11px; line-height: 16px; }
.aa-error { color: var(--ah-danger-ink); }
.aa-list { gap: 9px; transition: opacity 180ms ease; }
.aa-list[data-stale] { opacity: .5; transition-delay: 120ms; }
.aa-card { padding: 11px 12px; }
.aa-card-top, .aa-actions { display: flex; align-items: center; gap: 8px; }
.aa-card-top strong, .aa-id { color: #7c6fde; font: 600 11px/16px ui-monospace, monospace; letter-spacing: .02em; }
/* The pull requests fixing an issue, beside its id: the review lane's tone */
.ab-chip.aa-pull { gap: 4px; border: 0; color: var(--ah-mine-ink); background: color-mix(in srgb, var(--ah-mine) 12%, transparent); font: inherit; font-size: 11px; font-variant-numeric: tabular-nums; cursor: pointer; }
.ab-chip.aa-pull:hover { background: color-mix(in srgb, var(--ah-mine) 20%, transparent); }
.aa-pull:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; }
.aa-session svg { margin-right: 4px; vertical-align: -1px; }
.aa-title { min-width: 0; margin: 5px 0 4px; }
.aa-kind { display: inline-block; max-width: 100%; overflow: hidden; margin-bottom: 2px; padding: 0 5px; border-radius: 4px; color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 9%, transparent); font: 600 10.5px/16px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; vertical-align: top; }
.aa-title h4, .aa-title h2 { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; overflow-wrap: anywhere; text-wrap: pretty; }
.aa-title h4 { margin: 0; font-size: 13px; line-height: 18px; font-weight: 600; -webkit-line-clamp: 2; }
.aa-title h2 { -webkit-line-clamp: 3; }
.aa-title[data-open] h2 { display: block; }
.aa-title-more { margin: 4px 0 0; padding: 0; border: 0; color: var(--ah-fg2); background: none; font: inherit; font-size: 11px; line-height: 16px; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.aa-title-more:hover { color: var(--ah-fg); }
.aa-preview { display: -webkit-box; margin: 0 0 6px; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; color: var(--ah-fg2); font-size: 12px; line-height: 17px; }
.aa-source { display: block; overflow: hidden; width: 100%; margin: 4px 0 7px; padding: 0; border: 0; color: var(--ah-fg2); background: none; font: 11px/17px ui-monospace, monospace; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.aa-source-link, .aa-open-source { cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.aa-open-source { padding: 0; border: 0; color: var(--ah-fg); background: transparent; font: 12px/18px ui-monospace, monospace; }
.aa-phase { margin-left: auto; padding: 1px 8px; border-radius: 999px; color: var(--aa-ink, var(--ah-fg2)); background: color-mix(in srgb, var(--aa-tone, currentColor) 13%, transparent); font-size: 10px; line-height: 16px; font-weight: 600; }
.aa-phase::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: var(--aa-tone, currentColor); vertical-align: 1px; }
/* One tone per stage: pending grey, running blue, analysed violet, fixing amber, fixed green, new events red. */
[data-phase="unanalysed"] { --aa-tone: var(--ah-fg3); --aa-ink: var(--ah-fg2); }
[data-phase="preparing"], [data-phase="analysing"] { --aa-tone: var(--ah-info); --aa-ink: var(--ah-info-ink); }
[data-phase="analysed"] { --aa-tone: var(--ah-mine); --aa-ink: var(--ah-mine-ink); }
[data-phase="fixing"] { --aa-tone: var(--ah-warn); --aa-ink: var(--ah-warn-ink); }
[data-phase="fixed"] { --aa-tone: var(--ah-ok); --aa-ink: var(--ah-ok-ink); }
[data-phase="regression"] { --aa-tone: var(--ah-danger); --aa-ink: var(--ah-danger-ink); }
.aa-card[data-phase]:not([data-phase="unanalysed"]) { border-left: 3px solid var(--aa-tone); }
.aa-card[data-phase="analysed"] .aa-act, .aa-card[data-phase="regression"] .aa-act { border-color: transparent; background: color-mix(in srgb, var(--aa-tone) 82%, #000); color: #fff; }
.aa-card[data-phase="analysed"] .aa-act:hover:not(:disabled), .aa-card[data-phase="regression"] .aa-act:hover:not(:disabled) { background: color-mix(in srgb, var(--aa-tone) 68%, #000); }
.aa-card[data-phase="fixed"] .aa-act, .aa-card[data-phase="preparing"] .aa-act, .aa-card[data-phase="analysing"] .aa-act, .aa-card[data-phase="fixing"] .aa-act { border-color: color-mix(in srgb, var(--aa-tone) 45%, transparent); background: color-mix(in srgb, var(--aa-tone) 12%, transparent); color: var(--aa-ink); }
.aa-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.aa-status .aa-phase { margin-left: 0; }
.aa-session { flex: none; white-space: nowrap; }
.aa-metrics { display: grid; grid-template-columns: repeat(3, 1fr); margin: 0 0 9px; }
.aa-metrics div { min-width: 0; }
.aa-metrics dt { color: var(--ah-fg2); font-size: 10px; line-height: 14px; }
.aa-metrics dd { overflow: hidden; margin: 0; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.aa-actions .ah-btn { min-height: 30px; flex: 1; }
.aa-more { position: relative; }
.aa-more summary { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 7px; cursor: pointer; list-style: none; }
.aa-more summary::-webkit-details-marker { display: none; }
.aa-more[open] > div { position: absolute; right: 0; bottom: 34px; z-index: 8; min-width: 130px; padding: 5px; border: 1px solid var(--ah-line); border-radius: 9px; background: var(--ah-layer); box-shadow: var(--ah-shadow); }
.aa-more button, .aa-more a { box-sizing: border-box; display: block; width: 100%; min-height: 32px; padding: 6px 8px; border: 0; border-radius: 6px; color: inherit; background: transparent; font: inherit; text-align: left; text-decoration: none; cursor: pointer; }
.aa-more button:hover, .aa-more a:hover { background: var(--ah-soft); }
.aa-detail .ab-detail-head > div { min-width: 0; }
.aa-detail .ab-detail-head { align-items: flex-start; }
.aa-detail .ab-detail-head > .aa-copy, .aa-detail .ab-detail-head > .aa-open { flex: none; margin-top: 2px; white-space: nowrap; }
.aa-copy[data-copied], .ab-copy[data-copied] { color: var(--ah-ok-ink); }
.aa-detail .ab-detail-head h2 { margin: 0; font-size: 16px; line-height: 22px; }
.aa-detail .aa-head-text { flex: 1 1 auto; }
.aa-detail .aa-title { margin: 3px 0 0; }
.aa-md { font-size: 12.5px; line-height: 19px; }
.aa-md-evidence { padding: 10px 12px; border-radius: 8px; background: var(--ah-soft); }
.aa-md pre { max-height: 44vh; overflow: auto; font: 11px/17px ui-monospace, monospace; }
.aa-md-evidence pre { background: color-mix(in srgb, currentColor 5%, transparent); }
.aa-evidence { margin-top: 18px; }
.aa-evidence h3 { margin: 0 0 7px; font-size: 12px; }
.aa-evidence p { margin: 0; }
.aa-evidence pre { max-height: 52vh; margin: 0; padding: 10px; overflow: auto; border-radius: 8px; background: var(--ah-soft); font: 11px/17px ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }

/* Narrow: one column at a time behind tabs, swiped sideways; the detail is a bottom sheet. */
.ab-tabs { display: flex; gap: 4px; padding: 0 12px 8px; overflow-x: auto; scrollbar-width: none; }
.ab-tabs::-webkit-scrollbar { display: none; }
.ab-tabs button {
  appearance: none; flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 18px;
  border: 1px solid var(--ah-line); background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer;
}
.ab-tabs button[aria-selected="true"] { background: var(--ah-fg); color: var(--ah-layer); border-color: transparent; }
.ab-tabs button[aria-selected="true"] .ab-count { color: inherit; opacity: .75; }
.ab-page[data-narrow] .ab-bar { padding: 12px 12px 8px; }
/* Row one: repository and refresh; row two: the search. The zones dissolve: each column carries its zone's filters. */
.ab-page[data-narrow] .ab-bar > .ab-select { order: 1; flex: 1 1 auto; max-width: none; }
.ab-page[data-narrow] .ab-bar > .ah-icon-btn { order: 2; margin-left: 0; }
.ab-page[data-narrow] .ab-search-wrap { order: 10; flex: 1 1 100%; max-width: none; }
.ab-page[data-narrow] .ab-search { height: 36px; font-size: 16px; }
.ab-page[data-narrow] .ab-zone, .ab-page[data-narrow] .ab-zone-cols { display: contents; }
.ab-page[data-narrow] .ab-lane-bar .ab-new { height: 36px; gap: 6px; }
.ab-tabs button[data-zone-start] { position: relative; margin-left: 9px; }
.ab-tabs button[data-zone-start]::before { content: ''; position: absolute; left: -8px; top: 9px; bottom: 9px; width: 1px; background: var(--ah-line); }
/* Narrow, the project filter is its icon until it filters; then its colour and name. */
.ab-page[data-narrow] .ab-lane-bar .ab-pchip { height: 36px; min-width: 36px; justify-content: center; padding: 0 10px; }
.ab-page[data-narrow] .ab-pfilter:not([data-active]) .ab-pchip-text { display: none; }
.ab-page[data-narrow] .ab-pfilter .ab-pchip-text { max-width: 96px; }
.ab-page[data-narrow] .ab-pick-foot { min-height: 44px; display: flex; align-items: center; font-size: 14px; }
.ab-page[data-narrow] .ah-seg > button { padding: 6px 10px; }
.ab-page[data-narrow] .ab-select, .ab-page[data-narrow] .ah-btn, .ab-page[data-narrow] .ah-icon-btn { height: 36px; }
.ab-page[data-narrow] .ah-icon-btn { width: 36px; }
.ab-page[data-narrow] .ab-hint-bar, .ab-page[data-narrow] .ab-banner { margin: 0 12px 8px; }
.ab-page[data-narrow] .ab-columns { gap: 0; padding: 0; scroll-snap-type: x mandatory; scroll-padding: 0; }
.ab-page[data-narrow] .ab-col { flex: 0 0 100%; max-width: none; border-radius: 0; background: transparent; scroll-snap-stop: always; }
.ab-page[data-narrow] .ab-col-body { padding: 4px 12px 24px; gap: 10px; }
.ab-page[data-narrow] .ab-card { padding: 12px 14px; min-height: 44px; }
.ab-page[data-narrow] .ab-go { height: 32px; padding: 0 12px; font-size: 12px; }
.ab-page[data-narrow] .ab-menu {
  position: fixed; top: auto; left: 0; right: 0; bottom: 0; max-width: none; z-index: 30; padding: 8px 8px calc(8px + env(safe-area-inset-bottom, 0px));
  border-radius: 16px 16px 0 0; animation: ab-rise 220ms var(--ah-ease);
}
.ab-page[data-narrow] .ab-menu button { min-height: 44px; font-size: 14px; }
.ab-page[data-narrow] .ab-scrim { position: fixed; background: rgba(0, 0, 0, .32); }
.ab-page[data-narrow] .ab-detail {
  position: fixed; top: auto; left: 0; right: 0; bottom: 0; width: auto; max-height: 86vh; border-radius: 16px 16px 0 0;
  padding-bottom: env(safe-area-inset-bottom, 0px); animation: ab-rise 220ms var(--ah-ease);
}
@keyframes ab-rise { from { transform: translateY(24px); opacity: 0; } }
.ab-page[data-narrow] .ab-detail-head::before {
  content: ''; position: absolute; top: 6px; left: 50%; width: 36px; height: 4px; margin-left: -18px; border-radius: 2px;
  background: color-mix(in srgb, currentColor 20%, transparent);
}
.ab-page[data-narrow] .ab-detail-head { padding-top: 16px; }
.ab-page[data-narrow] .ab-detail-foot .ah-btn { height: 40px; }
/* Narrow new ticket: taller sheet, touch-sized chips, 16px fields so a phone does not zoom in. */
.ab-page[data-narrow] .ab-detail[data-new] { max-height: 92vh; }
/* The bar's narrow ordering is not the panel's. */
.ab-page[data-narrow] .ab-detail .ah-seg, .ab-page[data-narrow] .ab-detail .ab-select { order: 0; }
.ab-page[data-narrow] .ab-new-title { font-size: 17px; }
.ab-page[data-narrow] .ab-new-note, .ab-page[data-narrow] .ab-pick-search, .ab-page[data-narrow] .ab-new-bot .ab-select { font-size: 16px; }
.ab-page[data-narrow] .ab-pchip { height: 36px; padding: 0 12px; border-radius: 18px; font-size: 13px; }
.ab-page[data-narrow] .ab-new-bot .ab-select, .ab-page[data-narrow] .ab-new-bot .ah-btn { height: 36px; }
.ab-page[data-narrow] .ab-pick { width: auto; max-width: none; }
.ab-page[data-narrow] .ab-pick-list { max-height: 55vh; }
.ab-page[data-narrow] .ab-pick-search { height: 40px; }
@media (pointer: coarse) {
  .ab-page { --ab-zone-row: 44px; }
  .ah-icon-btn.ah-icon-sm { width: 44px; height: 44px; }
  .ab-go { min-height: 44px; }
  .ab-chip[data-project] { min-height: 28px; padding: 0 8px; }
  .aa-actions .ah-btn, .aa-more summary, .aa-sort, .aa-session { min-height: 44px; }
  .aa-more summary { width: 44px; }
  .aa-title-more { min-height: 36px; }
  .aa-pull { min-height: 28px; padding: 0 8px; }
}
@media (prefers-reduced-motion: reduce) {
  .ab-detail, .ab-page[data-narrow] .ab-detail { animation: none; }
  .ab-page .ah-icon-btn[data-busy] svg, .ab-loading { animation: none; }
  .ab-card, .ab-col { transition: none; }
  .ab-chip[data-busy]::before, .ab-page[data-narrow] .ab-menu, .ab-spin { animation: none; }
  .ab-pchip { transition: none; }
  .aa-progress::after { width: 100%; opacity: .5; animation: none; }
  .aa-list { transition: none; }
  .ab-zone[data-zone="alerts"], .aa-list > .aa-card, .ab-skeleton-card, .ab-skeleton-bar { animation: none; }
}
`

export function injectBoardStyle(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.board'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}
