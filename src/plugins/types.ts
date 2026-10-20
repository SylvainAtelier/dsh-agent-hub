import type { PendingOp, PendingResult } from "./pending.ts";

export const PLUGIN_UPDATES_METHOD = "agent-hub/plugin-updates";

export interface Bundle {
  name: string;
  version?: string;
  source?: string;
  installed: boolean;
  enabled: boolean;
  availability?: string;
  readOnlyReason?: string;
  error?: unknown;
}
export interface UpdateItem {
  name: string;
  current?: string;
  latest?: string;
  enabled: boolean;
  state: "current" | "available" | "skipped" | "failed";
  reason?: string;
}
export interface UpgradeItem {
  name: string;
  before?: string;
  target: string;
  after?: string;
  state:
    | "queued"
    | "installing"
    | "applying"
    | "done"
    | "failed"
    | "skipped"
    | "scheduled";
  error?: string;
  pendingBuilds?: string[];
  lines: string[];
}
export interface UpdateStatus {
  available: boolean;
  busy: "checking" | "upgrading" | null;
  development?: boolean;
  restartRequired?: boolean;
  checkedAt?: string;
  items: UpdateItem[];
  batch?: {
    id: string;
    items: UpgradeItem[];
    finished: boolean;
    restart: boolean;
  };
  error?: string;
  /** Upgrades waiting for DSH to restart (plugins/pending.ts), from this page or settings sync. */
  pending?: PendingOp[];
  /** What the upgrades the last restart ran came to, until dismissed. */
  lastRun?: PendingResult;
}
export type UpdateRequest =
  | { op: "status" | "check" | "dismiss" }
  | { op: "upgrade"; names: string[] }
  /** Drop upgrades waiting for a restart; all of them without names. */
  | { op: "unschedule"; names?: string[] };
export interface PackageManager {
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
}
export interface UpdateProfile {
  dir: string;
  packageManager?: PackageManager;
}
export interface UpdateManager {
  listBundles(): Promise<Bundle[]>;
  registries?(): Promise<{ registry: string | null }>;
  installBundle(
    spec: string,
    options: {
      enabled: boolean;
      requestId: string;
      saveExact: boolean;
      registry?: string;
    },
  ): Promise<{
    application?: string;
    version?: string;
    error?: { code?: string; diagnostic?: string };
    pendingBuilds?: string[];
  }>;
}
