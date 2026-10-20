import { spawn } from "node:child_process";
import type { UpdateProfile } from "./types.ts";

const PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
export function registrySource(name: string, source?: string): boolean {
  if (!PACKAGE.test(name) || !source?.startsWith(`${name}@`)) return false;
  const spec = source.slice(name.length + 1);
  return (
    spec !== "" &&
    !/[/:\\]/.test(spec) &&
    !/\s/.test(spec.replace(/\s+(?=[<>=~^\d*-])/g, ""))
  );
}

/** Strict SemVer precedence; build metadata does not affect precedence. */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (text: string) =>
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      text,
    );
  const left = parse(a),
    right = parse(b);
  if (!left || !right) return undefined;
  for (let i = 1; i <= 3; i++) {
    const x = BigInt(left[i]!),
      y = BigInt(right[i]!);
    if (x !== y) return x > y ? 1 : -1;
  }
  if (left[4] === right[4]) return 0;
  if (left[4] === undefined) return 1;
  if (right[4] === undefined) return -1;
  const x = left[4].split("."),
    y = right[4].split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const xn = /^\d+$/.test(x[i]!),
      yn = /^\d+$/.test(y[i]!);
    if (xn && yn) return BigInt(x[i]!) > BigInt(y[i]!) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x[i]! > y[i]! ? 1 : -1;
  }
  return 0;
}

/** Windows cannot spawn .cmd directly. Reject shell metacharacters before a fully quoted cmd invocation. */
export function packageCommand(
  command: string,
  args: string[],
  platform: string = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32" && /(?:^|[\\/])pnpm$/i.test(command))
    command += ".cmd";
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command))
    return { command, args };
  if ([command, ...args].some((token) => /[%!"\r\n&|<>^]/.test(token)))
    throw new Error(
      "Unsafe Windows package manager argument; configure a Node-based package manager command",
    );
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      `"${[command, ...args].map((token) => `"${token}"`).join(" ")}"`,
    ],
  };
}

/** Read-only pnpm query: preserves profile npmrc, scoped registries, proxy and auth. Never invokes add/install. */
export async function queryLatest(
  profile: UpdateProfile,
  name: string,
  registry?: string,
): Promise<string> {
  if (!PACKAGE.test(name)) throw new Error("Invalid package name");
  const manager = profile.packageManager ?? {
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  };
  const args = [
    ...(manager.args ?? []),
    "view",
    `${name}@latest`,
    "name",
    "version",
    "dsh",
    "--json",
    "--config.fetch-retries=0",
    ...(registry ? [`--registry=${registry}`] : []),
  ];
  const output = await new Promise<string>((resolve, reject) => {
    const run = packageCommand(manager.command, args);
    const child = spawn(run.command, run.args, {
      cwd: profile.dir,
      env: { ...process.env, ...manager.env },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      bytes = 0,
      failure: Error | undefined;
    const stop = (): void => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          "taskkill.exe",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => {
          child.kill();
        });
      } else child.kill();
    };
    const timer = setTimeout(() => {
      failure = new Error("Registry lookup timed out; retry check");
      stop();
    }, 25_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) {
        failure = new Error("Registry response too large");
        stop();
      } else stdout += chunk.toString();
    });
    // Do not expose stderr: pnpm diagnostics can contain private registry URLs or credentials.
    child.stderr.resume();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            "Registry lookup failed; check network, registry authentication and retry",
          ),
        );
      else resolve(stdout);
    });
  });
  const answer: unknown = JSON.parse(output);
  const data = (Array.isArray(answer) ? answer.at(-1) : answer) as {
    name?: unknown;
    version?: unknown;
    dsh?: { bundle?: unknown };
  } | null;
  if (
    data?.name !== name ||
    typeof data.version !== "string" ||
    !data.dsh?.bundle ||
    compareVersions(data.version, data.version) === undefined
  )
    throw new Error("Registry returned invalid plugin metadata");
  return data.version;
}
