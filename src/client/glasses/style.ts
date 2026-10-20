/** The bell sits beside the scheduled-send clock and matches it; its hint is a short-lived bubble above. */
const CSS = `
.ah-glasses { position: relative; display: inline-flex; }
.ah-glasses-trigger { position: relative; width: 32px; height: 32px; border: 0; border-radius: 8px; padding: 6px; display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--ah-fg2); cursor: pointer; }
.ah-glasses-trigger:hover { color: var(--ah-fg); background: var(--ah-hover); }
.ah-glasses-trigger[aria-pressed="true"] { color: var(--ah-info-ink); background: color-mix(in srgb, var(--ah-info) 12%, transparent); }
.ah-glasses-trigger:disabled { opacity: .45; cursor: default; }
.ah-glasses-trigger:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 2px; }
.ah-glasses-trigger[data-offline]::after { content: ""; position: absolute; top: 6px; right: 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--ah-warn); box-shadow: 0 0 0 2px var(--ah-bg, Canvas); }
.ah-glasses-hint { position: fixed; z-index: 1000; box-sizing: border-box; width: max-content; max-width: min(280px, calc(100vw - 24px)); padding: 8px 12px; border: 1px solid var(--ah-line-strong); border-radius: 10px; background: var(--ah-popup); color: var(--ah-fg); box-shadow: var(--ah-shadow); font: 13px/1.5 var(--ah-sans); white-space: normal; overflow-wrap: anywhere; pointer-events: none; }
.ah-glasses-hint[data-tone="warn"] { border-color: color-mix(in srgb, var(--ah-warn) 45%, var(--ah-line-strong)); }
.ah-glasses-hint[data-link] { pointer-events: auto; }
.ah-glasses-hint a { display: block; margin-top: 4px; color: var(--ah-info-ink); text-decoration: underline; text-underline-offset: 2px; }
.ah-glasses-hint a:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 2px; border-radius: 4px; }
.ah-glasses-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (pointer: coarse) {
  .ah-glasses-trigger { width: 44px; height: 44px; }
  .ah-glasses-trigger[data-offline]::after { top: 10px; right: 10px; }
}
@media (max-width: 600px) { .ah-glasses-hint { font-size: 14px; } }
@media (prefers-reduced-motion: no-preference) {
  .ah-glasses-trigger { transition: background-color 120ms ease, color 120ms ease; }
  .ah-glasses-hint { animation: ah-glasses-in 160ms ease-out; }
  @keyframes ah-glasses-in { from { opacity: 0; transform: translateY(4px); } }
}
`
export function injectGlassesStyle(): () => void {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.append(style)
  return () => style.remove()
}
