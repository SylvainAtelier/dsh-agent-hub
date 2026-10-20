import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PluginUpdatesStore } from "./api.ts";
import type { UpdateItem } from "../../plugins/types.ts";

const copy = {
  zh: {
    title: "插件更新",
    hint: "从当前 Registry 检查最新版本，保留配置与启用状态。",
    check: "检查更新",
    checking: "正在检查 Registry…",
    loading: "正在读取插件…",
    unavailable: "当前 DSH 的插件管理服务不可用。",
    select: "选择可用更新",
    upgrade: "升级所选",
    empty: "尚未检查更新。点击「检查更新」开始，不会自动安装。",
    current: "已是最新",
    available: "可更新",
    skipped: "已跳过",
    failed: "失败",
    retry: "重试失败项",
    confirm: "确认升级",
    cancel: "取消",
    confirmHint:
      "将逐项安装以下确切版本。插件配置与开关保持不变；安装完成后需重启 DSH 才能生效。",
    dev: "开发热重载模式下 DSH 不允许原位升级：所选插件会在重启 DSH 时升级（DSH 退出后运行 pnpm，失败自动还原）。",
    schedule: "重启时升级所选",
    scheduleHint:
      "以下确切版本会在下次重启 DSH 时安装，插件配置与开关保持不变。可以继续排队其他插件，最后一起重启。",
    pending: "等待重启后升级",
    unschedule: "取消",
    lastOk: "上次重启时已升级",
    lastFailed: "上次重启时升级失败，已还原",
    dismiss: "知道了",
    disabled: "未启用",
    queued: "排队中",
    installing: "安装中",
    applying: "应用中",
    done: "已安装 · 待重启",
    scheduled: "已安排重启后升级",
    logs: "安装输出",
    builds: "需要批准构建脚本，请前往 DSH 插件页处理",
    stale: "部分插件检查失败；检查网络与 Registry 登录后重试。",
    checked: "上次检查",
    selected: "已选",
    progress: "升级进度",
    allCurrent: "没有可用更新。",
    beforeCheck: "检查失败，请重试。",
    reasons: {
      "read-only": "受 DSH 保护的只读插件。",
      "built-in": "内置或未安装插件，随 DSH 管理。",
      "plugin-error": "插件存在错误，请先在插件页修复。",
      "local-source": "本地、Git、链接或别名来源，不使用 Registry 批量升级。",
      "unknown-version": "无法确定已安装版本。",
    },
  },
  en: {
    title: "Plugin updates",
    hint: "Check your registry for new versions. Settings and enablement are preserved.",
    check: "Check updates",
    checking: "Checking registry…",
    loading: "Loading plugins…",
    unavailable: "The DSH plugin manager is unavailable.",
    select: "Select available updates",
    upgrade: "Upgrade selected",
    empty: "Check for updates first. Nothing is installed automatically.",
    current: "Up to date",
    available: "Update available",
    skipped: "Skipped",
    failed: "Failed",
    retry: "Retry failed",
    confirm: "Confirm upgrade",
    cancel: "Cancel",
    confirmHint:
      "Install these exact versions one at a time, keeping settings and switches unchanged. Restart DSH afterward to activate them.",
    dev: "A hot-reloading DSH refuses in-place upgrades: the chosen plugins are upgraded when DSH restarts (pnpm runs once DSH has quit, and is undone if it fails).",
    schedule: "Upgrade at restart",
    scheduleHint:
      "These exact versions are installed when DSH next restarts, keeping settings and switches unchanged. Queue more plugins if you like, then restart once.",
    pending: "Waiting for the restart",
    unschedule: "Cancel",
    lastOk: "Upgraded at the last restart",
    lastFailed: "The upgrade at the last restart failed and was undone",
    dismiss: "Dismiss",
    disabled: "Disabled",
    queued: "Queued",
    installing: "Installing",
    applying: "Applying",
    done: "Installed · restart needed",
    scheduled: "Scheduled for upgrade at restart",
    logs: "Install output",
    builds: "Build scripts need approval on the DSH Plugins page",
    stale:
      "Some checks failed. Check the network and registry authentication, then retry.",
    checked: "Last checked",
    selected: "selected",
    progress: "Upgrade progress",
    allCurrent: "No updates available.",
    beforeCheck: "Check failed. Please retry.",
    reasons: {
      "read-only": "Protected read-only plugin.",
      "built-in": "Built-in or not installed; managed by DSH.",
      "plugin-error": "Fix this plugin on the Plugins page first.",
      "local-source":
        "Local, Git, linked or aliased source; excluded from registry upgrades.",
      "unknown-version": "Installed version is unknown.",
    },
  },
};
export function PluginUpdatesPanel({
  store,
  locale = "zh",
  disabled = false,
}: {
  store: PluginUpdatesStore;
  locale?: string;
  disabled?: boolean;
}): ReactNode {
  const t = copy[locale.startsWith("zh") ? "zh" : "en"];
  const { status, loading, error } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const launchButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void store.load();
  }, [store]);
  useEffect(() => {
    setSelected([]);
    setConfirming(false);
  }, [status?.checkedAt]);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);
  const close = (): void => {
    setConfirming(false);
    launchButton.current?.focus();
  };
  const busy = disabled || loading || !!status?.busy;
  const available =
    status?.items.filter((item) => item.state === "available") ?? [];
  const chosen = available.filter((item) => selected.includes(item.name));
  const batch = status?.batch;
  const completed =
    batch?.items.filter(
      (item) => !["queued", "installing", "applying"].includes(item.state),
    ).length ?? 0;
  const failed =
    batch?.items
      .filter(
        (item) =>
          item.state === "failed" &&
          available.some((entry) => entry.name === item.name),
      )
      .map((item) => item.name) ?? [];
  const reason = (item: UpdateItem): string | undefined =>
    t.reasons[item.reason as keyof typeof t.reasons] ?? item.reason;
  const deferred = !!status?.development;
  const pending = status?.pending ?? [];
  const lastRun = status?.lastRun;
  const otherItems =
    status?.items.filter(
      (item) => item.state === "current" || item.state === "skipped",
    ) ?? [];
  const renderItem = (item: UpdateItem): ReactNode => (
    <li className="pu-row" key={item.name}>
      {item.state === "available" && (
        <label className="pu-check">
          <input
            type="checkbox"
            aria-label={`${t.select}: ${item.name}`}
            disabled={busy}
            checked={selected.includes(item.name)}
            onChange={(event) => {
              setSelected(
                event.target.checked
                  ? [...selected, item.name]
                  : selected.filter((name) => name !== item.name),
              );
            }}
          />
        </label>
      )}
      <div className="pu-body">
        <p className="pu-name">{item.name}</p>
        <p className="pu-version">
          {item.current ?? "—"}
          {item.latest && item.latest !== item.current && ` → ${item.latest}`}
          {!item.enabled && ` · ${t.disabled}`}
        </p>
        {item.reason && <p className="pu-muted">{reason(item)}</p>}
      </div>
      <span className="pu-badge">{t[item.state]}</span>
    </li>
  );
  return (
    <section className="ah-plugin-updates" aria-label={t.title}>
      <div className="pu-toolbar">
        <div className="pu-heading">
          <h3>{t.title}</h3>
          <p className="pu-muted">{t.hint}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          aria-busy={status?.busy === "checking"}
          onClick={() => void store.run({ op: "check" })}
        >
          {status?.busy === "checking" ? t.checking : t.check}
        </button>
      </div>
      {(error || status?.error) && (
        <p className="pu-note" role="alert">
          {error ?? status?.error}
        </p>
      )}
      {!status && <p role="status">{loading ? t.loading : t.beforeCheck}</p>}
      {status && !status.available && (
        <p className="pu-note">{t.unavailable}</p>
      )}
      {status?.available && (
        <>
          {status.development && <p className="pu-note">{t.dev}</p>}
          {!status.checkedAt && <p className="pu-muted">{t.empty}</p>}
          {status.checkedAt && (
            <p className="pu-muted">
              {t.checked} · {new Date(status.checkedAt).toLocaleString()}
            </p>
          )}
          {!!available.length && (
            <div className="pu-actions">
              <label className="pu-check">
                <input
                  type="checkbox"
                  aria-label={t.select}
                  aria-checked={
                    chosen.length > 0 && chosen.length < available.length
                      ? "mixed"
                      : chosen.length === available.length
                  }
                  ref={(node) => {
                    if (node)
                      node.indeterminate =
                        chosen.length > 0 && chosen.length < available.length;
                  }}
                  disabled={busy}
                  checked={chosen.length === available.length}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? available.map((item) => item.name)
                        : [],
                    )
                  }
                />
              </label>
              <span>
                {chosen.length} / {available.length} {t.selected}
              </span>
              <button
                ref={launchButton}
                type="button"
                data-primary=""
                disabled={busy || !chosen.length}
                onClick={() => setConfirming(true)}
              >
                {deferred ? t.schedule : t.upgrade} ({chosen.length})
              </button>
            </div>
          )}
          {status.checkedAt &&
            !available.length &&
            !status.items.some((item) => item.state === "failed") && (
              <p className="pu-note">{t.allCurrent}</p>
            )}
          {confirming && (
            <div
              className="pu-confirm"
              role="group"
              aria-label={t.confirm}
              onKeyDown={(event) => {
                if (event.key === "Escape") close();
              }}
            >
              <p>{deferred ? t.scheduleHint : t.confirmHint}</p>
              <ul>
                {chosen.map((item) => (
                  <li key={item.name}>
                    {item.name} · {item.current} → {item.latest}
                  </li>
                ))}
              </ul>
              <div className="pu-actions">
                <button type="button" onClick={close}>
                  {t.cancel}
                </button>
                <button
                  type="button"
                  ref={confirmButton}
                  data-primary=""
                  disabled={busy || !chosen.length}
                  onClick={() => {
                    setConfirming(false);
                    void store.run({
                      op: "upgrade",
                      names: chosen.map((item) => item.name),
                    });
                  }}
                >
                  {t.confirm}
                </button>
              </div>
            </div>
          )}
          <ul className="pu-list">
            {status.items
              .filter(
                (item) => item.state === "available" || item.state === "failed",
              )
              .map(renderItem)}
          </ul>
          {!!otherItems.length && (
            <details>
              <summary>
                {locale.startsWith("zh")
                  ? "已是最新 / 已跳过"
                  : "Up to date / skipped"}{" "}
                ({otherItems.length})
              </summary>
              <ul className="pu-list">{otherItems.map(renderItem)}</ul>
            </details>
          )}
          {status.items.some((item) => item.state === "failed") && (
            <p className="pu-note">{t.stale}</p>
          )}
        </>
      )}
      {!!pending.length && (
        <div className="pu-note" role="status">
          <p>{t.pending}</p>
          <ul className="pu-list">
            {pending.map((op) => (
              <li key={op.name} className="pu-actions">
                <span className="pu-version">
                  {op.name} · {op.from ?? "—"} → {op.spec}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`${t.unschedule}: ${op.name}`}
                  onClick={() =>
                    void store.run({ op: "unschedule", names: [op.name] })
                  }
                >
                  {t.unschedule}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {lastRun && (
        <div className="pu-note" role={lastRun.ok ? "status" : "alert"}>
          <p>
            <strong>{lastRun.ok ? t.lastOk : t.lastFailed}</strong> ·{" "}
            {new Date(lastRun.at).toLocaleString()}
          </p>
          <p className="pu-version">
            {lastRun.ops.map((op) => `${op.name}@${op.spec}`).join(", ")}
          </p>
          {lastRun.error && <p>{lastRun.error}</p>}
          {!!lastRun.log?.length && (
            <details>
              <summary>{t.logs}</summary>
              <pre>{lastRun.log.join("\n")}</pre>
            </details>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void store.run({ op: "dismiss" })}
          >
            {t.dismiss}
          </button>
        </div>
      )}
      {batch && (
        <div className="pu-note">
          <p role="status" aria-live="polite">
            {t.progress} · {completed} / {batch.items.length}
          </p>
          <progress
            className="pu-progress"
            value={completed}
            max={batch.items.length}
            aria-label={t.progress}
          />
          <ul className="pu-list">
            {batch.items.map((item) => (
              <li key={item.name} className="pu-body">
                <p>
                  <strong>{item.name}</strong> · {t[item.state]}
                </p>
                <p className="pu-version">
                  {item.before} → {item.after ?? item.target}
                </p>
                {item.error && <p role="alert">{item.error}</p>}
                {!!item.pendingBuilds?.length && (
                  <p>
                    {t.builds}: {item.pendingBuilds.join(", ")}
                  </p>
                )}
                {!!item.lines.length && (
                  <details>
                    <summary>{t.logs}</summary>
                    <pre>{item.lines.join("\n")}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
          {batch.finished && !!failed.length && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void store.run({ op: "upgrade", names: failed })}
            >
              {t.retry} ({failed.length})
            </button>
          )}
        </div>
      )}
    </section>
  );
}
