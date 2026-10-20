import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  PluginUpdates,
  type PluginUpdateOptions,
} from "../src/plugins/index.ts";
import {
  compareVersions,
  packageCommand,
  registrySource,
} from "../src/plugins/registry.ts";
import type {
  Bundle,
  UpdateManager,
  UpdateStatus,
} from "../src/plugins/types.ts";
import { PluginUpdatesStore } from "../src/client/plugins/api.ts";
import { PendingOps } from "../src/plugins/pending.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const row = (name: string, overrides: Partial<Bundle> = {}): Bundle => ({
  name,
  version: "1.0.0",
  source: `${name}@^1.0.0`,
  installed: true,
  enabled: true,
  availability: "profile",
  ...overrides,
});
function fixture(
  rows = [row("plugin-a"), row("plugin-b", { enabled: false })],
  options: Partial<PluginUpdateOptions> = {},
) {
  const calls: Array<{ spec: string; enabled: boolean; saveExact: boolean }> =
    [];
  const manager: UpdateManager = {
    listBundles: async () => structuredClone(rows),
    installBundle: async (spec, installOptions) => {
      calls.push({
        spec,
        enabled: installOptions.enabled,
        saveExact: installOptions.saveExact,
      });
      const target = rows.find((entry) => spec.startsWith(`${entry.name}@`))!;
      target.version = "2.0.0";
      return { application: "restart-required", version: "2.0.0" };
    },
  };
  const service = new PluginUpdates({
    manager: () => manager,
    profile: () => ({ dir: "/mock-profile" }),
    latest: async () => "2.0.0",
    ...options,
  });
  return { service, rows, calls, manager };
}
async function settled(service: PluginUpdates): Promise<UpdateStatus> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = service.status();
    if (!state.busy) return state;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Mock batch did not settle");
}

test("SemVer compares stable, prerelease, numeric identifiers and metadata", () => {
  assert.equal(compareVersions("2.0.0", "1.99.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.99"), 1);
  assert.equal(compareVersions("1.0.0-rc.10", "1.0.0-rc.2"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-1"), 1);
  assert.equal(compareVersions("1.0.0-rc", "1.0.0-rc.1"), -1);
  assert.equal(compareVersions("1.0.0+a", "1.0.0+b"), 0);
  assert.equal(compareVersions("not-semver", "1.0.0"), undefined);
});

test("Only original registry dependencies are eligible", () => {
  assert.equal(registrySource("@scope/plugin", "@scope/plugin@^1.0.0"), true);
  assert.equal(registrySource("plugin", "plugin@>=1.0.0 <3.0.0"), true);
  assert.equal(registrySource("plugin", "plugin@1.0.0 - 2.0.0"), true);
  for (const source of [
    "file:C:/plugin",
    "link:../plugin",
    "plugin@npm:other@1.0.0",
    "https://example.test/plugin.tgz",
    "plugin@git+https://example.test/repo",
  ])
    assert.equal(registrySource("plugin", source), false);
});

test("Checking calls registry latest, never installs; skips unsafe sources", async () => {
  const queries: string[] = [];
  const { service, calls } = fixture(
    [
      row("registry-plugin"),
      row("local", { source: "link:../local" }),
      row("builtin", { availability: "installation" }),
      row("protected", { readOnlyReason: "management-required" }),
      row("broken", { error: { code: "bad" } }),
    ],
    {
      latest: async (_profile, name) => {
        queries.push(name);
        return "2.0.0";
      },
    },
  );
  const state = await service.check();
  assert.deepEqual(queries, ["registry-plugin"]);
  assert.equal(state.items[0]?.state, "available");
  assert.equal(
    state.items.slice(1).every((item) => item.state === "skipped"),
    true,
  );
  assert.equal(calls.length, 0);
});

test("Registry failures remain per-item and do not hide successful checks", async () => {
  const { service } = fixture(undefined, {
    latest: async (_profile, name) => {
      if (name === "plugin-a") throw new Error("network unavailable");
      return "2.0.0";
    },
  });
  const state = await service.check();
  assert.equal(state.items[0]?.state, "failed");
  assert.equal(state.items[1]?.state, "available");
  assert.equal(state.busy, null);
});

test("Older registry latest cannot downgrade an installed prerelease", async () => {
  const { service } = fixture([row("plugin-a", { version: "3.0.0-rc.1" })]);
  assert.equal((await service.check()).items[0]?.state, "current");
});

test("Batch pins exact checked version and preserves disabled state", async () => {
  const { service, calls } = fixture();
  await service.check();
  const started = service.upgrade(["plugin-a", "plugin-b", "plugin-a"]);
  assert.equal(started.busy, "upgrading");
  const done = await settled(service);
  assert.deepEqual(calls, [
    { spec: "plugin-a@2.0.0", enabled: true, saveExact: true },
    { spec: "plugin-b@2.0.0", enabled: false, saveExact: true },
  ]);
  assert.equal(
    done.batch?.items.every((item) => item.state === "done"),
    true,
  );
  assert.equal(done.batch?.restart, true);
  assert.equal(
    done.items.every((item) => item.state === "current"),
    true,
  );
});

test("Batches serialize native installs and reject concurrent submissions", async () => {
  const { service, manager, rows } = fixture();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0,
    maximum = 0;
  manager.installBundle = async (spec) => {
    maximum = Math.max(maximum, ++active);
    await gate;
    rows.find((item) => spec.startsWith(`${item.name}@`))!.version = "2.0.0";
    active--;
    return {};
  };
  await service.check();
  service.upgrade(["plugin-a", "plugin-b"]);
  assert.throws(() => service.upgrade(["plugin-a"]), /already running/);
  await assert.rejects(service.check(), /already running/);
  release();
  await settled(service);
  assert.equal(maximum, 1);
});

test("Stale version is refused before installation", async () => {
  const { service, rows, calls } = fixture();
  await service.check();
  rows[0]!.version = "1.1.0";
  service.upgrade(["plugin-a"]);
  const done = await settled(service);
  assert.equal(done.batch?.items[0]?.state, "failed");
  assert.equal(calls.length, 0);
});

test("Native failure continues batch, exposes build approval, and can be retried explicitly", async () => {
  const { service, manager } = fixture();
  const original = manager.installBundle;
  let fail = true;
  manager.installBundle = async (spec, options) =>
    spec.startsWith("plugin-a@") && fail
      ? {
          application: "failed",
          error: { code: "build-blocked" },
          pendingBuilds: ["native-addon"],
        }
      : original(spec, options);
  await service.check();
  service.upgrade(["plugin-a", "plugin-b"]);
  const done = await settled(service);
  assert.deepEqual(
    done.batch?.items.map((item) => item.state),
    ["failed", "done"],
  );
  assert.deepEqual(done.batch?.items[0]?.pendingBuilds, ["native-addon"]);
  fail = false;
  service.upgrade(["plugin-a"]);
  assert.equal((await settled(service)).batch?.items[0]?.state, "done");
});

test("Success is verified against actual installed bundle, not result.version alone", async () => {
  const { service, manager } = fixture();
  manager.installBundle = async () => ({ version: "2.0.0" });
  await service.check();
  service.upgrade(["plugin-a"]);
  assert.equal((await settled(service)).batch?.items[0]?.state, "failed");
});

test("Hot reload restriction is reported without invoking install", async () => {
  const { service, calls } = fixture(undefined, { hotReload: () => true });
  assert.equal((await service.check()).development, true);
  assert.throws(() => service.upgrade(["plugin-a"]), /development host/);
  assert.equal(calls.length, 0);
});

test("Status is an isolated snapshot and malformed RPC requests fail closed", async () => {
  const { service } = fixture();
  await service.check();
  service.status().items.length = 0;
  assert.equal(service.status().items.length, 2);
  await assert.rejects(
    service.handle({ op: "upgrade", names: [null] }),
    /Invalid/,
  );
  assert.throws(() => service.upgrade(["unknown"]), /stale/);
});

test("Disposal does not abort native apply but prevents queued installs", async () => {
  const { service, manager, rows } = fixture();
  manager.installBundle = async () => {
    service.dispose();
    rows[0]!.version = "2.0.0";
    return {};
  };
  await service.check();
  service.upgrade(["plugin-a", "plugin-b"]);
  assert.deepEqual(
    (await settled(service)).batch?.items.map((item) => item.state),
    ["done", "skipped"],
  );
});

test("Restart reminder survives recheck and failed retries", async () => {
  const { service, manager } = fixture();
  const original = manager.installBundle;
  manager.installBundle = async (spec, options) =>
    spec.startsWith("plugin-b@")
      ? { application: "failed", error: { code: "network" } }
      : original(spec, options);
  await service.check();
  service.upgrade(["plugin-a", "plugin-b"]);
  assert.equal((await settled(service)).restartRequired, true);
  service.upgrade(["plugin-b"]);
  assert.equal((await settled(service)).restartRequired, true);
  const checked = await service.check();
  assert.equal(checked.restartRequired, true);
  assert.equal(checked.batch, undefined);
});

test("Native restart-required remains visible when post-install verification fails", async () => {
  const { service, manager } = fixture();
  manager.installBundle = async () => ({ application: "restart-required" });
  await service.check();
  service.upgrade(["plugin-a"]);
  const done = await settled(service);
  assert.equal(done.batch?.items[0]?.state, "failed");
  assert.equal(done.restartRequired, true);
  assert.equal((await service.check()).restartRequired, true);
});

test("RPC check returns immediately and exposes progressive server-owned results", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { service } = fixture(undefined, {
    latest: async () => {
      await gate;
      return "2.0.0";
    },
  });
  const checking = await service.handle({ op: "check" });
  assert.equal(checking.busy, "checking");
  assert.equal((await service.handle({ op: "status" })).busy, "checking");
  release();
  assert.equal((await settled(service)).items.length, 2);
});

test("Windows command wrapper handles .cmd without unsafe argument interpolation", () => {
  const command = packageCommand(
    "C:/Program Files/pnpm.cmd",
    ["view", "@scope/plugin@latest", "--json"],
    "win32",
  );
  assert.match(command.command, /cmd\.exe$/i);
  assert.deepEqual(command.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(
    command.args[3],
    '""C:/Program Files/pnpm.cmd" "view" "@scope/plugin@latest" "--json""',
  );
  assert.match(packageCommand("pnpm", ["view"], "win32").args[3]!, /pnpm\.cmd/);
  assert.throws(
    () =>
      packageCommand(
        "pnpm.cmd",
        ["--registry=https://example.test/?a=1&b=2"],
        "win32",
      ),
    /Unsafe/,
  );
  assert.deepEqual(
    packageCommand("node.exe", ["C:/pnpm.mjs", "view"], "win32"),
    { command: "node.exe", args: ["C:/pnpm.mjs", "view"] },
  );
});

test("Client recovers a lost upgrade reply by reading status without resubmitting", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: string[] = [];
  const state: UpdateStatus = { available: true, busy: null, items: [], restartRequired: true };
  const store = new PluginUpdatesStore({
    call: async (_channel, _method, payload) => {
      const op = (payload as { op: string }).op;
      requests.push(op);
      if (op === "upgrade") throw new Error("Reply lost");
      return { ok: true, value: state };
    },
  });
  try {
    await store.run({ op: "upgrade", names: ["plugin-a"] });
    assert.equal(store.getSnapshot().error, "Reply lost");
    context.mock.timers.tick(2500);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, ["upgrade", "status"]);
    assert.equal(store.getSnapshot().status?.restartRequired, true);
    assert.equal(store.getSnapshot().error, undefined);
  } finally {
    store.dispose();
    context.mock.timers.reset();
  }
});

test("Client store unwraps native transport envelope and reports failures", async () => {
  const state: UpdateStatus = { available: true, busy: null, items: [] };
  const store = new PluginUpdatesStore({
    call: async () => ({ ok: true, value: state }),
  });
  await store.load();
  assert.deepEqual(store.getSnapshot().status, state);
  store.dispose();
  const failed = new PluginUpdatesStore({
    call: async () => ({ ok: false, error: { message: "offline" } }),
  });
  await failed.load();
  assert.equal(failed.getSnapshot().error, "offline");
  failed.dispose();
});

test("This plugin is upgraded too, last in its batch", async () => {
  const { service, calls } = fixture([row("dsh-agent-hub"), row("plugin-a")]);
  await service.check();
  service.upgrade(["dsh-agent-hub", "plugin-a"]);
  await settled(service);
  assert.deepEqual(
    calls.map((call) => call.spec),
    ["plugin-a@2.0.0", "dsh-agent-hub@2.0.0"],
  );
});

test("A hot-reloading host schedules upgrades for the restart instead of refusing them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-pending-"));
  try {
    const pending = new PendingOps(dir);
    const { service, calls } = fixture(undefined, {
      hotReload: () => true,
      pending,
    });
    await service.check();
    const state = service.upgrade(["plugin-a"]);
    assert.equal(calls.length, 0);
    assert.equal(state.busy, null);
    assert.deepEqual(state.batch?.items.map((item) => item.state), ["scheduled"]);
    assert.deepEqual(state.pending, [{ name: "plugin-a", spec: "2.0.0", from: "1.0.0" }]);
    assert.equal(state.restartRequired, true);
    const job = pending.job({ dir: "/profile", packageManager: { command: "node", args: ["pnpm.cjs"] } }, "https://r.example/");
    assert.deepEqual(job?.commands, [{ command: "node", args: ["pnpm.cjs", "add", "plugin-a@2.0.0", "--save-exact", "--registry=https://r.example/"] }]);
    const cleared = await service.handle({ op: "unschedule" });
    assert.equal(cleared.pending, undefined);
    assert.equal(pending.job({ dir: "/profile" }), undefined);
    // An upgrade the profile already has is dropped.
    pending.add([{ name: "plugin-b", spec: "2.0.0" }]);
    pending.prune({ "plugin-b": "2.0.0" });
    assert.deepEqual(pending.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
