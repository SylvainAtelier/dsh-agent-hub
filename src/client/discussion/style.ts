/** Inherit Agent Hub tokens and host theme; keep movement cheap and optional. */
export function injectDiscussionStyle(): () => void {
  const style = document.createElement('style')
  style.textContent = `
.sd-overlay { position:relative; z-index:var(--ah-z-float,9000); color:var(--ah-fg); font-family:var(--ah-sans); }
.sd-overlay *, .sd-dock * { box-sizing:border-box; }
.sd-overlay button, .sd-dock button { font:inherit; color:inherit; cursor:pointer; border:1px solid var(--ah-line-strong); border-radius:var(--ah-radius,8px); background:var(--ah-layer); padding:7px 12px; min-height:36px; transition:background-color 120ms; }
.sd-overlay button:hover, .sd-dock button:hover { background:var(--ah-hover); }
.sd-overlay button:disabled, .sd-dock button:disabled { cursor:default; opacity:.55; }
.sd-overlay :focus-visible, .sd-dock :focus-visible { outline:2px solid var(--ah-focus); outline-offset:3px; }
.sd-trigger-group { position:fixed; left:0; top:0; visibility:hidden; display:inline-flex; gap:6px; z-index:1; }
.sd-trigger { display:inline-flex; align-items:center; gap:8px; box-shadow:var(--ah-shadow); white-space:nowrap; font-size:13px!important; z-index:1; border-radius:999px!important; padding:6px 14px!important; }
/* Floats over transcript text, so its surface stays opaque and hover tints are layered on top instead of replacing it. */
.sd-overlay .sd-trigger { background-color:var(--ah-popup); }
.sd-overlay .sd-trigger:hover { background-color:var(--ah-popup); background-image:linear-gradient(var(--ah-hover),var(--ah-hover)); }
.sd-overlay .sd-trigger:active { background-image:linear-gradient(var(--ah-hover),var(--ah-hover)),linear-gradient(var(--ah-hover),var(--ah-hover)); }
.sd-trigger-count { display:inline-flex; align-items:center; gap:8px; color:var(--ah-fg2); font-size:12px; font-variant-numeric:tabular-nums; }
.sd-trigger-count::before { content:''; width:1px; height:12px; background:var(--ah-line-strong); }
.sd-panel { position:fixed; display:flex; flex-direction:column; width:min(440px,calc(100vw - 32px)); height:min(600px,var(--sd-height,65dvh)); max-height:var(--sd-height,calc(100dvh - 32px)); min-height:0; border:1px solid var(--ah-line-strong); border-radius:14px; background:var(--ah-popup); box-shadow:var(--ah-shadow); overflow:hidden; font-size:14px; line-height:1.6; outline:none; }
.sd-header { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--ah-line); gap:12px; flex:none; }
.sd-header>div { min-width:0; display:flex; flex-direction:column; }
.sd-model { text-align:left; border:0!important; background:transparent!important; padding:0!important; min-height:24px!important; font-size:12px!important; overflow-wrap:anywhere; color:var(--ah-fg2)!important; }
.sd-icon { min-width:36px; display:inline-grid; place-items:center; padding:0!important; }
.sd-history { display:flex; align-items:center; gap:8px; padding:8px 16px; border-bottom:1px solid var(--ah-line); font-size:12px; flex:none; }
.sd-history select { min-width:0; flex:1; max-width:100%; color:var(--ah-fg); background:var(--ah-layer); border:1px solid var(--ah-line); border-radius:6px; padding:6px; font:inherit; }
.sd-scroll { min-height:0; flex:1; overflow-y:auto; overscroll-behavior:contain; padding:12px 16px; scrollbar-gutter:stable; }
.sd-quote summary { cursor:pointer; font-size:12px; color:var(--ah-fg2); min-height:30px; }
.sd-quote blockquote { margin:4px 0 12px; border-left:2px solid var(--ah-line-strong); padding:4px 12px; max-height:150px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
.sd-hint, .sd-empty, .sd-stage small, .sd-send small { color:var(--ah-fg2); font-size:12px; line-height:1.5; }
.sd-hint { margin:6px 0; }
.sd-empty { padding:20px 0; }
.sd-round { margin:16px 0; }
.sd-question { white-space:pre-wrap; overflow-wrap:anywhere; padding:10px 12px; background:var(--ah-soft); border-radius:10px; margin-bottom:12px; }
.sd-answer { overflow-wrap:anywhere; }
.sd-answer p { margin:8px 0; }
.sd-answer pre { padding:10px; background:var(--ah-soft); border:1px solid var(--ah-line); border-radius:8px; overflow-x:auto; max-width:100%; }
.sd-answer code { font: .9em/1.6 var(--ah-mono); }
.sd-answer table { display:block; max-width:100%; overflow-x:auto; border-collapse:collapse; }
.sd-answer td, .sd-answer th { padding:6px; border:1px solid var(--ah-line-strong); }
.sd-answer a { color:var(--ah-info-ink); text-decoration:underline; }
.sd-footer { flex:none; padding:10px 16px max(12px,env(safe-area-inset-bottom)); border-top:1px solid var(--ah-line); background:var(--ah-popup); min-height:0; }
.sd-scopes { display:flex; gap:4px; padding:3px; margin:8px 0 2px; border:1px solid var(--ah-line); border-radius:10px; background:var(--ah-soft); }
.sd-overlay .sd-scopes button { flex:1; min-height:30px; padding:4px 8px; border:0; border-radius:7px; background:transparent; font-size:12px; color:var(--ah-fg2); }
.sd-overlay .sd-scopes button[aria-checked="true"] { background:var(--ah-popup); color:var(--ah-fg); box-shadow:0 1px 2px rgb(0 0 0 / .12); font-weight:500; }
.sd-stage { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:8px; }
.sd-stage small { flex:1; min-width:150px; }
.sd-add { font-size:12px!important; margin-bottom:8px; }
.sd-input-label { display:block; font-size:12px; margin-bottom:5px; }
.sd-footer textarea { display:block; width:100%; resize:vertical; min-height:64px; max-height:140px; padding:9px 10px; border:1px solid var(--ah-line-strong); border-radius:8px; color:var(--ah-fg); background:var(--ah-bg); font:inherit; }
.sd-send { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:8px; }
.sd-primary { background:var(--ah-info)!important; color:white!important; border-color:transparent!important; flex:none; }
.sd-error { color:var(--ah-danger-ink); font-size:12px; overflow-wrap:anywhere; }
.sd-error p { margin:4px 0; }
.sd-error button { font-size:12px!important; padding:4px 8px!important; }
.sd-dock { display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:6px 2px; font-size:12px; color:var(--ah-fg2); }
.sd-dock button { font-size:12px; }
.sd-dock-note { flex-basis:100%; overflow-wrap:anywhere; }
.sd-scrim { position:fixed; inset:0; background:rgb(0 0 0 / .35); }
@media(max-width:639px) {
  .sd-panel { width:calc(100vw - 16px); height:min(680px,var(--sd-height)); border-radius:16px; }
  .sd-overlay button, .sd-dock button { min-height:44px; }
  .sd-icon { min-width:44px; }
  .sd-panel, .sd-footer textarea, .sd-history select { font-size:16px; }
  .sd-footer { padding:10px 12px max(12px,env(safe-area-inset-bottom)); }
  .sd-header, .sd-scroll { padding-left:12px; padding-right:12px; }
  .sd-trigger { max-width:calc(100vw - 24px); padding:8px 16px!important; }
  .sd-stage small { display:none; }
}
@media(prefers-reduced-motion:reduce) { .sd-overlay *, .sd-dock * { transition:none!important; animation:none!important; } }
`
  document.head.append(style)
  return () => style.remove()
}
