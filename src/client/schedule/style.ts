/** Native modal isolation with an anchored desktop layout and a narrow-container bottom sheet. */
const CSS = `
.ah-schedule-trigger { width: 32px; height: 32px; border: 0; border-radius: 8px; padding: 6px; display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--ah-fg2); cursor: pointer; }
.ah-schedule-trigger:hover, .ah-schedule-trigger[aria-expanded="true"] { color: var(--ah-fg); background: var(--ah-hover); }
.ah-schedule-trigger:disabled { opacity: .45; cursor: default; }
.ah-schedule-trigger:focus-visible, .ah-schedule-dialog :is(button,input):focus-visible { outline: 2px solid var(--ah-focus); outline-offset: 2px; }
.ah-schedule-dialog { box-sizing: border-box; position: fixed; inset: auto; margin: 0; width: min(392px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); padding: 0; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--ah-line-strong); border-radius: 16px; box-shadow: var(--ah-shadow); background: var(--ah-popup); color: var(--ah-fg); font: 14px/1.6 var(--ah-sans); }
.ah-schedule-dialog::backdrop { background: rgb(0 0 0 / .12); }
.ah-schedule-body { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.ah-schedule-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.ah-schedule-head h2 { font-size: 16px; line-height: 1.4; margin: 0; font-weight: 600; }
.ah-schedule-dialog button { font: inherit; cursor: pointer; }
.ah-schedule-dialog .ah-btn { min-height: 44px; height: auto; white-space: normal; font-size: 14px; }
.ah-schedule-close { width: 44px; height: 44px; border: 0; border-radius: 8px; display: grid; place-items: center; background: transparent; color: var(--ah-fg2); }
.ah-schedule-close:hover { background: var(--ah-hover); }
.ah-schedule-dialog p { margin: 0; }
.ah-schedule-muted { color: var(--ah-fg2); font-size: 13px; overflow-wrap: anywhere; }
.ah-schedule-choice { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; text-align: left; width: 100%; padding: 12px; min-height: 56px; border: 1px solid var(--ah-line-strong); border-radius: 10px; color: inherit; background: transparent; }
.ah-schedule-choice[aria-checked="true"] { border-color: var(--ah-info-ink); background: color-mix(in srgb, var(--ah-info) 8%, var(--ah-popup)); }
.ah-schedule-choice strong { font-weight: 600; }
.ah-schedule-dialog button:disabled { opacity: .5; cursor: default; }
.ah-schedule-options { display: flex; flex-direction: column; gap: 10px; }
.ah-schedule-dates { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.ah-schedule-dates label { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.ah-schedule-dates input { box-sizing: border-box; min-width: 0; width: 100%; min-height: 44px; padding: 8px; border: 1px solid var(--ah-line-strong); border-radius: 8px; background: var(--ah-bg); color: inherit; font: inherit; color-scheme: normal; }
.ah-schedule-preview { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 100px; overflow: auto; padding: 10px 12px; border-radius: 8px; background: var(--ah-soft); color: var(--ah-fg2); }
.ah-schedule-error { padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--ah-warn) 10%, transparent); color: var(--ah-warn-ink); overflow-wrap: anywhere; }
.ah-schedule-foot { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.ah-schedule-dialog[data-sheet] { width: calc(100vw - 16px); border-radius: 18px 18px 0 0; }
.ah-schedule-dialog[data-sheet] .ah-schedule-body { padding-bottom: max(20px, env(safe-area-inset-bottom)); }
@media (pointer: coarse) { .ah-schedule-trigger { width: 44px; height: 44px; } }
@media (max-width: 600px) { .ah-schedule-dialog { font-size: 16px; } .ah-schedule-dates input { font-size: 16px; } .ah-schedule-foot .ah-btn[data-variant="primary"] { flex: 1; } }
@media (max-width: 360px) { .ah-schedule-dates { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: no-preference) { .ah-schedule-trigger, .ah-schedule-choice { transition: background-color 120ms ease, border-color 120ms ease; } }
.ah-schedule-trigger { position: relative; }
.ah-schedule-trigger[data-pending] { color: var(--ah-info-ink); }
.ah-schedule-trigger[data-pending]::after { content: ""; position: absolute; top: 6px; right: 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--ah-info); box-shadow: 0 0 0 2px var(--ah-bg, Canvas); }
@media (pointer: coarse) { .ah-schedule-trigger[data-pending]::after { top: 10px; right: 10px; } }
.ah-pending-dock { box-sizing: border-box; container-type: inline-size; flex: none;
  width: calc(100% - 2 * var(--dsh-composer-side-clearance, 0px) - 2 * var(--dsh-composer-dock-inset, 12px));
  max-width: calc(var(--dsh-composer-card-max-width, 100%) - 2 * var(--dsh-composer-dock-inset, 12px));
  margin: 0 auto calc(0px - var(--dsh-composer-stack-gap, 8px) - 3px); padding: 0 var(--dsh-composer-dock-inset, 12px); }
.ah-pending-panel { position: relative; isolation: isolate; overflow: hidden; padding: 2px 0; border-radius: var(--dsw-radius-lg, 12px) var(--dsw-radius-lg, 12px) 0 0; }
.ah-pending-panel::before { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none;
  background: linear-gradient(90deg, color-mix(in srgb, var(--ah-info) 9%, transparent), transparent 70%), var(--dsw-specific-menu, var(--ah-popup, Canvas)); backdrop-filter: var(--dsw-menu-backdrop-filter, none); }
.ah-pending-panel::after { content: ""; position: absolute; inset: 0; border: .5px solid var(--dsw-alias-border-l1, var(--ah-line-strong)); border-bottom: none; border-radius: inherit; pointer-events: none; }
.ah-pending-panel[data-overdue]::before { background: linear-gradient(90deg, color-mix(in srgb, var(--ah-warn) 12%, transparent), transparent 70%), var(--dsw-specific-menu, var(--ah-popup, Canvas)); }
.ah-pending-row { box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 4px 10px 4px 12px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary, var(--ah-fg)); font: 13px/1.4 var(--ah-sans, inherit); text-align: left; cursor: pointer; }
.ah-pending-row:hover { background: var(--dsw-alias-interactive-bg-hover, var(--ah-hover)); }
.ah-pending-row:focus-visible { outline: 2px solid var(--ah-focus); outline-offset: -2px; }
.ah-pending-icon { position: relative; flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; color: var(--ah-info-ink); background: color-mix(in srgb, var(--ah-info) 14%, transparent); }
.ah-pending-panel[data-overdue] .ah-pending-icon { color: var(--ah-warn-ink); background: color-mix(in srgb, var(--ah-warn) 16%, transparent); }
.ah-pending-count { position: absolute; top: -4px; right: -6px; min-width: 15px; height: 15px; padding: 0 3px; box-sizing: border-box; border-radius: 8px; display: grid; place-items: center; font: 600 10px/1 var(--ah-sans, inherit); color: #fff; background: var(--ah-info); box-shadow: 0 0 0 2px var(--dsw-specific-menu, var(--ah-popup, Canvas)); font-variant-numeric: tabular-nums; }
.ah-pending-text { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.ah-pending-title { min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.ah-pending-meta { flex: none; white-space: nowrap; color: var(--dsw-alias-label-tertiary, var(--ah-fg2)); font-variant-numeric: tabular-nums; }
.ah-pending-meta[data-overdue] .ah-pending-gap { color: var(--ah-warn-ink); font-weight: 500; }
.ah-pending-chevron, .ah-pending-arrow { flex: none; color: var(--dsw-alias-label-tertiary, var(--ah-fg2)); }
.ah-pending-chevron:not([data-open]) { transform: rotate(180deg); }
.ah-pending-list { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow-y: auto; overscroll-behavior: contain; }
.ah-pending-list li + li { box-shadow: inset 0 1px 0 var(--dsw-alias-border-l1, var(--ah-line)); }
.ah-pending-item { padding-left: 46px; }
@container (max-width: 520px) { .ah-pending-lead, .ah-pending-repeat { display: none; } }
@container (max-width: 380px) {
  .ah-pending-text { flex-direction: column; align-items: flex-start; gap: 0; }
  .ah-pending-title { max-width: 100%; }
  .ah-pending-meta { font-size: 12px; }
  .ah-pending-item { padding-left: 12px; }
}
@media (pointer: coarse) { .ah-pending-row { min-height: 44px; } }
@media (prefers-reduced-motion: no-preference) {
  .ah-pending-row { transition: background-color 120ms ease; }
  .ah-pending-chevron { transition: transform 160ms ease; }
  .ah-pending-dock { animation: ah-pending-in 200ms ease-out; }
  @keyframes ah-pending-in { from { opacity: 0; transform: translateY(6px); } }
}
`
export function injectScheduleStyle(): () => void {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.append(style)
  return () => style.remove()
}
