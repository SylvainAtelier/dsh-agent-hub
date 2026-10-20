/**
 * Review stylesheet, `rv-` prefixed: the sheet (in the board's detail and in its sidebar tab) and
 * the 待我审 lane's cards, on the shared tokens and controls of theme/base.ts. Violet (--ah-mine) is
 * the review's own: what is mine, what runs, what the analysis points at.
 */

const CSS = `
.rv-sheet {
  position: relative; display: flex; flex-direction: column; gap: 12px; min-height: 0; font-size: 12px; line-height: 18px;
  color: var(--ah-fg);
}
.rv-sheet:focus, .rv-preview:focus { outline: none; }
.rv-tab { height: 100%; overflow-y: auto; padding: 14px 16px 0; box-sizing: border-box; }
.rv-tab > .rv-sheet { min-height: 100%; }
.rv-grow { flex: 1; }
.rv-head { display: flex; flex-direction: column; gap: 4px; }
.rv-title { color: inherit; text-decoration: none; font-size: 15px; line-height: 22px; font-weight: 600; word-break: break-word; }
.rv-title:hover { text-decoration: underline; text-underline-offset: 3px; }
.rv-number { color: var(--ah-fg3); font-variant-numeric: tabular-nums; }
.rv-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; color: var(--ah-fg2); font-size: 11px; }
.rv-meta code, .rv-props code { font-family: var(--ah-mono); font-size: 11px; }
.rv-branches {
  display: grid; grid-template-columns: max-content minmax(0, 1fr) auto; gap: 2px 8px; align-items: center; margin-top: 4px; padding: 6px 8px;
  border-radius: var(--ah-radius-sm); background: color-mix(in srgb, currentColor 4%, transparent); font-size: 11px;
}
.rv-branch { display: contents; }
.rv-branch-label { color: var(--ah-fg3); white-space: nowrap; }
.rv-branch-name { font-family: var(--ah-mono); font-size: 11px; color: var(--ah-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: all; }
.rv-branch[data-kind="base"] .rv-branch-name { color: var(--ah-fg2); }
.rv-branches [data-copied], .aa-copy[data-copied] { color: var(--ah-ok-ink); }
.rv-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; border-radius: var(--ah-radius-sm); font-size: 11px; line-height: 18px; white-space: nowrap;
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.rv-chip[data-live]::before {
  content: ''; flex: none; width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid currentColor; border-right-color: transparent;
  animation: rv-spin 800ms linear infinite;
}
.rv-chip[data-event="APPROVE"] { color: var(--ah-ok-ink); background: color-mix(in srgb, var(--ah-ok) 12%, transparent); }
.rv-chip[data-event="REQUEST_CHANGES"] { color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 10%, transparent); }
@keyframes rv-spin { to { transform: rotate(360deg); } }
.rv-banner {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; margin: 0; padding: 8px 10px; border-radius: var(--ah-radius);
  color: var(--ah-warn-ink); background: color-mix(in srgb, var(--ah-warn) 12%, transparent);
}
.rv-banner[role="alert"] { color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 9%, transparent); }
.rv-banner[data-tone="ok"] { color: var(--ah-ok-ink); background: color-mix(in srgb, var(--ah-ok) 10%, transparent); }
.rv-muted { margin: 0; color: var(--ah-fg2); }
.rv-warn { color: var(--ah-danger-ink); font-size: 11px; }
.rv-decision > button[aria-checked="true"][data-decision="approve"] { color: var(--ah-ok-ink); }
.rv-decision > button[aria-checked="true"][data-decision="request-changes"] { color: var(--ah-danger-ink); }
.rv-decision { display: flex; }
.rv-decision > button { flex: 1; }
.rv-decision > button:disabled { cursor: default; }
.rv-field { display: flex; flex-direction: column; gap: 4px; }
.rv-field > span { color: var(--ah-fg2); }
.rv-input {
  box-sizing: border-box; width: 100%; min-width: 0; padding: 5px 8px; border-radius: var(--ah-radius); border: 1px solid var(--ah-line);
  background: transparent; color: inherit; font: inherit; font-size: 12px; line-height: 18px; resize: vertical;
}
.rv-input:focus { outline: none; border-color: color-mix(in srgb, currentColor 40%, transparent); }
.rv-input[data-warn] { border-color: color-mix(in srgb, var(--ah-danger) 60%, transparent); }
.rv-input:disabled { opacity: .7; }
.rv-section { display: flex; flex-direction: column; gap: 6px; }
.rv-section-head { display: flex; align-items: center; gap: 6px; min-height: 22px; }
.rv-section-head h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--ah-fg2); }
.rv-toggle { appearance: none; border: none; background: none; padding: 0; color: inherit; font: inherit; cursor: pointer; text-align: left; }
.rv-chevron { display: inline-block; width: 10px; color: var(--ah-fg3); transition: transform 120ms ease; }
.rv-toggle[aria-expanded="true"] .rv-chevron { transform: rotate(90deg); }
.rv-count { font-size: 11px; color: var(--ah-fg3); font-variant-numeric: tabular-nums; }
.rv-prose { padding: 8px 10px; border-radius: var(--ah-radius); background: var(--ah-soft); }
.rv-findings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.rv-finding {
  display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: var(--ah-radius); border: 1px solid var(--ah-line);
  transition: border-color 120ms ease, background-color 120ms ease;
}
.rv-finding[data-checked] { border-color: color-mix(in srgb, currentColor 26%, transparent); background: var(--ah-soft); }
.rv-finding-head { display: flex; align-items: center; gap: 6px; min-width: 0; cursor: pointer; }
.rv-finding-head input { margin: 0; flex: none; }
.rv-id { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
.rv-where {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 5px; border-radius: var(--ah-radius-sm);
  font-family: var(--ah-mono); font-size: 11px; background: color-mix(in srgb, currentColor 7%, transparent);
}
.rv-text[data-clamped] {
  max-height: 72px; overflow: hidden; cursor: pointer;
  -webkit-mask-image: linear-gradient(to bottom, #000 60%, transparent); mask-image: linear-gradient(to bottom, #000 60%, transparent);
}
.rv-en { display: flex; align-items: flex-start; gap: 6px; }
.rv-en-label { flex: none; margin-top: 6px; font-size: 10px; font-weight: 600; letter-spacing: .04em; color: var(--ah-fg3); }
.rv-finding-actions { display: flex; align-items: center; gap: 10px; }
.rv-ask { display: flex; gap: 6px; }
.rv-link {
  appearance: none; border: none; background: none; padding: 0; color: inherit; font: inherit; font-size: 12px;
  text-decoration: underline; text-underline-offset: 2px; color: var(--ah-fg2); cursor: pointer;
}
.rv-link:hover:not(:disabled) { color: var(--ah-fg); }
.rv-link:disabled { opacity: .35; cursor: default; }
.rv-foot {
  position: sticky; bottom: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: auto; padding: 10px 0 12px;
  background: var(--ah-layer); border-top: 1px solid var(--ah-line);
}
.rv-sheet[data-compact] .rv-foot { position: static; }
.rv-props { display: grid; grid-template-columns: 64px 1fr; gap: 6px 10px; margin: 0; }
.rv-props dt { color: var(--ah-fg2); }
.rv-props dd { margin: 0; }
.rv-preview { display: flex; flex-direction: column; min-height: 100%; scroll-margin-top: 16px; }
.rv-preview-head { display: flex; align-items: center; gap: 6px; padding: 0 0 6px; }
.rv-preview-head h4 { margin: 0; font-size: 14px; font-weight: 600; }
.rv-preview-body { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.rv-preview-label { margin: 6px 0 0; font-size: 12px; font-weight: 600; color: var(--ah-fg2); }
.rv-preview-foot {
  position: sticky; bottom: 0; display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 10px 0 12px;
  background: var(--ah-layer); border-top: 1px solid var(--ah-line);
}
.rv-pre {
  margin: 0; padding: 8px 10px; border-radius: var(--ah-radius); background: var(--ah-soft); white-space: pre-wrap; word-break: break-word;
  font: inherit; font-size: 12px; line-height: 18px;
}
.rv-md.rv-pre { white-space: normal; }
.rv-comments li > .rv-md { align-self: stretch; }
.rv-comments { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.rv-comments li { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.rv-warnings { margin: 0; padding: 8px 10px 8px 26px; border-radius: var(--ah-radius); color: var(--ah-warn-ink); background: color-mix(in srgb, var(--ah-warn) 12%, transparent); }
.rv-problems + .rv-warnings { margin-top: 8px; }
.rv-problems { margin: 0; padding: 8px 10px 8px 26px; border-radius: var(--ah-radius); color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 9%, transparent); }

/* Rendered Markdown in the read-only parts */
.rv-md { min-width: 0; word-break: break-word; overflow-wrap: anywhere; }
.rv-md > :first-child { margin-top: 0; }
.rv-md > :last-child { margin-bottom: 0; }
.rv-md p, .rv-md ul, .rv-md ol, .rv-md blockquote, .rv-md pre, .rv-md table { margin: 0 0 8px; }
.rv-md h1, .rv-md h2, .rv-md h3, .rv-md h4, .rv-md h5, .rv-md h6 { margin: 12px 0 6px; font-size: 13px; line-height: 20px; font-weight: 600; }
.rv-md h1, .rv-md h2 { font-size: 14px; }
.rv-md ul, .rv-md ol { padding-left: 20px; }
.rv-md li + li { margin-top: 2px; }
.rv-md li > p { margin: 0; }
.rv-md input[type="checkbox"] { margin: 0 4px 0 0; vertical-align: -2px; }
.rv-md a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.rv-md code { padding: 0 4px; border-radius: 4px; font-family: var(--ah-mono); font-size: 11px; background: color-mix(in srgb, currentColor 8%, transparent); }
.rv-md pre { padding: 8px 10px; border-radius: var(--ah-radius-sm); overflow-x: auto; background: color-mix(in srgb, currentColor 6%, transparent); }
.rv-md pre code { padding: 0; background: none; white-space: pre; }
.rv-md blockquote { padding: 0 0 0 10px; border-left: 3px solid var(--ah-line); color: var(--ah-fg2); }
.rv-md hr { margin: 10px 0; border: none; border-top: 1px solid var(--ah-line); }
.rv-md table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.rv-md th, .rv-md td { padding: 3px 8px; border: 1px solid var(--ah-line); text-align: left; }
.rv-md th { font-weight: 600; }
.rv-md img { max-width: 100%; }

/* The 待我审 lane on the board */
[data-stage="review"] .ab-dot { background: var(--ah-mine); }
.rv-card .ab-card-top { gap: 6px; }
.rv-card-number { font-size: 11px; line-height: 16px; color: var(--ah-fg3); font-variant-numeric: tabular-nums; }
.rv-card .rv-chip { margin-left: auto; }
.rv-lane-actions { display: flex; gap: 6px; }
.rv-lane-actions > .ah-btn { flex: 1; justify-content: center; }
.rv-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* 待我审 | 全部 | 我的: the lane's switch, in its zone's head or atop a narrow lane */
.rv-scope { flex: none; min-width: 0; }
.rv-scope > button { padding: 1px 9px; }
.rv-scope > button[data-scope="mine"][aria-checked="true"] { color: var(--ah-mine-ink); }
.rv-scope-n, .rv-switch-n { font-size: 11px; font-weight: 400; color: var(--ah-fg3); font-variant-numeric: tabular-nums; }
.rv-scope[data-wide] { display: flex; width: 100%; }
.rv-scope[data-wide] > button { flex: 1; min-height: 32px; font-size: 13px; }
.rv-lane-bar {
  position: sticky; top: 0; z-index: 2; display: flex; flex-direction: column; gap: 8px; margin: -4px -12px 0; padding: 8px 12px;
  background: var(--ah-layer); border-bottom: 1px solid var(--ah-line);
}

/* Long lists: each card in a slot the browser skips laying out off screen; the slot's padding keeps hover shadows and focus rings unclipped */
.rv-slot { display: flex; flex-direction: column; gap: 8px; margin: -6px; padding: 6px; content-visibility: auto; contain-intrinsic-size: auto 104px; }
.ab-page[data-narrow] .rv-slot { gap: 10px; }
.rv-reveal {
  appearance: none; height: 32px; border: 1px dashed var(--ah-line); border-radius: var(--ah-radius); background: transparent; color: inherit;
  font: inherit; font-size: 12px; color: var(--ah-fg2); cursor: pointer;
}
.rv-reveal:hover { color: var(--ah-fg); background: var(--ah-soft); }
.rv-divider { display: flex; align-items: center; gap: 8px; padding: 6px 2px 0; font-size: 11px; line-height: 16px; color: var(--ah-fg2); font-weight: 600; }
.rv-divider::before, .rv-divider::after { content: ''; flex: 1; height: 1px; background: color-mix(in srgb, currentColor 18%, transparent); }
.rv-divider::before { flex: 0 0 8px; }
.rv-divider-note { order: 1; font-weight: 400; white-space: nowrap; cursor: help; }

/* Stacks: one rail per stack, its top first and the branch it merges into at the foot. A filled node is in your lists,
   a hollow one is not (a slim row in the lane); a side branch sprouts from the rail. Node centres sit 14px down (22px on touch). */
.rv-stack {
  --rv-rail: color-mix(in srgb, currentColor 20%, transparent); --rv-node: color-mix(in srgb, currentColor 42%, transparent);
  position: relative; display: flex; flex-direction: column; gap: 6px; min-width: 0; margin: 0; padding: 0; list-style: none;
}
.rv-stack::before { content: ''; position: absolute; left: 6px; top: 18px; bottom: 18px; width: 2px; border-radius: 1px; background: var(--rv-rail); }
.rv-stack-row { position: relative; min-width: 0; padding-left: calc(20px + var(--rv-level, 0) * 12px); }
.rv-stack-row[data-branch]::before {
  content: ''; position: absolute; left: 8px; top: 13px; width: calc(var(--rv-level, 0) * 12px - 2px); height: 2px; background: var(--rv-rail);
}
.rv-stack-node {
  position: absolute; z-index: 1; left: calc(2px + var(--rv-level, 0) * 12px); top: 9px; width: 10px; height: 10px; box-sizing: border-box;
  border-radius: 50%; border: 2px solid var(--rv-node); background: var(--ah-layer); transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
}
.rv-stack-row[data-shown] > .rv-stack-node { background: var(--rv-node); border-color: transparent; }
.rv-stack-node[data-fold] { border-style: dashed; }
.rv-stack-row:is([data-selected], [data-current]) > .rv-stack-node {
  background: var(--ah-mine); border-color: var(--ah-mine); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ah-mine) 22%, transparent);
}
.rv-stack-base { position: relative; display: flex; align-items: center; min-width: 0; height: 18px; padding-left: 20px; font-size: 11px; color: var(--ah-fg3); }
.rv-stack-base::before {
  content: ''; position: absolute; left: 6px; top: -6px; width: 9px; height: 15px; box-sizing: border-box;
  border-left: 2px solid var(--rv-rail); border-bottom: 2px solid var(--rv-rail); border-bottom-left-radius: 6px;
}
.rv-stack-base code {
  min-width: 0; padding: 0 5px; border-radius: 4px; font-family: var(--ah-mono); font-size: 11px; line-height: 16px;
  background: color-mix(in srgb, currentColor 7%, transparent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* A pull request of the stack the lane shows no card for: one quiet line, dashed like a placeholder */
.rv-slim {
  appearance: none; display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 28px; padding: 0 10px;
  border: 1px dashed color-mix(in srgb, currentColor 24%, transparent); border-radius: var(--ah-radius); background: transparent;
  color: var(--ah-fg2); font: inherit; font-size: 12px; line-height: 16px; text-align: left; cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
.rv-slim:hover { color: var(--ah-fg); background: var(--ah-layer); border-color: color-mix(in srgb, currentColor 36%, transparent); }
.rv-slim:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; }
.rv-slim[data-selected] { color: var(--ah-fg); border-style: solid; border-color: color-mix(in srgb, currentColor 45%, transparent); background: var(--ah-layer); }
.rv-slim-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv-slim-author { flex: 0 1 auto; max-width: 40%; font-size: 11px; color: var(--ah-fg3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:is(.rv-slim, .rv-stackp-pr) > :is(.ab-chip, .rv-chip, .rv-card-number) { flex: none; }
.rv-slim-fold { justify-content: center; color: var(--ah-fg3); }

/* The stack in a detail: folds to its summary line on a narrow board */
.rv-stackp { border: 1px solid var(--ah-line); border-radius: var(--ah-radius); }
.rv-stackp > summary {
  display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 12px; border-radius: var(--ah-radius);
  font-size: 12px; font-weight: 600; color: var(--ah-fg2); list-style: none; cursor: pointer; user-select: none;
}
.rv-stackp > summary::-webkit-details-marker { display: none; }
.rv-stackp > summary::before {
  content: ''; flex: none; width: 5px; height: 5px; margin: 0 2px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg); transition: transform 120ms ease;
}
.rv-stackp[open] > summary::before { transform: rotate(45deg); }
.rv-stackp > summary:hover { color: var(--ah-fg); }
.rv-stackp > summary:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.rv-stackp-title { flex: 1; min-width: 0; }
.rv-stackp-count { font-weight: 400; color: var(--ah-fg3); font-variant-numeric: tabular-nums; }
.rv-stack-list { gap: 2px; margin: 0 12px 8px 10px; }
.rv-stackp-row { display: flex; align-items: center; gap: 2px; min-width: 0; }
.rv-stackp-pr {
  appearance: none; flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px; border: 0;
  border-radius: var(--ah-radius-sm); background: transparent; color: var(--ah-fg2); font: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.rv-stackp-pr:hover:not(:disabled) { color: var(--ah-fg); background: color-mix(in srgb, currentColor 7%, transparent); }
.rv-stackp-pr:disabled { cursor: default; color: var(--ah-fg); font-weight: 600; }
.rv-stackp-pr:focus-visible, .rv-stackp-pick:has(input:focus-visible) { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.rv-stackp-pick { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--ah-radius-sm); cursor: pointer; }
.rv-stackp-pick:hover { background: color-mix(in srgb, currentColor 7%, transparent); }
.rv-stackp-pick input { margin: 0; accent-color: var(--ah-mine); cursor: pointer; }
.rv-stackp-pick input:focus-visible { outline: none; }
.rv-stackp-hint { margin: 0 12px 10px; font-size: 11px; line-height: 16px; color: var(--ah-fg3); }
@media (pointer: coarse) {
  .rv-slim, .rv-stackp-pr { height: 44px; font-size: 13px; }
  .rv-stackp-pick { width: 44px; height: 44px; }
  .rv-stackp > summary { min-height: 44px; }
  .rv-stack-row:not([data-shown]) > .rv-stack-node, .rv-stack-list .rv-stack-node { top: 17px; }
  .rv-stack-row[data-branch]:not([data-shown])::before, .rv-stack-list .rv-stack-row[data-branch]::before { top: 21px; }
}
@media (prefers-reduced-motion: reduce) { .rv-slim, .rv-stack-node, .rv-stackp > summary::before { transition: none; } }

/* Stage colours, the same in 待我审 and 我的 PR: one hue per stage, on the chip and a bar down the card's side; the card itself stays neutral.
   grey not started · blue the bot is working · amber waits on me · violet done here, waits to be sent · green sent · red out of date;
   once sent, violet merged (GitHub's hue) and grey closed, each with its glyph */
.rv-card, .rv-chip { --rv-tone: var(--ah-fg3); --rv-ink: var(--ah-fg2); }
:is(.rv-card, .rv-chip)[data-phase="analyzing"], :is(.rv-card, .rv-chip)[data-phase="fixing"] { --rv-tone: var(--ah-info); --rv-ink: var(--ah-info-ink); }
:is(.rv-card, .rv-chip)[data-phase="ready"] { --rv-tone: var(--ah-warn); --rv-ink: var(--ah-warn-ink); }
:is(.rv-card, .rv-chip)[data-phase="fixed"] { --rv-tone: var(--ah-mine); --rv-ink: var(--ah-mine-ink); }
:is(.rv-card, .rv-chip)[data-phase="submitted"] { --rv-tone: var(--ah-ok); --rv-ink: var(--ah-ok-ink); }
:is(.rv-card, .rv-chip)[data-phase="stale"], :is(.rv-card, .rv-chip)[data-phase="invalid"] { --rv-tone: var(--ah-danger); --rv-ink: var(--ah-danger-ink); }
/* Sent, then asked of me again or followed up (new commits, comments): waits on me once more, amber; sent and done, it sinks to the list's end and quiets */
:is(.rv-card, .rv-chip)[data-phase="submitted"][data-again] { --rv-tone: var(--ah-warn); --rv-ink: var(--ah-warn-ink); }
:is(.rv-card, .rv-chip)[data-phase="merged"] { --rv-tone: var(--ah-mine); --rv-ink: var(--ah-mine-ink); }
.rv-card[data-phase="submitted"]:not([data-again]) .ab-card-title, .rv-card:is([data-phase="merged"], [data-phase="closed"]) .ab-card-title { color: var(--ah-fg2); }
.rv-chip:is([data-phase="merged"], [data-phase="closed"])::before { display: none; }
.rv-chip-icon { flex: none; }
.rv-chip[data-phase] { color: var(--rv-ink); background: color-mix(in srgb, var(--rv-tone) 14%, transparent); font-weight: 600; }
.rv-chip[data-phase]:not([data-live])::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--rv-tone); }
.rv-card[data-phase] { position: relative; }
.rv-card[data-phase]:not([data-phase="new"])::before {
  content: ''; position: absolute; left: -1px; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: var(--rv-tone);
}
/* Who the pull request is for is a quiet label: the colour belongs to the stage. */
.rv-mine-chip, .rv-own-chip { color: var(--ah-fg2); border: 1px solid var(--ah-line); background: transparent; font-weight: 500; }

/* What followed a review I sent: new commits and comments (amber, it waits on me again), and how my comments were answered (quiet) */
.rv-follow { gap: 8px; color: var(--ah-warn-ink); background: color-mix(in srgb, var(--ah-warn) 12%, transparent); font-variant-numeric: tabular-nums; }
.rv-follow > span, .rv-stand { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
.rv-stand-icon { flex: none; }
.rv-answered { color: var(--ah-fg2); font-variant-numeric: tabular-nums; }

/* My comments after the review: each with where it stands, by glyph and colour */
.rv-stand { font-size: 11px; line-height: 18px; color: var(--rv-stand-ink, var(--ah-fg2)); }
.rv-stand[data-stand="replied"] { --rv-stand-ink: var(--ah-warn-ink); }
.rv-stand[data-stand="outdated"] { --rv-stand-ink: var(--ah-info-ink); }
.rv-stand[data-stand="resolved"] { --rv-stand-ink: var(--ah-ok-ink); }
.rv-stand[data-stand="open"] { --rv-stand-ink: var(--ah-fg3); }
.rv-track-section .rv-section-head { flex-wrap: wrap; row-gap: 2px; }
.rv-track-section .rv-section-head .rv-stand { font-variant-numeric: tabular-nums; }
.rv-track-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rv-track {
  display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 6px 10px; border-radius: var(--ah-radius); border: 1px solid var(--ah-line);
}
.rv-track[data-new] { border-color: color-mix(in srgb, var(--ah-warn) 45%, transparent); }
.rv-track-head {
  appearance: none; display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 24px; padding: 0; border: none; background: none;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.rv-track-head:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 40%, transparent); outline-offset: 2px; border-radius: var(--ah-radius-sm); }
.rv-track-head .rv-stand { flex: none; min-width: 64px; }
.rv-track-head .rv-where { flex: 0 1 auto; }
.rv-id[data-severity="must"] { color: var(--ah-danger-ink); }
.rv-new {
  flex: none; padding: 0 5px; border-radius: var(--ah-radius-sm); font-size: 10px; line-height: 16px; font-weight: 600;
  color: var(--ah-warn-ink); background: color-mix(in srgb, var(--ah-warn) 16%, transparent);
}
.rv-track-last { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--ah-fg2); }
.rv-track-who { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: 11px; color: var(--ah-fg3); }
div.rv-track-who { display: flex; }
.rv-track-body { display: flex; flex-direction: column; gap: 6px; }
.rv-track-mine { padding: 6px 8px; border-radius: var(--ah-radius); background: var(--ah-soft); }
.rv-track-reply { display: flex; flex-direction: column; gap: 2px; padding-left: 10px; border-left: 2px solid var(--ah-line); }
.rv-track-reply[data-new] { border-left-color: var(--ah-warn); }
.rv-track-sub { margin: 4px 0 0; font-size: 11px; font-weight: 600; color: var(--ah-fg3); }
@media (pointer: coarse) {
  .rv-track-head { min-height: 44px; }
  .rv-track .rv-link { min-height: 44px; display: inline-flex; align-items: center; }
}

/* The first read of a list */
.rv-skeleton { display: flex; flex-direction: column; gap: 8px; }
.rv-skeleton-card {
  height: 76px; border-radius: var(--ah-radius); border: 1px solid var(--ah-line);
  background: linear-gradient(90deg, var(--ah-soft) 25%, color-mix(in srgb, currentColor 8%, transparent) 50%, var(--ah-soft) 75%) 0 0 / 200% 100%;
  animation: rv-shimmer 1.2s linear infinite;
}
.rv-skeleton-card:nth-child(2) { opacity: .7; }
.rv-skeleton-card:nth-child(3) { opacity: .45; }
@keyframes rv-shimmer { to { background-position: -200% 0; } }
.rv-lane-foot { display: flex; align-items: center; gap: 6px; padding: 0 12px 10px; font-size: 11px; color: var(--ah-fg2); }
.rv-card { -webkit-touch-callout: none; }
.rv-card[data-menu] { border-color: color-mix(in srgb, currentColor 45%, transparent); }
.rv-menu { min-width: 248px; max-width: min(340px, calc(100vw - 16px)); }
.rv-menu .gp-menu-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.rv-menu .gp-menu-hint { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv-menu[data-sheet] { min-width: 0; max-width: none; }
.rv-menu[data-sheet] .gp-menu-item { min-height: 44px; }
.rv-menu[data-sheet] .gp-menu-hint { max-width: min(46vw, 220px); }

/* The ⋯ button: shown on hover, focus and an open menu; always on touch */
.rv-more {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; margin: -2px -4px -2px 0; padding: 0;
  border: 0; border-radius: var(--ah-radius-sm); background: transparent; color: inherit; cursor: pointer; opacity: 0; transition: opacity 120ms ease, background-color 120ms ease;
}
.rv-more:hover, .rv-more[aria-expanded="true"] { background: color-mix(in srgb, currentColor 8%, transparent); }
.rv-card:hover .rv-more, .rv-card:focus-within .rv-more, .rv-card[data-menu] .rv-more { opacity: .7; }
.rv-more:hover, .rv-more:focus-visible, .rv-more[aria-expanded="true"] { opacity: 1; }
.rv-more:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
/* Stopping: one run where its start was, all of them beside 全部分析; red only once it is meant */
.rv-stop, .rv-go-stop, .rv-btn-stop, .rv-stop-all { gap: 5px; }
.rv-go-stop:hover:not([aria-disabled]), .rv-btn-stop:hover:not([aria-disabled]), .rv-stop:hover:not([aria-disabled]) {
  color: var(--ah-danger-ink); border-color: color-mix(in srgb, var(--ah-danger) 40%, transparent); background: color-mix(in srgb, var(--ah-danger) 8%, transparent);
}
.rv-go-stop[aria-disabled], .rv-btn-stop[aria-disabled], .rv-stop[aria-disabled] { cursor: default; }
/* A live card's stop stays in sight: the run is what the card is about now */
.rv-card[data-live] .rv-go-stop { opacity: .75; }
.rv-card[data-live]:hover .rv-go-stop, .rv-card[data-live] .rv-go-stop:focus-visible { opacity: 1; }
.rv-stop {
  flex: none; display: inline-flex; align-items: center; height: 22px; margin-left: 8px; padding: 0 8px; border-radius: var(--ah-radius-sm);
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent); background: transparent; color: inherit; font: inherit; font-size: 11px; cursor: pointer;
}
.rv-stop:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; }
.rv-stop-all:hover:not(:disabled) { color: var(--ah-danger-ink); }
.rv-stop-all:disabled { opacity: .3; cursor: default; }
.rv-stop-all[data-confirm] {
  width: auto; padding: 0 8px; color: #fff; background: color-mix(in srgb, var(--ah-danger) 85%, #000); font: inherit; font-size: 11px; font-weight: 500; white-space: nowrap;
  animation: rv-in 120ms var(--ah-ease);
}
.ah-btn.rv-stop-all[data-confirm] { font-size: 12px; border-color: transparent; }
.rv-stop-all[data-confirm]:hover:not(:disabled) { color: #fff; background: color-mix(in srgb, var(--ah-danger) 72%, #000); }
.rv-flash { margin-left: auto; color: var(--ah-ok-ink); background: color-mix(in srgb, var(--ah-ok) 12%, transparent); }

/* A run on its card */
.rv-run {
  display: flex; align-items: center; gap: 8px; min-width: 0; margin-top: 2px; padding-top: 7px; font-size: 11px; line-height: 16px;
  border-top: 1px dashed var(--ah-line);
}
.rv-run-bar { flex: none; display: flex; gap: 2px; }
.rv-run-bar i { display: block; width: 10px; height: 4px; border-radius: 2px; background: color-mix(in srgb, currentColor 14%, transparent); }
.rv-run-bar i[data-on="done"] { background: var(--ah-mine); }
.rv-run-bar i[data-on="now"] { background: var(--ah-mine); animation: rv-pulse 1.2s ease-in-out infinite; }
@keyframes rv-pulse { 50% { opacity: .35; } }
.rv-run-text { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; overflow: hidden; white-space: nowrap; }
.rv-run-label { flex: none; font-weight: 500; }
.rv-run-info { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ah-fg2); }
.rv-run-time { flex: none; margin-left: auto; color: var(--ah-fg3); font-variant-numeric: tabular-nums; }
.rv-run-mark {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%;
  font-size: 10px; font-weight: 700; line-height: 1;
}
.rv-run[data-state="done"] { color: var(--ah-ok-ink); }
.rv-run[data-state="done"] .rv-run-mark { background: color-mix(in srgb, var(--ah-ok) 14%, transparent); }
.rv-run[data-state="cancelled"] { opacity: .55; }
.rv-run[data-state="failed"] { color: var(--ah-danger-ink); }
.rv-run[data-state="failed"] .rv-run-mark { color: #fff; background: color-mix(in srgb, var(--ah-danger) 85%, #000); }
.rv-run[data-state="failed"] { align-items: flex-start; }
.rv-run[data-state="failed"] .rv-run-mark { margin-top: 1px; }
/* The reason matters here: two lines of it rather than one cut short */
.rv-run[data-state="failed"] .rv-run-text {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; word-break: break-word;
}
.rv-run[data-state="failed"] .rv-run-label { margin-right: 6px; }
.rv-run[data-state="failed"] .rv-run-info { color: inherit; }
.rv-run-retry {
  flex: none; height: 22px; padding: 0 8px; border-radius: var(--ah-radius-sm); border: 1px solid color-mix(in srgb, var(--ah-danger) 40%, transparent);
  background: transparent; color: inherit; font: inherit; font-size: 11px; cursor: pointer;
}
.rv-run-retry:hover { background: color-mix(in srgb, var(--ah-danger) 10%, transparent); }

/* The run, step by step, in the detail (above the sheet, so it carries the sheet's variables itself) */
.rv-progress {
  font-size: 12px; line-height: 18px; color: var(--ah-fg);
}
.ab-detail-body > .rv-progress { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--ah-line); }
.rv-progress .rv-section-head { justify-content: space-between; }
.rv-progress-toggle { font-size: 12px; font-weight: 600; color: var(--ah-fg2); }
.rv-progress .rv-count { font-variant-numeric: tabular-nums; }
.rv-steps { list-style: none; margin: 0; padding: 2px 0 0; display: flex; flex-direction: column; }
.rv-step {
  position: relative; display: grid; grid-template-columns: 14px 1fr auto; column-gap: 8px; align-items: baseline; padding: 0 0 10px;
}
.rv-step:last-child { padding-bottom: 0; }
/* The rail joining one mark to the next */
.rv-step:not(:last-child)::after {
  content: ''; position: absolute; left: 6px; top: 13px; bottom: -1px; width: 2px; border-radius: 1px;
  background: var(--ah-line);
}
.rv-step[data-state="done"]::after { background: color-mix(in srgb, var(--ah-mine) 45%, transparent); }
.rv-step-mark {
  grid-row: span 2; align-self: start; box-sizing: border-box; width: 14px; height: 14px; margin-top: 2px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, currentColor 22%, transparent); background: var(--ah-layer);
}
.rv-step[data-state="done"] .rv-step-mark { border-color: var(--ah-mine); background: var(--ah-mine); box-shadow: inset 0 0 0 2px var(--ah-layer); }
.rv-step[data-state="now"] .rv-step-mark { border-color: var(--ah-mine); border-right-color: transparent; animation: rv-spin 800ms linear infinite; }
.rv-step[data-state="failed"] .rv-step-mark { border-color: var(--ah-danger); background: var(--ah-danger); }
.rv-step[data-state="todo"] { opacity: .45; }
.rv-step[data-state="now"] .rv-step-label { font-weight: 600; }
.rv-step[data-state="failed"] .rv-step-label { color: var(--ah-danger-ink); font-weight: 600; }
.rv-step-time { font-size: 11px; color: var(--ah-fg3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.rv-step-info { grid-column: 2 / 4; font-size: 11px; color: var(--ah-fg2); word-break: break-word; }

/* What runs, atop the lane */
.rv-activity {
  flex: none; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: var(--ah-radius); font-size: 12px; line-height: 18px;
  background: color-mix(in srgb, var(--ah-mine) 8%, transparent); border: 1px solid color-mix(in srgb, var(--ah-mine) 18%, transparent);
  animation: rv-in 160ms var(--ah-ease);
}
.rv-activity[data-failed] { background: color-mix(in srgb, var(--ah-danger) 8%, transparent); border-color: color-mix(in srgb, var(--ah-danger) 22%, transparent); }
@keyframes rv-in { from { opacity: 0; transform: translateY(-4px); } }
.rv-activity-row { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.rv-activity-row > .rv-spin { margin-top: 3px; }
.rv-activity-text { flex: 1; min-width: 0; word-break: break-word; }
.rv-activity[data-failed] .rv-activity-text { color: var(--ah-danger-ink); }
.rv-activity-hide {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; margin: -2px -4px -2px 0; padding: 0;
  border: 0; border-radius: var(--ah-radius-sm); background: transparent; color: var(--ah-fg3); cursor: pointer;
}
.rv-activity-hide:hover { color: var(--ah-fg); background: color-mix(in srgb, currentColor 8%, transparent); }
.rv-spin {
  flex: none; box-sizing: border-box; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--ah-mine); border-right-color: transparent;
  animation: rv-spin 800ms linear infinite;
}
.rv-tally { display: flex; flex-wrap: wrap; gap: 4px; }
.rv-tally-chip { padding: 0 6px; border-radius: var(--ah-radius-sm); font-size: 11px; line-height: 18px; background: color-mix(in srgb, currentColor 7%, transparent); font-variant-numeric: tabular-nums; }
.rv-tally-chip[data-tone="active"] { color: var(--ah-mine-ink); background: color-mix(in srgb, var(--ah-mine) 12%, transparent); }
.rv-tally-chip[data-tone="done"] { color: var(--ah-ok-ink); background: color-mix(in srgb, var(--ah-ok) 12%, transparent); }
.rv-tally-chip[data-tone="failed"] { color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 10%, transparent); }

/* The detail: the sheet and the changes, side by side on a wide board, a switch apart on a narrow one */
.ab-detail.rv-detail[data-wide] { width: min(1320px, calc(100% - 16px)); }
.rv-detail .ab-detail-head { min-width: 0; }
.rv-detail .ab-id { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv-panes { position: relative; flex: 1; min-height: 0; display: flex; }
.rv-panes > .rv-pane { flex: 1 1 auto; min-width: 0; }
.rv-panes[data-both] > .ab-detail-body { flex: 0 0 380px; border-right: 1px solid var(--ah-line); }
.rv-pane[data-off] { position: absolute; inset: 0; visibility: hidden; pointer-events: none; }
.rv-pane-diff { display: flex; flex-direction: column; min-height: 0; border-top: 1px solid var(--ah-line); }
.rv-panes[data-both] > .rv-pane-diff { border-top: 0; }
.ab-page[data-narrow] .ab-detail.rv-detail { height: 86vh; }
.rv-switch { flex: none; margin-left: 6px; }
.rv-tab-bar { display: flex; padding: 0 0 10px; }
.rv-tab[data-flush] { display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.rv-tab[data-flush] .rv-tab-bar { padding: 10px 12px 8px; }
.rv-tab[data-flush] .rv-switch, .rv-tab-bar .rv-switch { margin-left: 0; }
.rv-where-go { appearance: none; border: 0; color: inherit; cursor: pointer; }
.rv-where-go:hover { color: var(--ah-mine-ink); background: color-mix(in srgb, var(--ah-mine) 12%, transparent); }
.rv-finding[data-flash] { animation: rv-flash 1.4s var(--ah-ease); }

/* The changes */
.rv-diff {
  --ah-bg: var(--dsw-alias-bg-layer-1, Canvas);
  container-type: inline-size; outline: none; min-height: 0; flex: 1 1 auto;
}
.rv-diff-bar { flex: none; display: flex; align-items: center; gap: 2px; min-height: 36px; padding: 4px 8px; box-sizing: border-box; border-bottom: .5px solid var(--ah-line); }
.rv-file-pick {
  appearance: none; display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 46%; height: 28px; padding: 0 8px;
  border: 0; border-radius: var(--ah-radius-sm); background: transparent; cursor: pointer; font-weight: 600;
}
.rv-file-pick:hover { background: var(--ah-hover); }
.rv-file-pick > svg { flex: none; color: var(--ah-fg3); }
.rv-file-pick-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv-diff-sum { display: inline-flex; align-items: center; gap: 8px; margin-left: 6px; color: var(--ah-fg3); font-size: 12px; white-space: nowrap; cursor: help; }
.rv-pick { display: inline-flex; align-items: center; gap: 2px; padding-left: 6px; }
.rv-pick-go {
  appearance: none; height: 26px; padding: 0 11px; border: 0; border-radius: 13px; cursor: pointer; white-space: nowrap;
  color: #fff !important; background: color-mix(in srgb, var(--ah-mine) 92%, #000); font-size: 12px; font-weight: 600;
}
.rv-pick-go:hover { background: color-mix(in srgb, var(--ah-mine) 80%, #000); }
.rv-diff-note { flex: none; margin: 0; padding: 6px 12px; font-size: 12px; color: var(--ah-warn-ink); background: color-mix(in srgb, var(--ah-warn) 10%, transparent); border-bottom: .5px solid var(--ah-line); }
.rv-diff-list { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.rv-diff-list[data-mode="split"] .gp-diff { overflow-x: hidden; }
@container (max-width: 560px) { .rv-diff-sum { display: none; } }

.rv-dl { cursor: text; }
.rv-gut {
  flex: none; position: sticky; left: 0; z-index: 1; display: inline-flex; align-items: center; align-self: stretch; cursor: pointer; user-select: none;
  background: linear-gradient(var(--gp-line-bg), var(--gp-line-bg)), var(--ah-bg);
}
.gp-half .rv-gut { position: relative; }
.gp-wrap .rv-gut { align-items: flex-start; }
.gp-wrap .rv-fm { align-items: flex-start; padding-top: 4px; box-sizing: border-box; }
.gp-wrap .rv-add { top: 10px; }
.gp-wrap .rv-dl[data-k="hunk"] { align-items: center; }
.gp-wrap .rv-dl[data-k="hunk"] .gp-dt, .rv-diff-list .gp-wrap .gp-dl[data-k="note"] .gp-dt { flex: 1 0 auto; white-space: pre; }
.rv-fm { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 12px; align-self: stretch; }
.rv-ln { flex: none; box-sizing: content-box; padding: 0 6px 0 2px; text-align: right; color: var(--ah-fg3); }
.rv-gut:hover .rv-ln { color: var(--ah-fg); }
.rv-dl[data-mark="must"] .rv-fm { box-shadow: inset 3px 0 0 color-mix(in srgb, var(--ah-danger) 75%, transparent); }
.rv-dl[data-mark="nice"] .rv-fm { box-shadow: inset 3px 0 0 color-mix(in srgb, var(--ah-warn) 75%, transparent); }
.rv-fdot {
  position: relative; flex: none; width: 9px; height: 9px; margin: 0 0 0 2px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
  background: var(--ah-warn); box-shadow: 0 0 0 2px var(--ah-bg); transition: transform 120ms ease;
}
.rv-fdot[data-severity="must"] { background: var(--ah-danger); }
.rv-fdot:hover { transform: scale(1.3); }
.rv-fdot::after { content: ''; position: absolute; inset: -5px; }
.rv-dl[data-sel] {
  background: linear-gradient(color-mix(in srgb, var(--ah-mine) 14%, transparent), color-mix(in srgb, var(--ah-mine) 14%, transparent)), var(--gp-line-bg);
}
.rv-dl[data-sel] .rv-gut { box-shadow: inset 2px 0 0 var(--ah-mine); }
.rv-dl[data-sel] .rv-ln { color: var(--ah-mine-ink); opacity: 1; font-weight: 600; }
[data-flash].rv-dl, [data-flash].rv-fh, [data-flash].gp-split-row { animation: rv-flash 1.4s var(--ah-ease); }
@keyframes rv-flash { from { box-shadow: inset 0 0 0 999px color-mix(in srgb, var(--ah-mine) 24%, transparent); } }
.rv-dl[data-k="hunk"] { padding-left: 8px; }
.rv-hx {
  position: sticky; right: 6px; z-index: 2; flex: none; margin-left: auto; height: 18px; padding: 0 8px; border-radius: 9px; box-sizing: border-box;
  border: .5px solid color-mix(in srgb, var(--ah-mine) 45%, transparent); background: var(--ah-bg); color: var(--ah-mine-ink) !important; cursor: pointer;
  font-family: var(--ah-sans) !important; font-size: 11px !important; line-height: 16px; font-style: normal; white-space: nowrap; opacity: .85;
}
.rv-hx:hover { opacity: 1; background: color-mix(in srgb, var(--ah-mine) 10%, var(--ah-bg)); }
.rv-hx[data-done] { opacity: 1; background: color-mix(in srgb, var(--ah-mine) 14%, var(--ah-bg)); }
.rv-gap { pointer-events: none; }
.rv-fh {
  display: flex; align-items: center; gap: 8px; padding-right: 2px; box-sizing: border-box; font-family: var(--ah-sans); font-size: 12px;
  background: var(--ah-layer); border-top: .5px solid var(--ah-line); border-bottom: .5px solid var(--ah-line);
}
.rv-fh-main { position: sticky; left: 0; display: flex; align-items: center; gap: 6px; min-width: 0; max-width: calc(var(--rv-vw, 100%) - 112px); padding: 0 6px 0 2px; }
.rv-fh-fold { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 18px; padding: 0; border: 0; border-radius: var(--ah-radius-sm); background: transparent; cursor: pointer; color: var(--ah-fg3); }
.rv-fh-fold:hover { background: var(--ah-hover); color: var(--ah-fg); }
.rv-chev { display: inline-flex; transition: transform 120ms ease; }
.rv-chev[data-open] { transform: rotate(90deg); }
.rv-fh-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv-fh-dir { color: var(--ah-fg3); }
.rv-fh-name { font-weight: 600; }
.rv-fh-count { flex: none; padding: 0 6px; border-radius: var(--ah-radius-sm); font-size: 11px; line-height: 16px; color: var(--ah-warn-ink); background: color-mix(in srgb, var(--ah-warn) 14%, transparent); }
.rv-note { display: flex; align-items: center; gap: 10px; padding-left: 30px; color: var(--ah-fg3); font-family: var(--ah-sans); font-size: 12px; }

/* An explanation, under the diff */
.rv-explain {
  flex: none; display: flex; flex-direction: column; max-height: 46%; min-height: 150px; font-family: var(--ah-sans); font-size: 13px; line-height: 21px;
  background: var(--ah-bg); border-top: 1px solid color-mix(in srgb, var(--ah-mine) 32%, var(--ah-line)); box-shadow: 0 -8px 24px rgba(0, 0, 0, .08);
  animation: rv-in 160ms var(--ah-ease);
}
.rv-explain-head { flex: none; display: flex; align-items: center; gap: 6px; min-width: 0; padding: 6px 6px 2px 12px; }
.rv-explain-spark { flex: none; color: var(--ah-mine-ink); }
.rv-explain-where {
  appearance: none; min-width: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; font-size: 12px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; cursor: pointer;
}
.rv-explain-where:hover { color: var(--ah-mine-ink); text-decoration: underline; text-underline-offset: 2px; }
.rv-explain-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 14px 10px; overscroll-behavior: contain; }
.rv-explain-wait { display: flex; flex-direction: column; gap: 8px; padding-top: 2px; color: var(--ah-fg3); font-size: 12px; }
.rv-turn + .rv-turn { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--ah-line); }
.rv-turn-q { margin: 0 0 6px; padding: 4px 10px; border-radius: var(--ah-radius); background: var(--ah-soft); font-weight: 500; word-break: break-word; }
.rv-turn-a p { margin: 0 0 6px; }
.rv-turn-a p > strong:first-child { display: inline-block; min-width: 4.6em; margin-right: 4px; color: var(--ah-mine-ink); }
.rv-turn-a code[data-loc] { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px; }
.rv-turn-a code[data-loc]:hover { color: var(--ah-mine-ink); }
.rv-caret { display: inline-block; width: 7px; height: 14px; margin-left: 2px; border-radius: 1px; vertical-align: -2px; background: var(--ah-mine); animation: rv-pulse 1s ease-in-out infinite; }
.rv-explain-ask {
  flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 12px calc(10px + env(safe-area-inset-bottom, 0px));
  border-top: .5px solid var(--ah-line);
}
.rv-explain-ask .rv-input { flex: 1 1 200px; height: 30px; font-size: 13px; }
.rv-explain-ask .rv-warn { flex-basis: 100%; }
.ab-page[data-narrow] .rv-explain { max-height: 58%; }

/* A comment of mine: the + on a line, its mark, the composer under the diff */
.rv-add {
  position: absolute; left: 0; top: 50%; z-index: 2; display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; margin-top: -8px; padding: 0; border: 0; border-radius: 4px; cursor: pointer;
  background: var(--ah-mine); color: #fff; font: 600 13px/1 var(--ah-sans); opacity: 0; transform: scale(.85);
  transition: opacity 100ms ease, transform 100ms ease;
}
.rv-dl:hover .rv-add, .rv-add:focus-visible { opacity: 1; transform: none; }
.rv-add:hover { background: color-mix(in srgb, var(--ah-mine) 82%, #000); }
.rv-fdot[data-severity="mine"] { background: var(--ah-mine); }
.rv-dl[data-mark="mine"] .rv-fm { box-shadow: inset 3px 0 0 color-mix(in srgb, var(--ah-mine) 75%, transparent); }
.rv-pick-alt {
  margin-right: 4px; color: var(--ah-mine-ink) !important; background: transparent;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ah-mine) 55%, transparent);
}
.rv-pick-alt:hover { background: color-mix(in srgb, var(--ah-mine) 12%, transparent); }
.rv-pick-alt[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
.rv-said { color: var(--ah-fg2); background: color-mix(in srgb, var(--ah-mine) 9%, transparent); }
.rv-compose { max-height: 60%; }
.rv-compose-mark {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 4px;
  background: var(--ah-mine); color: #fff; font-weight: 600; font-size: 13px; line-height: 1;
}
.rv-compose-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 4px 12px 0; }
.rv-compose-text { min-height: 72px; max-height: 40vh; font-size: 13px; line-height: 20px; }
.rv-compose-note { margin: 0; }
.rv-compose-foot { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 12px calc(10px + env(safe-area-inset-bottom, 0px)); }
.rv-compose-bot { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 0 1 auto; }
.rv-compose-pick { width: auto; max-width: 200px; height: 30px; padding: 0 6px; resize: none; cursor: pointer; }
.rv-compose-go { flex: none; color: var(--ah-mine-ink); }
.rv-compose-go .rv-spin { vertical-align: -2px; }
.rv-source-label { margin-top: 0; }
.rv-compose[data-thread] { max-height: 70%; }
/* Review threads on my own pull request: a speech mark on their line, the thread above the reply. */
.rv-tdot {
  position: relative; flex: none; display: inline-flex; align-items: center; justify-content: center; width: 11px; height: 11px; padding: 0; border: 0; border-radius: 3px 3px 3px 0;
  background: var(--ah-info); box-shadow: 0 0 0 2px var(--ah-bg); cursor: pointer; transition: transform 120ms ease;
}
.rv-tdot[data-state="waiting"] { background: var(--ah-mine); }
.rv-tdot[data-state="resolved"] { background: color-mix(in srgb, var(--ah-fg3) 70%, transparent); }
.rv-tdot:hover { transform: scale(1.25); }
.rv-tdot::after { content: ''; position: absolute; inset: -5px; }
.rv-dl[data-mark="thread"] .rv-fm { box-shadow: inset 3px 0 0 color-mix(in srgb, var(--ah-info) 65%, transparent); }
.rv-fh-talk {
  flex: none; padding: 0 6px; border: 0; border-radius: var(--ah-radius-sm); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer;
  color: var(--ah-info-ink); background: color-mix(in srgb, var(--ah-info) 12%, transparent);
}
.rv-fh-talk[data-waiting] { color: var(--ah-mine-ink); background: color-mix(in srgb, var(--ah-mine) 12%, transparent); }
.rv-fh-talk:hover { text-decoration: underline; }
.rv-thread { list-style: none; margin: 0 0 4px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.rv-thread-item { padding: 6px 8px; border-radius: var(--ah-radius); background: var(--ah-soft); font-size: 12px; line-height: 18px; }
.rv-thread-item + .rv-thread-item { margin-left: 10px; border-left: 2px solid var(--ah-line); border-radius: 0 var(--ah-radius) var(--ah-radius) 0; }
.rv-thread-head { display: flex; align-items: baseline; gap: 6px; color: var(--ah-fg2); }
.rv-thread-head strong { color: var(--ah-fg); font-weight: 600; }
.rv-thread-head time { margin-left: auto; font-size: 11px; color: var(--ah-fg3); white-space: nowrap; }
.rv-thread-body { overflow-wrap: anywhere; }
.rv-thread-body > :first-child { margin-top: 2px; }
.rv-thread-body > :last-child { margin-bottom: 0; }
.rv-thread-nav { display: inline-flex; align-items: center; gap: 2px; font-size: 11px; color: var(--ah-fg2); font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) { .rv-tdot { transition: none; } }
@container (max-width: 520px) {
  .rv-pick-label { display: none; }
  .rv-compose-bot { flex: 1 1 100%; }
  .rv-compose-pick { flex: 1 1 auto; max-width: none; }
}

/* My own pull requests: the review decision, what waits on me, the response's phases */
.rv-rd[data-rd="APPROVED"] { color: var(--ah-ok-ink); background: color-mix(in srgb, var(--ah-ok) 12%, transparent); }
.rv-rd[data-rd="CHANGES_REQUESTED"] { color: var(--ah-danger-ink); background: color-mix(in srgb, var(--ah-danger) 11%, transparent); }
.rv-rd[data-rd="REVIEW_REQUIRED"] { color: var(--ah-fg2); }
.rv-pending { color: var(--ah-warn-ink); background: color-mix(in srgb, var(--ah-warn) 13%, transparent); font-weight: 500; font-variant-numeric: tabular-nums; }

/* A Linear ticket on a pull request: its mark, id and state as a dot */
.rv-ticket { gap: 5px; color: var(--ah-stage-completed); background: color-mix(in srgb, var(--ah-stage-completed) 11%, transparent); font-variant-numeric: tabular-nums; }
.rv-ticket:hover { background: color-mix(in srgb, var(--ah-stage-completed) 18%, transparent); }
.rv-ticket:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; }
.rv-tmark { flex: none; }
.rv-tdot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--ah-stage-unstarted); }
.rv-tdot[data-stage="backlog"] { background: transparent; border: 1px dashed var(--ah-stage-backlog); width: 5px; height: 5px; }
.rv-tdot[data-stage="started"] { background: var(--ah-stage-started); }
.rv-tdot[data-stage="completed"] { background: var(--ah-stage-completed); }
.rv-tdot[data-stage="canceled"] { background: var(--ah-stage-canceled); }
/* A Sentry issue a pull request fixes: its mark, id and phase as a dot (the alerts' tones) */
.ab-chip.rv-alert { gap: 5px; color: #7c6fde; background: color-mix(in srgb, #7c6fde 11%, transparent); font-variant-numeric: tabular-nums; }
button.ab-chip.rv-alert:hover { background: color-mix(in srgb, #7c6fde 18%, transparent); }
.rv-alert:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 1px; }
.ab-chip.rv-alert[data-muted] { color: var(--ah-fg2); }
.rv-adot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--aa-tone, var(--ah-fg3)); }

/* A response item: who asked, where, and 修改 | 仅回复 | 忽略 */
.rv-respond-head { cursor: default; flex-wrap: wrap; row-gap: 4px; }
.rv-reviewer { font-size: 12px; font-weight: 500; color: var(--ah-fg2); }
/* A compact .ah-seg, inside a finding */
.rv-verdict { flex: none; padding: 1px; border-radius: var(--ah-radius-sm); }
.rv-verdict > button { min-height: 0; height: 20px; padding: 0 8px; border-radius: calc(var(--ah-radius-sm) - 1px); font-size: 11px; line-height: 20px; }
.rv-verdict > button[aria-checked="true"][data-verdict="fix"] { color: var(--ah-warn-ink); }
.rv-verdict > button[aria-checked="true"][data-verdict="reply"] { color: var(--ah-info-ink); }
.rv-verdict > button:disabled { cursor: default; }
.rv-finding[data-verdict="skip"] { border-style: dashed; }
.rv-finding[data-verdict="skip"] > .rv-text { color: var(--ah-fg3); }
.rv-commits { list-style: none; margin: 0 0 4px; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.rv-commits code { font-family: var(--ah-mono); font-size: 11px; color: var(--ah-fg2); margin-right: 6px; }
.rv-reply-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }

@media (hover: none) {
  .rv-add { display: none; }
  .rv-more { opacity: .7; }
  .rv-hx { opacity: 1; }
}
@media (pointer: coarse) {
  .rv-finding-head { min-height: 32px; }
  .rv-card { -webkit-user-select: none; user-select: none; }
  /* 32px of target in 22px of layout: the card's height stays as it is */
  .rv-more { position: relative; }
  .rv-more::after { content: ''; position: absolute; inset: -5px; }
  .rv-run-retry { height: 30px; padding: 0 12px; }
  .rv-stop { height: 30px; padding: 0 12px; }
  .rv-reveal { height: 40px; }
  .rv-card[data-live] .rv-go-stop { opacity: 1; }
  .rv-activity-hide { width: 30px; height: 30px; }
  .rv-hx { height: 22px; line-height: 20px; padding: 0 10px; border-radius: 11px; }
  .rv-fh-fold { width: 28px; height: 22px; }
  .rv-file-pick { height: 36px; }
  .rv-pick-go { height: 32px; border-radius: 16px; }
  .rv-explain-ask .rv-input { height: 38px; }
  .rv-compose-pick, .rv-compose-foot .ah-btn { height: 38px; }
  /* 16px keeps a phone from zooming into the field */
  .rv-compose-text { font-size: 16px; line-height: 22px; }
  .rv-verdict > button { height: 32px; padding: 0 12px; font-size: 12px; }
  .rv-ticket, .rv-alert { min-height: 26px; }
  .rv-merge-pick { width: 40px; }
}
/* Merging my own pull request: a strip under its head, tinted by where it stands */
.rv-merge {
  --rv-tone: var(--ah-fg3);
  container-type: inline-size; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: var(--ah-radius);
  border: 1px solid color-mix(in srgb, var(--rv-tone) 24%, var(--ah-line)); background: color-mix(in srgb, var(--rv-tone) 5%, transparent);
  transition: background-color 160ms ease, border-color 160ms ease;
}
.rv-merge[data-tone="ok"] { --rv-tone: var(--ah-ok); }
.rv-merge[data-tone="warn"] { --rv-tone: var(--ah-warn); }
.rv-merge[data-tone="danger"] { --rv-tone: var(--ah-danger); }
.rv-merge[data-tone="auto"] { --rv-tone: var(--ah-info); }
.rv-merge[data-tone="merged"] { --rv-tone: var(--ah-mine); }
.rv-merge-main { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; min-width: 0; }
.rv-merge-dot {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 8px; height: 8px; margin: 0 2px; border-radius: 50%;
  background: var(--rv-tone); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rv-tone) 22%, transparent);
}
.rv-merge[data-tone="busy"] .rv-merge-dot { animation: rv-merge-pulse 1.2s ease-in-out infinite; }
@keyframes rv-merge-pulse { 50% { opacity: .35; } }
.rv-merge[data-tone="merged"] .rv-merge-dot { width: 24px; height: 24px; margin: 0; color: #fff; background: color-mix(in srgb, var(--ah-mine) 85%, #000); box-shadow: none; }
.rv-merge-text { flex: 1 1 180px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.rv-merge-title { font-size: 13px; line-height: 18px; font-weight: 600; color: color-mix(in srgb, var(--rv-tone) 55%, var(--ah-fg)); overflow-wrap: anywhere; }
.rv-merge[data-tone="muted"] .rv-merge-title, .rv-merge[data-tone="busy"] .rv-merge-title { color: var(--ah-fg2); font-weight: 500; }
.rv-merge-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 10px; font-size: 11px; line-height: 16px; color: var(--ah-fg2); font-variant-numeric: tabular-nums; }
.rv-merge-meta code { font-family: var(--ah-mono); font-size: 11px; }
.rv-merge-meta [data-tone="ok"] { color: var(--ah-ok-ink); }
.rv-merge-meta [data-tone="warn"] { color: var(--ah-warn-ink); }
.rv-merge-meta [data-tone="danger"] { color: var(--ah-danger-ink); }
.rv-merge-meta [data-rd="APPROVED"] { color: var(--ah-ok-ink); }
.rv-merge-meta [data-rd="CHANGES_REQUESTED"] { color: var(--ah-danger-ink); }
.rv-merge-actions { flex: none; display: inline-flex; margin-left: auto; }
.rv-draft { padding: 1px; }
.rv-draft > button { padding: 0 8px; font-size: 11px; line-height: 18px; }
.rv-draft[aria-busy="true"] > button[aria-checked="true"] { opacity: .6; }
.rv-merge-go { gap: 6px; }
.rv-merge-go[data-variant="primary"], .rv-merge-pick {
  border-color: transparent; color: #fff; background: color-mix(in srgb, var(--ah-ok) 76%, #000);
}
.rv-merge-go[data-variant="primary"]:hover:not(:disabled), .rv-merge-pick:hover:not(:disabled) { background: color-mix(in srgb, var(--ah-ok) 64%, #000); }
.rv-merge-go[data-confirm] {
  background: color-mix(in srgb, var(--ah-ok) 60%, #000); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ah-ok) 30%, transparent);
  animation: rv-in 120ms var(--ah-ease);
}
.rv-merge-actions[data-split] > .rv-merge-go { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.rv-merge-pick {
  width: 28px; padding: 0; border-top-left-radius: 0; border-bottom-left-radius: 0;
  border-left: 1px solid color-mix(in srgb, #fff 28%, transparent);
}
.rv-merge-pick[aria-expanded="true"] { background: color-mix(in srgb, var(--ah-ok) 60%, #000); }
.rv-merge-go .rv-spin { width: 10px; height: 10px; }
.rv-merge-note { margin: 0; padding-left: 22px; font-size: 11px; line-height: 16px; color: var(--ah-fg2); animation: rv-in 120ms var(--ah-ease); }
.rv-merge-note[data-tone="danger"] { color: var(--ah-danger-ink); overflow-wrap: anywhere; }
/* A narrow detail (a phone's bottom sheet): the action takes its own row, full width */
@container (max-width: 380px) {
  .rv-merge-actions { flex: 1 1 100%; margin-left: 0; }
  .rv-merge-go { flex: 1; }
  .rv-merge-note { padding-left: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .rv-chip[data-live]::before, .rv-step[data-state="now"] .rv-step-mark, .rv-spin, .rv-run-bar i[data-on="now"], .rv-activity { animation: none; }
  .rv-explain, .rv-caret, [data-flash].rv-dl, [data-flash].rv-fh, [data-flash].gp-split-row, .rv-finding[data-flash] { animation: none; }
  .rv-chev, .rv-fdot, .rv-add { transition: none; }
  .rv-stop-all[data-confirm], .rv-skeleton-card { animation: none; }
  .rv-merge, .rv-merge-dot, .rv-merge-go[data-confirm], .rv-merge-note { animation: none; transition: none; }
}
`

export function injectReviewStyle(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.review'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}
