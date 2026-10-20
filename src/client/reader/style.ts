/**
 * Reader stylesheet, `rd-` prefixed, on the shared tokens and controls of theme/base.ts. The page
 * sizes itself by its own width (a container), not the window's: three columns from 1100px, the
 * feeds as a rail of icons from 640px, one column at a time below. The article column carries a
 * reading theme of its own (auto follows DSH); its type is set by the person, per device.
 */

const CSS = `
.rd-root { height: 100%; min-height: 0; container-type: inline-size; container-name: rd; color: var(--ah-fg); font-size: 13px; line-height: 20px; }
.rd-page { display: grid; grid-template-columns: 232px minmax(280px, 340px) minmax(0, 1fr); height: 100%; min-height: 0; overflow: hidden; }
.rd-page > * { min-width: 0; min-height: 0; }

/* Controls */
.rd-icon {
  appearance: none; display: inline-grid; place-items: center; flex: none; width: 34px; height: 34px; padding: 0; border: 0;
  border-radius: var(--ah-radius); background: transparent; color: var(--ah-fg2); cursor: pointer; text-decoration: none;
  transition: background-color 120ms ease, color 120ms ease; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
}
.rd-icon:hover:not(:disabled) { background: var(--ah-hover); color: var(--ah-fg); }
.rd-icon:focus-visible, .rd-source:focus-visible, .rd-entry:focus-visible, .rd-analyze:focus-visible, .rd-menu-item:focus-visible,
.rd-segment button:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.rd-icon[aria-pressed="true"] { color: var(--ah-fg); background: var(--ah-hover); }
.rd-icon:disabled { opacity: .45; cursor: default; }
.rd-icon[data-spin] svg { animation: rd-spin 900ms linear infinite; }
@keyframes rd-spin { to { transform: rotate(360deg); } }
.rd-only-narrow { display: none; }
.rd-anchor { position: relative; display: inline-flex; }
.rd-bar { display: flex; align-items: center; gap: 2px; min-height: 52px; padding: 8px 8px 8px 16px; box-sizing: border-box; border-bottom: 1px solid var(--ah-line); }
.rd-title { flex: 1; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; line-height: 22px; font-weight: 600; }
.rd-hint { margin: 6px 0; color: var(--ah-fg2); font-size: 12px; line-height: 18px; }
.rd-empty { padding: 24px 16px; text-align: center; }
.rd-count { flex: none; min-width: 20px; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 18px; text-align: center; color: var(--ah-fg2); background: var(--ah-soft); font-variant-numeric: tabular-nums; }
.rd-banner { display: flex; align-items: center; gap: 6px; margin: 8px 12px 0; padding: 8px 10px; border-radius: var(--ah-radius); font-size: 12px; color: var(--ah-warn-ink); background: color-mix(in srgb, var(--ah-warn) 12%, transparent); overflow-wrap: anywhere; }

/* Popovers */
.rd-pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: var(--ah-z-menu); box-sizing: border-box; width: 300px; max-width: calc(100cqw - 24px);
  display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--ah-line-strong); border-radius: var(--ah-radius-lg);
  background: var(--ah-popup); color: var(--ah-fg); box-shadow: var(--ah-shadow); font-size: 13px; line-height: 20px;
  animation: rd-pop-in 160ms var(--ah-ease);
}
@keyframes rd-pop-in { from { opacity: 0; transform: translateY(-4px) scale(.98); } }
.rd-add { left: 0; right: auto; width: 340px; }
.rd-add form { display: flex; flex-direction: column; gap: 8px; }
.rd-add-row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.rd-add-row .rd-input { flex: 1; min-width: 0; }
.rd-input { box-sizing: border-box; height: 34px; padding: 0 10px; border: 1px solid var(--ah-line-strong); border-radius: var(--ah-radius); background: var(--ah-bg); color: var(--ah-fg); font: inherit; }
.rd-input:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 0; }
.rd-field { display: flex; flex-direction: column; gap: 6px; }
.rd-field-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--ah-fg2); }
.rd-field-label output { color: var(--ah-fg); font-variant-numeric: tabular-nums; }
.rd-field input[type="range"] { width: 100%; accent-color: var(--ah-info); }
.rd-segment { display: flex; gap: 2px; padding: 2px; border-radius: var(--ah-radius); background: var(--ah-soft); border: 1px solid var(--ah-line); }
.rd-segment button { flex: 1; min-height: 30px; border: 0; border-radius: 6px; background: transparent; color: var(--ah-fg2); font: inherit; font-size: 12px; cursor: pointer; }
.rd-segment button[aria-checked="true"] { background: var(--ah-popup); color: var(--ah-fg); font-weight: 500; box-shadow: 0 1px 2px rgb(0 0 0 / .14); }
.rd-segment button[data-swatch="light"]::before, .rd-segment button[data-swatch="sepia"]::before, .rd-segment button[data-swatch="dark"]::before {
  content: ''; display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 50%; vertical-align: -1px; border: 1px solid var(--ah-line-strong);
}
.rd-segment button[data-swatch="light"]::before { background: #fff; }
.rd-segment button[data-swatch="sepia"]::before { background: #f4ecd8; }
.rd-segment button[data-swatch="dark"]::before { background: #17191e; }
.rd-menu { width: 200px; gap: 2px; padding: 6px; }
.rd-menu-item {
  display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 0 10px; border: 0; border-radius: var(--ah-radius-sm); background: transparent;
  color: inherit; font: inherit; text-align: left; text-decoration: none; cursor: pointer;
}
.rd-menu-item:hover { background: var(--ah-hover); }
.rd-menu-item[data-danger] { color: var(--ah-danger-ink); }

/* Feeds */
.rd-sources { display: flex; flex-direction: column; border-right: 1px solid var(--ah-line); }
.rd-sources-list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; }
.rd-source {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; box-sizing: border-box; padding: 0 8px; border: 0; border-radius: var(--ah-radius);
  background: transparent; color: var(--ah-fg2); font: inherit; text-align: left; cursor: pointer; transition: background-color 120ms ease;
}
.rd-source:hover { background: var(--ah-hover); color: var(--ah-fg); }
.rd-source[aria-current="true"] { background: color-mix(in srgb, currentColor 9%, transparent); color: var(--ah-fg); font-weight: 500; }
.rd-source-icon { flex: none; display: inline-grid; place-items: center; width: 22px; height: 22px; }
.rd-source-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-source-warn { flex: none; display: inline-grid; color: var(--ah-warn-ink); }
.rd-avatar { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; font-size: 11px; font-weight: 600; color: var(--ah-fg2); background: var(--ah-soft); border: 1px solid var(--ah-line); }
.rd-group { margin: 14px 8px 4px; font-size: 11px; font-weight: 600; color: var(--ah-fg3); letter-spacing: .02em; }

/* Entries */
.rd-list { display: flex; flex-direction: column; border-right: 1px solid var(--ah-line); }
.rd-items { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; overscroll-behavior: contain; }
.rd-entry {
  display: flex; flex-direction: column; gap: 4px; width: 100%; box-sizing: border-box; padding: 10px 12px; border: 0; border-radius: var(--ah-radius);
  background: transparent; color: var(--ah-fg2); font: inherit; text-align: left; cursor: pointer; transition: background-color 120ms ease;
}
.rd-entry:hover { background: var(--ah-hover); }
/* Rows off screen are not laid out or painted: a list of hundreds scrolls as lightly as a short one. */
.rd-items > .rd-entry, .rd-items > .rd-fav { content-visibility: auto; contain-intrinsic-size: auto 96px; }
.rd-entry[aria-current="true"], .rd-fav[aria-current="true"] .rd-entry { background: color-mix(in srgb, currentColor 9%, transparent); }
.rd-entry-meta { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 11px; line-height: 16px; color: var(--ah-fg3); }
.rd-entry-feed { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-entry-feed + span::before { content: '·'; margin-right: 6px; }
.rd-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--ah-info); }
.rd-entry-title { color: var(--ah-fg); font-size: 14px; line-height: 20px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.rd-entry[data-unread] .rd-entry-title { font-weight: 600; }
.rd-entry-summary { font-size: 12px; line-height: 18px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.rd-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; }
.rd-chip { padding: 0 6px; border-radius: 4px; font-size: 11px; line-height: 18px; color: var(--ah-fg2); background: var(--ah-soft); border: 1px solid var(--ah-line); font-variant-numeric: tabular-nums; }
/* The list's end */
.rd-foot { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 6px 20px; }
.rd-more {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; max-width: 320px; min-height: 40px;
  box-sizing: border-box; padding: 0 16px; border: 1px solid var(--ah-line-strong); border-radius: var(--ah-radius); background: transparent;
  color: var(--ah-fg2); font: inherit; font-size: 13px; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease, transform 80ms ease;
}
.rd-more:hover:not(:disabled) { background: var(--ah-hover); color: var(--ah-fg); border-color: var(--ah-fg3); }
.rd-more:active:not(:disabled) { transform: scale(.98); }
.rd-more:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 2px; }
.rd-more:disabled { cursor: progress; }
.rd-spinner { width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: rd-spin 700ms linear infinite; }
.rd-foot-note { max-width: 320px; margin: 0; color: var(--ah-fg3); font-size: 12px; line-height: 18px; text-align: center; overflow-wrap: anywhere; }
.rd-foot-note[role="alert"] { color: var(--ah-danger-ink); }
.rd-end { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 4px 12px; margin: 8px 0 0; color: var(--ah-fg3); font-size: 12px; line-height: 18px; text-align: center; }
.rd-end > span:first-child { display: inline-flex; align-items: center; gap: 10px; }
.rd-end > span:first-child::before, .rd-end > span:first-child::after { content: ''; width: 24px; border-top: 1px solid var(--ah-line); }
.rd-end a { display: inline-flex; align-items: center; gap: 4px; min-height: 24px; color: var(--ah-info-ink); text-decoration: none; }
.rd-end a:hover { text-decoration: underline; text-underline-offset: .2em; }
.rd-end a:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 2px; border-radius: 4px; }
.rd-end-hint { flex-basis: 100%; }
.rd-fav { position: relative; }
.rd-fav .rd-entry { padding-right: 44px; }
.rd-fav-remove { position: absolute; top: 6px; right: 4px; opacity: 0; }
.rd-fav:hover .rd-fav-remove, .rd-fav-remove:focus-visible { opacity: 1; }
.rd-fav-quote { padding-left: 10px; border-left: 2px solid color-mix(in srgb, var(--ah-warn) 70%, transparent); color: var(--ah-fg); font-size: 13px; line-height: 20px; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.rd-skeleton { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
.rd-skeleton i { display: block; height: 10px; border-radius: 4px; background: var(--ah-soft); animation: rd-pulse 1.4s ease-in-out infinite; }
.rd-skeleton i:nth-child(1) { width: 30%; } .rd-skeleton i:nth-child(2) { width: 90%; height: 14px; } .rd-skeleton i:nth-child(3) { width: 70%; }
.rd-skeleton-body i { width: 100% !important; height: 12px !important; } .rd-skeleton-body i:last-child { width: 60% !important; }
@keyframes rd-pulse { 50% { opacity: .45; } }

/* The article: its own theme. */
.rd-reader {
  --rd-bg: var(--ah-bg); --rd-fg: var(--ah-fg); --rd-muted: var(--ah-fg2); --rd-line: var(--ah-line); --rd-mark: color-mix(in srgb, #f5c400 30%, transparent); --rd-link: var(--ah-info-ink);
  display: flex; flex-direction: column; background: var(--rd-bg); color: var(--rd-fg); transition: background-color 160ms ease, color 160ms ease;
}
.rd-reader[data-theme="light"] { --rd-bg: #ffffff; --rd-fg: #1f2328; --rd-muted: #59636e; --rd-line: rgb(31 35 40 / .12); --rd-mark: #fff1a8; --rd-link: #0b57d0; color-scheme: light; }
.rd-reader[data-theme="sepia"] { --rd-bg: #f4ecd8; --rd-fg: #3b2f22; --rd-muted: #6e5d47; --rd-line: rgb(59 47 34 / .16); --rd-mark: #ead48a; --rd-link: #8a4b12; color-scheme: light; }
.rd-reader[data-theme="dark"] { --rd-bg: #17191e; --rd-fg: #d7dae0; --rd-muted: #9aa3ad; --rd-line: rgb(215 218 224 / .14); --rd-mark: #5a4a10; --rd-link: #8ab4f8; color-scheme: dark; }
.rd-tools {
  display: flex; align-items: center; gap: 2px; min-height: 52px; box-sizing: border-box; padding: 8px 12px; border-bottom: 1px solid var(--rd-line);
  background: var(--rd-bg); color: var(--rd-fg);
}
.rd-tools .rd-icon { color: var(--rd-muted); }
.rd-tools .rd-icon:hover:not(:disabled), .rd-tools .rd-icon[aria-pressed="true"] { color: var(--rd-fg); background: color-mix(in srgb, var(--rd-fg) 8%, transparent); }
.rd-tools .rd-icon[aria-pressed="true"] svg[fill="currentColor"] { color: var(--ah-warn); }
.rd-tools-gap { flex: 1; }
.rd-analyze {
  display: inline-flex; align-items: center; gap: 6px; height: 34px; margin-left: 6px; padding: 0 12px; border: 1px solid color-mix(in srgb, var(--rd-fg) 18%, transparent);
  border-radius: var(--ah-radius); background: transparent; color: var(--rd-fg); font: inherit; font-size: 13px; cursor: pointer; transition: background-color 120ms ease;
}
.rd-analyze:hover { background: color-mix(in srgb, var(--rd-fg) 7%, transparent); }
.rd-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scroll-padding-top: 16px; }
.rd-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 60%; padding: 32px; color: var(--rd-muted); text-align: center; }
.rd-placeholder p { margin: 0; }
.rd-keys { font-size: 12px; opacity: .8; }
.rd-article {
  --rd-serif: "Iowan Old Style", "Charter", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "STSong", "SimSun", Georgia, serif;
  --rd-sans: -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", var(--ah-sans);
  box-sizing: content-box; max-width: var(--rd-width, 68ch); margin: 0 auto; padding: 32px 28px 96px;
  font-family: var(--rd-serif); font-size: var(--rd-size, 18px); line-height: var(--rd-leading, 1.8); color: var(--rd-fg);
  font-kerning: normal; text-rendering: optimizeLegibility; hanging-punctuation: first;
}
.rd-reader[data-font="sans"] .rd-article { font-family: var(--rd-sans); }
.rd-article ::selection { background: color-mix(in srgb, var(--ah-info) 30%, transparent); }
.rd-article-head { margin-bottom: 1.6em; }
.rd-article h1 { margin: .2em 0 .4em; font-size: 1.6em; line-height: 1.3; font-weight: 700; letter-spacing: -.01em; text-wrap: balance; overflow-wrap: anywhere; }
.rd-byline { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: 0; font-family: var(--rd-sans); font-size: 13px; line-height: 20px; color: var(--rd-muted); }
.rd-badge { padding: 0 6px; border-radius: 4px; font-size: 11px; line-height: 18px; color: var(--ah-ok-ink); background: color-mix(in srgb, var(--ah-ok) 12%, transparent); }
.rd-article .rd-chips { font-family: var(--rd-sans); }
.rd-notice { margin: 0 0 1.2em; padding: 10px 12px; border-radius: var(--ah-radius); font-family: var(--rd-sans); font-size: 13px; line-height: 20px; color: var(--rd-muted); background: color-mix(in srgb, var(--rd-fg) 5%, transparent); }
.rd-body .rv-md { font: inherit; color: inherit; overflow-wrap: break-word; word-break: normal; }
.rd-body .rv-md > * { margin: 0 0 1em; }
.rd-body .rv-md h1, .rd-body .rv-md h2, .rd-body .rv-md h3, .rd-body .rv-md h4, .rd-body .rv-md h5, .rd-body .rv-md h6 { margin: 1.6em 0 .6em; line-height: 1.35; font-weight: 700; text-wrap: balance; }
.rd-body .rv-md h1 { font-size: 1.4em; } .rd-body .rv-md h2 { font-size: 1.25em; } .rd-body .rv-md h3 { font-size: 1.1em; } .rd-body .rv-md h4, .rd-body .rv-md h5, .rd-body .rv-md h6 { font-size: 1em; }
.rd-body .rv-md a { color: var(--rd-link); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: .2em; }
.rd-body .rv-md img { display: block; max-width: 100%; height: auto; margin: 1.2em auto; border-radius: var(--ah-radius); }
/* Badges (a README's shields, linked images in a row) sit in their line, as GitHub shows them. */
.rd-body .rv-md a img, .rd-body .rv-md img[src*="shields.io"], .rd-body .rv-md img[src*="badge"] { display: inline-block; margin: 2px 3px; vertical-align: middle; border-radius: 0; }
.rd-body .rv-md blockquote { margin: 1.2em 0; padding: 0 0 0 1em; border-left: 3px solid var(--rd-line); color: var(--rd-muted); }
.rd-body .rv-md ul, .rd-body .rv-md ol { padding-left: 1.5em; }
.rd-body .rv-md li + li { margin-top: .3em; }
.rd-body .rv-md code { padding: .1em .35em; font-size: .85em; border-radius: 4px; background: color-mix(in srgb, var(--rd-fg) 7%, transparent); }
.rd-body .rv-md pre { padding: 12px 14px; font-size: .8em; line-height: 1.55; border-radius: var(--ah-radius); background: color-mix(in srgb, var(--rd-fg) 6%, transparent); }
.rd-body .rv-md pre code { padding: 0; font-size: 1em; background: none; }
.rd-body .rv-md table { font-family: var(--rd-sans); font-size: .8em; }
.rd-body .rv-md th, .rd-body .rv-md td { border-color: var(--rd-line); padding: 6px 10px; }
.rd-body .rv-md hr { margin: 2em 0; border-top-color: var(--rd-line); }
.rd-body mark { background: var(--rd-mark); color: inherit; border-radius: 2px; padding: 0 1px; }
.rd-note { margin-top: 2.4em; padding: 16px 18px; border-radius: var(--ah-radius-lg); border: 1px solid var(--rd-line); font-family: var(--rd-sans); font-size: 14px; line-height: 1.7; }
.rd-note h2 { margin: 0 0 8px; font-size: 13px; color: var(--rd-muted); }
.rd-session { width: 320px; }
/* A release's notes, folded above its repository's README. */
.rd-release { margin: 0 0 1.6em; border: 1px solid var(--rd-line); border-radius: var(--ah-radius-lg); font-family: var(--rd-sans); font-size: 14px; line-height: 1.7; }
.rd-release summary {
  display: flex; align-items: center; gap: 8px; min-height: 44px; box-sizing: border-box; padding: 0 14px; color: var(--rd-muted); cursor: pointer;
  list-style: none; border-radius: var(--ah-radius-lg); -webkit-tap-highlight-color: transparent; transition: background-color 120ms ease, color 120ms ease;
}
.rd-release summary::-webkit-details-marker { display: none; }
.rd-release summary::after { content: ''; width: 7px; height: 7px; margin-left: auto; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg) translateY(-2px); transition: transform 160ms var(--ah-ease); }
.rd-release[open] summary::after { transform: rotate(225deg) translateY(-2px); }
.rd-release summary:hover { color: var(--rd-fg); background: color-mix(in srgb, var(--rd-fg) 5%, transparent); }
.rd-release summary:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.rd-release[open] summary { border-bottom: 1px solid var(--rd-line); border-radius: var(--ah-radius-lg) var(--ah-radius-lg) 0 0; }
.rd-release-body { padding: 4px 16px 8px; overflow-wrap: break-word; }
.rd-release-body .rv-md { font: inherit; color: inherit; }
.rd-release-body .rv-md a { color: var(--rd-link); }
.rd-release-body .rv-md img { max-width: 100%; height: auto; }

/* Medium: the feeds fold to a rail of icons. */
@container rd (max-width: 1099px) {
  .rd-page { grid-template-columns: 60px minmax(260px, 320px) minmax(0, 1fr); }
  .rd-sources .rd-bar { flex-direction: column; justify-content: flex-start; padding: 8px 0; gap: 4px; min-height: 0; }
  .rd-sources .rd-title, .rd-source-label, .rd-group, .rd-sources .rd-hint, .rd-source-warn { display: none; }
  .rd-sources-list { padding: 6px; }
  .rd-source { position: relative; justify-content: center; padding: 0; min-height: 44px; }
  .rd-source .rd-count { position: absolute; top: 3px; right: 1px; min-width: 16px; padding: 0 4px; font-size: 10px; line-height: 15px; }
}
/* Narrow: one column at a time, each with a way back. */
@container rd (max-width: 639px) {
  .rd-page { grid-template-columns: minmax(0, 1fr); }
  .rd-page > * { display: none !important; border-right: 0; }
  .rd-page[data-pane="sources"] > .rd-sources, .rd-page[data-pane="list"] > .rd-list, .rd-page[data-pane="article"] > .rd-reader { display: flex !important; }
  .rd-only-narrow { display: inline-grid; }
  .rd-sources .rd-bar { flex-direction: row; padding: 8px 8px 8px 16px; min-height: 52px; }
  .rd-sources .rd-title, .rd-source-label, .rd-group, .rd-sources .rd-hint, .rd-source-warn { display: revert; }
  .rd-source { justify-content: flex-start; padding: 0 10px; min-height: 48px; font-size: 15px; }
  .rd-source .rd-count { position: static; font-size: 12px; line-height: 20px; }
  .rd-icon { width: 44px; height: 44px; }
  .rd-analyze { height: 40px; }
  .rd-analyze span { display: none; }
  .rd-entry { padding: 12px; }
  .rd-more { min-height: 44px; max-width: none; font-size: 15px; }
  .rd-foot-note, .rd-end { font-size: 13px; }
  .rd-end a { min-height: 44px; }
  .rd-entry-title { font-size: 16px; line-height: 23px; }
  .rd-fav-remove { opacity: 1; }
  .rd-tools { padding: 4px 6px; gap: 0; }
  .rd-article { padding: 20px 18px 96px; }
  .rd-article h1 { font-size: 1.45em; }
  .rd-input, .rd-pop { font-size: 16px; }
  .rd-pop { position: fixed; top: auto; left: 8px !important; right: 8px; bottom: max(8px, env(safe-area-inset-bottom)); width: auto; max-width: none; }
}
@media (prefers-reduced-motion: reduce) {
  .rd-root *, .rd-root *::before { animation: none !important; transition: none !important; }
}
`

export function injectReaderStyle(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-agent-hub.reader'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}
