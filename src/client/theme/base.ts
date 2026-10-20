/**
 * The plugin's one design layer, `ah-` prefixed: the tokens every module styles with, and the two
 * controls they share (buttons, segmented choices). Modules keep only what is theirs alone (graph
 * lanes, editor selection, terminal palette, board workflow states).
 *
 * Tokens sit on <body>, where DSH defines its own `--dsw-*` aliases for both themes, so every alias
 * below resolves against the active theme; the fallbacks keep a page without them readable.
 *
 * Hue carries meaning only, one value per meaning in both themes. Fills (dots, bars, gutters,
 * tints) use the hue itself; text uses its `-ink`, the hue mixed toward the text colour at the
 * point of use, which keeps it at 4.5:1 or better on the page and on the hue's own 12% tint in
 * either theme without a dark-theme override.
 *
 * Scale: text 11 / 12 / 13 / 15px (mono 12px), radius 6 / 8 / 12px (nested shapes inset by their
 * padding), layers float / menu / modal, motion 120ms for state and 160ms for movement on --ah-ease, all off with reduced motion.
 */

const CSS = `
body {
  --ah-fg: var(--dsw-alias-label-primary, currentColor);
  --ah-fg2: var(--dsw-alias-label-secondary, color-mix(in srgb, currentColor 74%, transparent));
  --ah-fg3: var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 52%, transparent));
  --ah-line: var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 10%, transparent));
  --ah-line-strong: var(--dsw-alias-border-l4, color-mix(in srgb, currentColor 16%, transparent));
  --ah-soft: color-mix(in srgb, currentColor 4%, transparent);
  --ah-hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 7%, transparent));
  --ah-bg: var(--dsw-alias-bg-base, Canvas);
  --ah-layer: var(--dsw-alias-bg-layer-1, Canvas);
  --ah-popup: var(--dsw-alias-bg-layer-2, Canvas);
  --ah-shadow: var(--dsw-elevation-panel, 0 6px 24px rgb(0 0 0 / .18));
  --ah-accent: var(--dsw-alias-brand-primary, currentColor);

  --ah-ok: #30a46c;
  --ah-warn: #d38b1f;
  --ah-danger: #e5484d;
  --ah-info: #3e7cf0;
  --ah-mine: #8e4ec6;
  --ah-ok-ink: color-mix(in srgb, var(--ah-ok) 65%, currentColor);
  --ah-warn-ink: color-mix(in srgb, var(--ah-warn) 65%, currentColor);
  --ah-danger-ink: color-mix(in srgb, var(--ah-danger) 65%, currentColor);
  --ah-info-ink: color-mix(in srgb, var(--ah-info) 65%, currentColor);
  --ah-mine-ink: color-mix(in srgb, var(--ah-mine) 65%, currentColor);
  /* Change kinds, the same in the change list, the gutter and the graph. */
  --ah-add: var(--ah-ok);
  --ah-del: var(--ah-danger);
  --ah-mod: var(--ah-warn);
  --ah-ren: var(--ah-info);
  /* Ticket workflow stages, Linear's and local tasks': the board, reviews and the ticket picker. */
  --ah-stage-backlog: color-mix(in srgb, currentColor 38%, transparent);
  --ah-stage-unstarted: color-mix(in srgb, currentColor 62%, transparent);
  --ah-stage-started: var(--ah-warn);
  --ah-stage-completed: #5e6ad2;
  --ah-stage-canceled: color-mix(in srgb, currentColor 30%, transparent);
  /* DSH's own focus ring colour is transparent, so the plugin draws its own. */
  --ah-focus: color-mix(in srgb, var(--ah-info) 80%, transparent);

  --ah-sans: var(--dsw-font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  --ah-mono: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace);
  --ah-radius-sm: 6px;
  --ah-radius: 8px;
  --ah-radius-lg: 12px;
  --ah-ease: cubic-bezier(.2, .8, .2, 1);
  /* Layers over the host page: notices and popovers, then menus (their scrim one below), then dialogs. */
  --ah-z-float: 9000;
  --ah-z-menu: 10000;
  --ah-z-modal: 10001;
}

/* Buttons: bordered by default; data-variant="primary" | "danger" | "quiet"; .ah-btn-sm is 26px. */
.ah-btn {
  appearance: none; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  flex: none; height: 30px; min-width: 0; padding: 0 12px; border: 1px solid var(--ah-line-strong); border-radius: var(--ah-radius);
  background: transparent; color: inherit; font: inherit; font-size: 12px; line-height: 1; white-space: nowrap; text-decoration: none;
  cursor: pointer; -webkit-tap-highlight-color: transparent;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 80ms ease;
}
.ah-btn:hover:not(:disabled) { background: var(--ah-hover); }
.ah-btn:active:not(:disabled) { transform: scale(.98); }
.ah-btn[aria-pressed="true"] { background: var(--ah-hover); border-color: var(--ah-fg3); }
.ah-btn[data-variant="primary"] {
  border-color: transparent; background: var(--dsw-alias-button-primary-fill, var(--ah-fg)); color: var(--ah-bg);
}
.ah-btn[data-variant="primary"]:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, color-mix(in srgb, var(--ah-fg) 85%, transparent));
}
.ah-btn[data-variant="danger"] { border-color: transparent; background: color-mix(in srgb, var(--ah-danger) 85%, #000); color: #fff; }
.ah-btn[data-variant="danger"]:hover:not(:disabled) { background: color-mix(in srgb, var(--ah-danger) 72%, #000); }
.ah-btn[data-variant="quiet"] { border-color: transparent; color: var(--ah-fg2); }
.ah-btn[data-variant="quiet"]:hover:not(:disabled) { color: var(--ah-fg); }
.ah-btn:disabled { opacity: .45; cursor: default; }
.ah-btn-sm { height: 26px; padding: 0 9px; gap: 4px; }

.ah-icon-btn {
  appearance: none; box-sizing: border-box; flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--ah-radius-sm); background: transparent;
  color: var(--ah-fg2); font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent;
  transition: background-color 120ms ease, color 120ms ease;
}
.ah-icon-btn:hover:not(:disabled), .ah-icon-btn[aria-pressed="true"] { background: var(--ah-hover); color: var(--ah-fg); }
.ah-icon-btn:disabled { opacity: .35; cursor: default; }

/* A choice of a few: a radiogroup of buttons with aria-checked, or a tablist with aria-selected. */
.ah-seg {
  display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--ah-radius); border: 1px solid var(--ah-line);
  background: var(--ah-soft); box-sizing: border-box;
}
.ah-seg > button {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 0;
  padding: 2px 10px; border: 0; border-radius: var(--ah-radius-sm); background: transparent; color: var(--ah-fg2);
  font: inherit; font-size: 12px; line-height: 20px; white-space: nowrap; cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.ah-seg > button:hover { color: var(--ah-fg); }
.ah-seg > button[aria-checked="true"], .ah-seg > button[aria-selected="true"] {
  background: var(--ah-layer); color: var(--ah-fg); font-weight: 600; box-shadow: 0 0 0 .5px var(--ah-line), 0 1px 2px rgb(0 0 0 / .1);
}

.ah-btn:focus-visible, .ah-icon-btn:focus-visible, .ah-seg > button:focus-visible {
  outline: 2px solid var(--ah-focus); outline-offset: 1px;
}

@media (pointer: coarse) {
  .ah-btn { height: 36px; padding: 0 14px; font-size: 13px; }
  .ah-btn-sm { height: 32px; padding: 0 11px; }
  .ah-icon-btn { width: 36px; height: 36px; }
  .ah-seg > button { min-height: 32px; padding: 0 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .ah-btn, .ah-icon-btn, .ah-seg > button { transition: none; }
  .ah-btn:active:not(:disabled) { transform: none; }
}
`

/** Installed for the plugin's lifetime, ahead of every module's sheet so theirs can refine it. */
export function injectBaseStyle(): () => void {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-agent-hub'
  tag.dataset.pluginCss = 'dsh-agent-hub/base'
  tag.textContent = CSS
  document.head.prepend(tag)
  return () => tag.remove()
}
