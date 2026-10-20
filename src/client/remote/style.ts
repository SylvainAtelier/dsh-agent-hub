/**
 * Phone access styles, `ra-` prefixed, plus the mobile layer for DSH itself.
 *
 * Panel: a centered dialog on wide screens, a bottom sheet within thumb reach
 * on narrow ones; 44px targets wherever the pointer is coarse. On the shared
 * tokens and controls of theme/base.ts; green marks "on" only.
 *
 * Mobile layer: DSH's web UI is laid out for a desktop. On a narrow touch
 * screen (a phone opening it through phone access) a few official surfaces
 * are adjusted by their CSS-module class suffixes. Pure CSS, scoped by one
 * media query, so a desktop never sees it and nothing in the DOM is moved.
 */

const PANEL = `
.ra-entry-wrap { flex: 1 0 100%; min-width: 0; }
.ra-entry-wrap:not([data-wide]) { flex: none; display: flex; justify-content: center; }
.ra-entry {
  appearance: none; box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px;
  padding: 6px 10px; border: none; border-radius: var(--ah-radius); background: transparent; color: inherit; font: inherit; font-size: 13px;
  text-align: left; cursor: pointer; transition: background-color 140ms ease;
}
.ra-entry-wrap:not([data-wide]) .ra-entry { width: 36px; height: 36px; padding: 0; justify-content: center; }
.ra-entry:hover, .ra-entry[aria-expanded="true"] { background: var(--ah-hover); }
.ra-entry:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.ra-entry-icon { position: relative; display: inline-flex; flex: none; color: var(--ah-fg2); }
.ra-entry-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ra-entry-status { flex: none; font-size: 12px; color: var(--ah-fg2); }
.ra-entry[data-tone="on"] .ra-entry-status { color: var(--ah-ok-ink); }

.ra-dot { display: none; width: 7px; height: 7px; border-radius: 50%; background: var(--ah-ok); }
[data-tone="on"] .ra-dot { display: inline-block; }

.ra-backdrop {
  position: fixed; inset: 0; z-index: var(--ah-z-modal); display: flex; align-items: center; justify-content: center; padding: 16px;
  background: rgba(0, 0, 0, .32); animation: ra-fade 160ms ease;
}
.ra-sheet {
  box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; width: min(360px, 100%); max-height: calc(100dvh - 32px);
  overflow-y: auto; padding: 18px 20px 20px; border-radius: 16px; outline: none;
  border: 1px solid var(--ah-line);
  box-shadow: 0 24px 48px -12px rgba(0, 0, 0, .35), 0 2px 8px rgba(0, 0, 0, .12);
  animation: ra-rise 200ms var(--ah-ease);
}
@keyframes ra-fade { from { opacity: 0; } }
@keyframes ra-rise { from { opacity: 0; transform: translateY(8px) scale(.98); } }
.ra-head { display: flex; align-items: center; gap: 8px; }
.ra-head h2 { flex: 1; margin: 0; font-size: 15px; font-weight: 600; }
.ra-close { margin: -6px -8px -6px 0; }

.ra-lead { margin: 0; font-size: 13px; line-height: 1.6; }
.ra-note, .ra-caption { margin: 0; font-size: 12px; line-height: 1.5; color: var(--ah-fg2); }
.ra-caption { text-align: center; margin-top: -4px; }
.ra-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--ah-danger-ink); }

.ra-qr { align-self: center; padding: 12px; border-radius: var(--ah-radius-lg); background: #fff; line-height: 0; box-shadow: 0 0 0 1px rgba(0, 0, 0, .06); }
.ra-url {
  display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 12px; border-radius: var(--ah-radius);
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.ra-url-text {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
  font-family: var(--ah-mono); font-size: 12px; color: var(--ah-fg2);
}
.ra-foot { display: flex; align-items: center; gap: 12px; padding-top: 12px; border-top: 1px solid var(--ah-line); }
.ra-state { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ah-fg2); }
.ra-state .ra-dot { flex: none; }
.ra-actions { display: flex; flex-direction: column; gap: 8px; }

.ra-skeleton { height: 120px; border-radius: var(--ah-radius-lg); background: color-mix(in srgb, currentColor 6%, transparent);
  animation: ra-appear 360ms ease 180ms both, ra-pulse 2.8s ease-in-out 540ms infinite; }
@keyframes ra-appear { from { opacity: 0; } }
@keyframes ra-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .6; } }

/* Narrow screens: a bottom sheet in thumb reach. */
@media (max-width: 560px) {
  .ra-backdrop { align-items: flex-end; padding: 0; }
  .ra-sheet {
    width: 100%; max-height: 92dvh; border-radius: 16px 16px 0 0; border-width: 1px 0 0;
    padding: 12px 20px calc(20px + env(safe-area-inset-bottom)); animation-name: ra-up;
  }
  .ra-sheet::before { content: ''; align-self: center; width: 36px; height: 4px; border-radius: 2px; background: currentColor; opacity: .2; }
  @keyframes ra-up { from { transform: translateY(24px); opacity: .6; } }
}
@media (pointer: coarse) {
  .ra-sheet .ah-btn, .ra-entry { min-height: 44px; }
  .ra-close { width: 44px; height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .ra-backdrop, .ra-sheet, .ra-skeleton { animation: none; }
  .ra-entry { transition: none; }
}
`

/**
 * A narrow composer, on any device. The Codex plugin's model picker renders in place inside the
 * center column, which clips at its left edge (overflow: hidden), and opens its submenu leftward:
 * in a narrow column the submenu is cut off where the sidebar begins, and no z-index lifts it out.
 * Below this width (of the composer's toolbar row, a size container), stack the submenu right above
 * the menu, within the menu's own width, so it never crosses that edge.
 */
const NARROW = `
@container (width <= 720px) {
  .codexModelSelect .codexModelSelectMenu .codexModelSelectSubmenu {
    left: 0; right: 0; bottom: calc(100% + 8px); width: auto; min-width: 0; max-width: none;
  }
}
`

/** DSH on a phone: only narrow touch screens, i.e. phones and small tablets in portrait. */
const MOBILE = `
@media (pointer: coarse) and (max-width: 820px) {
  html, body { height: 100%; overscroll-behavior: none; }
  [class*="_frame"]:has([class*="_centerCol"]) { width: 100%; height: 100dvh; }
  /* 16px text fields keep iOS from zooming on focus. */
  textarea, input, [class$="_input"] { font-size: 16px !important; }
  [class$="_composer"] { padding-bottom: calc(4px + env(safe-area-inset-bottom)); }
  [class$="_scroll"] { padding-left: 10px; padding-right: 10px; }
  /* Touch targets on the collapsed rail. */
  [class$="_railFish"] button, [class$="_newSession"] { min-width: 44px; min-height: 44px; }
  /* The sidebar's collapse toggle keeps its glyph and size; only its hit area grows to 44px. */
  [class*="_iconButton"][class$="_toggle"]::after { content: ''; position: absolute; inset: -8px; }
  /* Taps leave hover stuck, so tooltips would linger. */
  [class*="_bubble"][role="tooltip"] { display: none; }
  /* "Open in File Explorer" acts on the computer, not the phone; the rest of the utilities (Git among them) stay. */
  [class$="_headerUtilities"] :is([class$="_main"]:has(+ [class$="_chevron"]), [class$="_chevron"]) { display: none !important; }
  /* Composer popovers (model, permissions, attachments) become bottom sheets with real targets. */
  [class$="_composerSeat"] { transform: none !important; }
  [class$="_composerSeat"] [class$="_menu"] {
    position: fixed !important; left: 8px !important; right: 8px !important; top: auto !important;
    bottom: calc(8px + env(safe-area-inset-bottom)) !important; width: auto !important; max-width: none !important;
    max-height: 70dvh !important; overflow-y: auto !important; z-index: 1500;
  }
  [class$="_composerSeat"] [class$="_menu"] [class$="_cell"] { min-height: 44px; }
  /* The Codex plugin's model picker: a bottom sheet too, its submenu (which opens leftward, off screen
     under the sidebar) stacked right above it, full width, so both levels stay in view. */
  .codexModelSelect .codexModelSelectMenu {
    position: fixed !important; left: 8px; right: 8px; bottom: calc(8px + env(safe-area-inset-bottom));
    width: auto; min-width: 0; max-width: none; z-index: 1500;
  }
  .codexModelSelect .codexModelSelectMenu .codexModelSelectSubmenu {
    left: 0; right: 0; bottom: calc(100% + 8px); width: auto; min-width: 0; max-width: none; max-height: none;
  }
  .codexModelSelect .codexModelSelectMenu .codexModelSelectGroups { max-height: min(352px, 100dvh - 220px); }
  .codexModelSelect :is(.codexModelSelectCell, .codexModelSelectOption) { min-height: 44px; }
  /* Settings: the two-column modal becomes one column with a scrolling section row on top. */
  [class$="_overlay"] [class$="_panel"] { flex-direction: column; max-height: calc(100dvh - 32px); }
  [class$="_overlay"] [class$="_panel"] [class$="_nav"] { flex-direction: row; width: 100%; padding: 12px 12px 0; overflow-x: auto; }
  [class$="_overlay"] [class$="_panel"] [class$="_navTitle"] { display: none; }
  [class$="_overlay"] [class$="_panel"] [class$="_navList"] { flex-direction: row; gap: 4px; }
  [class$="_overlay"] [class$="_panel"] [class$="_navCell"] { flex: none; min-height: 40px; padding: 0 12px; }
  [class$="_overlay"] [class$="_panel"] [class$="_content"] { flex: 1; min-height: 0; }
}
/*
 * DSH's responsive compat sheet (data-dsh-compat="responsive") folds the frame to
 * one column below 768px but only knows the old [data-pane="details"] column, so
 * the right sidebar's track wraps to a zero-height second row and Git, Terminal
 * and Files never show. Lay the track over the whole frame instead and let the
 * open panel fill it; the collapsed rail (z 1100) stays underneath, and the shell
 * overlay layer (the Git diff stage among others) stays on top.
 */
@media (max-width: 768px) {
  [data-dsh-frame] [data-shell-overlay] { z-index: 1300; }
  [data-dsh-frame] [data-rightbar-col] { position: absolute !important; inset: 0; z-index: 1200; pointer-events: none; }
  [data-dsh-frame] [data-rightbar-col] [data-sidebar-right-panel] { width: 100% !important; height: 100% !important; pointer-events: auto; }
  [data-dsh-frame] [data-rightbar-col] [data-sidebar-right-panel]:not([data-sidebar-right-open]) { display: none !important; }
}
`

const STYLE_ID = 'dsh-agent-hub-remote-style'

export function injectRemoteStyle(): () => void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PANEL + NARROW + MOBILE
  document.head.append(style)
  return () => style.remove()
}
