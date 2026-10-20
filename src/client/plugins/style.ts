const CSS = `
.ah-plugin-updates{--pu-border:var(--ah-line);--pu-muted:var(--ah-fg2);--pu-surface:var(--ah-layer);--pu-accent:var(--ah-info);display:grid;gap:16px;min-width:0;color:inherit;font-size:14px;line-height:1.6}
.ah-plugin-updates *{box-sizing:border-box}.ah-plugin-updates h3,.ah-plugin-updates p{margin:0}.ah-plugin-updates h3{font-size:17px;font-weight:600}.ah-plugin-updates .pu-muted{color:var(--pu-muted)}
.ah-plugin-updates .pu-toolbar,.ah-plugin-updates .pu-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}.ah-plugin-updates .pu-heading{display:grid;gap:4px;flex:1;min-width:180px}
.ah-plugin-updates button{font:inherit;min-height:44px;padding:8px 14px;border:1px solid var(--pu-border);border-radius:10px;background:transparent;color:inherit;cursor:pointer;transition:background .15s,opacity .15s}.ah-plugin-updates button:hover:not(:disabled){background:var(--pu-surface)}.ah-plugin-updates button:disabled{opacity:.5;cursor:not-allowed}.ah-plugin-updates button[data-primary]{background:var(--dsw-alias-button-primary-fill,var(--ah-fg));border-color:transparent;color:var(--ah-bg)}.ah-plugin-updates button[data-primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,color-mix(in srgb,var(--ah-fg) 85%,transparent))}
.ah-plugin-updates :focus-visible{outline:3px solid var(--ah-focus);outline-offset:3px}.ah-plugin-updates .pu-list{display:grid;gap:8px;list-style:none;margin:0;padding:0}.ah-plugin-updates .pu-row{display:flex;align-items:flex-start;gap:12px;border:1px solid var(--pu-border);border-radius:12px;padding:12px}.ah-plugin-updates .pu-check{display:flex;min-height:44px;min-width:44px;align-items:center;justify-content:center;cursor:pointer}.ah-plugin-updates input{width:18px;height:18px;accent-color:var(--pu-accent)}.ah-plugin-updates .pu-body{flex:1;min-width:0;overflow-wrap:anywhere}.ah-plugin-updates .pu-name{font-weight:600}.ah-plugin-updates .pu-version{font-variant-numeric:tabular-nums;font-family:ui-monospace,monospace;font-size:13px}.ah-plugin-updates .pu-badge{border:1px solid var(--pu-border);padding:2px 8px;border-radius:20px;font-size:12px;flex-shrink:0}.ah-plugin-updates .pu-note{padding:12px 16px;border:1px solid var(--pu-border);border-radius:12px;background:var(--pu-surface);overflow-wrap:anywhere}.ah-plugin-updates [role=alert]{border-inline-start:3px solid var(--ah-danger-ink)}.ah-plugin-updates .pu-progress{width:100%;height:8px;accent-color:var(--pu-accent)}.ah-plugin-updates details summary{cursor:pointer;padding:8px 0;min-height:44px}.ah-plugin-updates pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:200px;overflow:auto;margin:8px 0}.ah-plugin-updates .pu-confirm{display:grid;gap:12px;padding:16px;border:1px solid var(--pu-accent);border-radius:12px}.ah-plugin-updates .pu-confirm .pu-actions{justify-content:flex-end}
@media(max-width:540px){.ah-plugin-updates{font-size:16px}.ah-plugin-updates .pu-row{gap:4px;padding:10px}.ah-plugin-updates .pu-badge{max-width:100%;white-space:normal}.ah-plugin-updates .pu-toolbar>button{width:100%}.ah-plugin-updates .pu-actions>button{flex:1}.ah-plugin-updates .pu-heading{min-width:0}}
@media(prefers-reduced-motion:reduce){.ah-plugin-updates button{transition:none}}
`;
export function injectPluginUpdatesStyle(
  document: Document = globalThis.document,
): () => void {
  const style = document.createElement("style");
  style.dataset.agentHub = "plugin-updates";
  style.textContent = CSS;
  document.head.append(style);
  return () => style.remove();
}
