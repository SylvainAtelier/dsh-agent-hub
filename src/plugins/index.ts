import { randomUUID } from "node:crypto";
import type { PendingOps } from "./pending.ts";
import { compareVersions, queryLatest, registrySource } from "./registry.ts";
import type {
  Bundle,
  UpdateManager,
  UpdateProfile,
  UpdateStatus,
  UpgradeItem,
} from "./types.ts";

export interface PluginUpdateOptions {
  manager: () => UpdateManager | undefined;
  profile: () => UpdateProfile | undefined;
  hotReload?: () => boolean;
  latest?: (
    profile: UpdateProfile,
    name: string,
    registry?: string,
  ) => Promise<string>;
  installEvents?: (
    listener: (kind: "log" | "state", event: unknown) => void,
  ) => () => void;
  /** Where upgrades a hot-reloading host refuses wait for the next restart. */
  pending?: PendingOps;
}
/** This plugin: installed last, so nothing it runs is replaced while the batch still needs it. */
const SELF = "dsh-agent-hub";
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export class PluginUpdates {
  private state: UpdateStatus = { available: false, busy: null, items: [] };
  private disposed = false;
  private restartRequired = false;
  private readonly options: PluginUpdateOptions;
  constructor(options: PluginUpdateOptions) {
    this.options = options;
  }
  status(): UpdateStatus {
    const pending = this.options.pending?.list() ?? [];
    const lastRun = this.options.pending?.lastResult();
    return structuredClone({
      ...this.state,
      available: !!this.options.manager() && !!this.options.profile(),
      development: this.options.hotReload?.() ?? false,
      restartRequired: this.restartRequired || pending.length > 0,
      ...(pending.length ? { pending } : {}),
      ...(lastRun ? { lastRun } : {}),
    });
  }
  dispose(): void {
    this.disposed = true;
  }
  async handle(request: Record<string, unknown>): Promise<UpdateStatus> {
    if (request.op === "status") return this.status();
    if (request.op === "dismiss") {
      this.options.pending?.dismissResult();
      return this.status();
    }
    if (
      request.op === "unschedule" &&
      (request.names === undefined ||
        (Array.isArray(request.names) &&
          request.names.every((name) => typeof name === "string")))
    ) {
      this.options.pending?.remove(request.names as string[] | undefined);
      if (this.state.batch?.finished)
        for (const item of this.state.batch.items)
          if (
            item.state === "scheduled" &&
            (request.names === undefined ||
              (request.names as string[]).includes(item.name))
          )
            item.state = "skipped";
      return this.status();
    }
    if (request.op === "check") {
      if (this.state.busy) throw new Error("Plugin operation already running");
      this.services();
      void this.check().catch((error: unknown) => {
        this.state.error = message(error);
        this.state.busy = null;
      });
      return this.status();
    }
    if (
      request.op === "upgrade" &&
      Array.isArray(request.names) &&
      request.names.length <= 200 &&
      request.names.every((name) => typeof name === "string")
    )
      return this.upgrade(request.names as string[]);
    throw new Error("Invalid plugin update request");
  }
  private skip(bundle: Bundle): string | undefined {
    if (bundle.readOnlyReason) return "read-only";
    if (!bundle.installed || bundle.availability === "installation")
      return "built-in";
    if (bundle.error) return "plugin-error";
    if (!registrySource(bundle.name, bundle.source)) return "local-source";
    if (
      !bundle.version ||
      compareVersions(bundle.version, bundle.version) === undefined
    )
      return "unknown-version";
    return undefined;
  }
  private services(): { manager: UpdateManager; profile: UpdateProfile } {
    const manager = this.options.manager(),
      profile = this.options.profile();
    if (!manager || !profile || this.disposed)
      throw new Error("Plugin manager unavailable");
    return { manager, profile };
  }
  async check(): Promise<UpdateStatus> {
    if (this.state.busy) throw new Error("Plugin operation already running");
    const { manager, profile } = this.services();
    this.state = {
      ...this.state,
      busy: "checking",
      error: undefined,
      batch: undefined,
      items: [],
      checkedAt: undefined,
    };
    try {
      const bundles = await manager.listBundles();
      const registry = (await manager.registries?.())?.registry ?? undefined;
      const items: UpdateStatus["items"] = [];
      this.state.items = items;
      for (const bundle of bundles) {
        if (this.disposed) break;
        const reason = this.skip(bundle);
        const item: UpdateStatus["items"][number] = {
          name: bundle.name,
          current: bundle.version,
          enabled: bundle.enabled,
          state: "skipped",
          reason,
        };
        if (!reason) {
          try {
            item.latest = await (this.options.latest ?? queryLatest)(
              profile,
              bundle.name,
              registry,
            );
            const order = compareVersions(item.latest, bundle.version!);
            if (order === undefined)
              throw new Error("Registry returned invalid version");
            item.state = order > 0 ? "available" : "current";
          } catch (error) {
            item.state = "failed";
            item.reason = message(error);
          }
        }
        items.push(item);
      }
      this.state.items = items;
      this.state.checkedAt = new Date().toISOString();
    } catch (error) {
      this.state.error = message(error);
    } finally {
      this.state.busy = null;
    }
    return this.status();
  }
  /**
   * Returns immediately; status polling observes the server-owned serial batch. A host with hot
   * reload refuses in-place upgrades, so there they wait for the next restart instead.
   */
  upgrade(names: string[]): UpdateStatus {
    if (this.state.busy) throw new Error("Plugin operation already running");
    this.services();
    const deferred = this.options.hotReload?.() ?? false;
    if (deferred && !this.options.pending)
      throw new Error(
        "This development host refuses in-place upgrades. Use a normal DSH profile and restart after upgrading.",
      );
    const chosen = [...new Set(names)].sort(
      (a, b) => Number(a === SELF) - Number(b === SELF),
    );
    if (!chosen.length) throw new Error("Select at least one plugin");
    const targets = chosen.map((name) => {
      const item = this.state.items.find(
        (entry) => entry.name === name && entry.state === "available",
      );
      if (!item?.latest)
        throw new Error("Update selection is stale; check updates again");
      return {
        name,
        before: item.current,
        target: item.latest,
        state: "queued" as const,
        lines: [],
      };
    });
    if (deferred) {
      this.options.pending!.add(
        targets.map((item) => ({
          name: item.name,
          spec: item.target,
          ...(item.before ? { from: item.before } : {}),
        })),
      );
      this.state = {
        ...this.state,
        error: undefined,
        batch: {
          id: randomUUID(),
          items: targets.map((item) => ({ ...item, state: "scheduled" })),
          finished: true,
          restart: true,
        },
      };
      return this.status();
    }
    this.state = {
      ...this.state,
      busy: "upgrading",
      error: undefined,
      batch: {
        id: randomUUID(),
        items: targets,
        finished: false,
        restart: false,
      },
    };
    void this.runBatch();
    return this.status();
  }
  private async runBatch(): Promise<void> {
    const batch = this.state.batch!;
    try {
      for (const item of batch.items) {
        if (this.disposed) {
          item.state = "skipped";
          item.error =
            "Service stopped; check installed version before retrying";
          continue;
        }
        const { manager } = this.services();
        try {
          const bundle = (await manager.listBundles()).find(
            (entry) => entry.name === item.name,
          );
          if (!bundle || this.skip(bundle) || bundle.version !== item.before)
            throw new Error("Plugin changed since check; check updates again");
          await this.install(manager, bundle, item);
          batch.restart ||= item.state === "done";
          this.restartRequired ||= item.state === "done";
        } catch (error) {
          item.state = "failed";
          item.error = message(error);
        }
      }
    } catch (error) {
      this.state.error = message(error);
    } finally {
      batch.finished = true;
      this.state.busy = null;
    }
  }
  private async install(
    manager: UpdateManager,
    bundle: Bundle,
    item: UpgradeItem,
  ): Promise<void> {
    item.state = "installing";
    const requestId = randomUUID();
    const off = this.options.installEvents?.((kind, value) => {
      const event = value as {
        requestId?: string;
        phase?: string;
        line?: string;
        text?: string;
      };
      if (event?.requestId !== requestId) return;
      if (kind === "state" && event.phase === "applying")
        item.state = "applying";
      if (kind === "log") {
        const text = event.line ?? event.text;
        if (typeof text === "string")
          item.lines = [
            ...item.lines,
            ...text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n"),
          ].slice(-30);
      }
    });
    try {
      const result = await manager.installBundle(
        `${item.name}@${item.target}`,
        { enabled: bundle.enabled, requestId, saveExact: true },
      );
      item.pendingBuilds = result.pendingBuilds;
      if (
        result.application === "restart-required" ||
        result.version === item.target
      ) {
        this.state.batch!.restart = true;
        this.restartRequired = true;
      }
      if (
        result.application === "failed" ||
        result.application === "cancelled" ||
        result.error
      )
        throw new Error(
          result.error?.diagnostic ?? result.error?.code ?? result.application,
        );
      const after = (await manager.listBundles()).find(
        (entry) => entry.name === item.name,
      );
      item.after = after?.version;
      if (item.after !== item.target)
        throw new Error(
          "Installed version did not match target; check updates before retrying",
        );
      if (after?.enabled !== bundle.enabled)
        throw new Error(
          "Plugin enablement changed; review it on the Plugins page",
        );
      item.state = "done";
      const row = this.state.items.find((entry) => entry.name === item.name);
      if (row) {
        row.current = item.after;
        row.state = "current";
      }
    } finally {
      off?.();
    }
  }
}
