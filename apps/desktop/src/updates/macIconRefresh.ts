// @effect-diagnostics-next-line nodeBuiltinImport:off -- The icon refresh runs once at startup with native macOS tools before the app runtime.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The icon refresh runs once at startup with native macOS tools before the app runtime.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The icon refresh runs once at startup with native macOS tools before the app runtime.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The icon refresh runs once at startup with native macOS tools before the app runtime.
import * as NodePath from "node:path";

import { LSREGISTER_PATH, resolveRunningAppBundle } from "./macSwapInstall.ts";

/**
 * Updates replace the bundle in place, so macOS keeps drawing the icon it
 * cached for the old bundle: Finder shows the new icon while the Dock keeps
 * the old one until it reloads. On the first launch of each version the app
 * bumps its bundle's date and registers it with Launch Services again. When
 * the icon itself changed, the Dock still draws its own saved copy from
 * `com.apple.dock.iconcache` in the user cache folder, which survives a Dock
 * restart (seen on macOS 27). Reloading clears that file and the user's icon
 * services cache, both rebuilt by macOS, then restarts the Dock. The app
 * offers that once and never does it unasked.
 */

export const ICON_REFRESH_FILE = "mac-icon-refresh.json";

/**
 * A file every earlier version leaves in the user data folder once it has
 * run, so a first launch after an update is told apart from a new install.
 */
const PRIOR_LAUNCH_MARKER = "environment-id";

export interface IconRefreshRecord {
  readonly version: string;
  readonly iconStamp: string | null;
}

export type IconRefreshPlan =
  | { readonly kind: "skip"; readonly reason: string }
  | {
      readonly kind: "refresh";
      readonly bundle: string;
      /** The icon differs from the one the last launched version had. */
      readonly offerDockRestart: boolean;
    };

const BundlePath = NodePath.posix;

export function parseIconRefreshRecord(text: string | null): IconRefreshRecord | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.version !== "string") return null;
    return {
      version: value.version,
      iconStamp: typeof value.iconStamp === "string" ? value.iconStamp : null,
    };
  } catch {
    return null;
  }
}

export function planIconRefresh(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly appVersion: string;
  readonly previous: IconRefreshRecord | null;
  readonly iconStamp: string | null;
  /** An earlier version has run with this user data folder. */
  readonly hadPriorLaunch: boolean;
}): IconRefreshPlan {
  if (input.platform !== "darwin" || !input.isPackaged) return { kind: "skip", reason: "platform" };
  const bundle = resolveRunningAppBundle(input.execPath);
  if (bundle === null) return { kind: "skip", reason: "no-bundle" };
  if (bundle.includes("/AppTranslocation/") || bundle.startsWith("/Volumes/")) {
    return { kind: "skip", reason: "temporary-copy" };
  }
  if (input.previous?.version === input.appVersion) return { kind: "skip", reason: "same-version" };
  const offerDockRestart =
    input.iconStamp !== null &&
    (input.previous === null ? input.hadPriorLaunch : input.previous.iconStamp !== input.iconStamp);
  return { kind: "refresh", bundle, offerDockRestart };
}

/** A digest of the compiled icon (Assets.car), or of the legacy icns when there is none. */
export function readIconStamp(bundle: string): string | null {
  const resources = BundlePath.join(bundle, "Contents", "Resources");
  for (const name of ["Assets.car", "icon.icns"]) {
    try {
      const data = NodeFS.readFileSync(BundlePath.join(resources, name));
      return `${name}:${NodeCrypto.createHash("sha256").update(data).digest("hex").slice(0, 32)}`;
    } catch {
      // Try the next file.
    }
  }
  return null;
}

export interface IconRefreshPrompt {
  readonly title: string;
  readonly detail: string;
  readonly buttons: readonly [string, string];
}

export const DOCK_RESTART_PROMPT: IconRefreshPrompt = {
  title: "SpecWithCode has a new icon",
  detail:
    "The Dock may keep showing the old icon until it reloads. Reload the Dock now? It disappears for a moment; your windows and apps stay open.",
  buttons: ["Reload Dock", "Not Now"],
};

export interface IconRefreshHost {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly appVersion: string;
  readonly workDir: string;
  /** Shows the prompt and resolves to the chosen button's index. */
  readonly ask: (prompt: IconRefreshPrompt) => Promise<number>;
  readonly log: (message: string, data?: Record<string, unknown>) => void;
  readonly tools?: IconRefreshTools;
}

export interface IconRefreshTools {
  readonly touch: (path: string) => Promise<void>;
  readonly lsregister: (args: ReadonlyArray<string>) => Promise<void>;
  /** Removes the user-level Dock and icon services caches; macOS rebuilds both. */
  readonly clearDockIconCache: () => Promise<void>;
  /** Process ids of this user's Dock. */
  readonly dockPids: () => Promise<number[]>;
  readonly kill: (pid: number) => void;
}

function execFile(command: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(command, [...args], { timeout: 30_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

export const nativeIconRefreshTools: IconRefreshTools = {
  touch: async (path) => {
    await execFile("/usr/bin/touch", [path]);
  },
  lsregister: async (args) => {
    await execFile(LSREGISTER_PATH, args);
  },
  clearDockIconCache: async () => {
    const cacheDir = (await execFile("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"])).trim();
    // Only a per-user cache folder under /private/var/folders or /var/folders.
    if (!/^(\/private)?\/var\/folders\/.+/.test(cacheDir)) return;
    NodeFS.rmSync(NodePath.join(cacheDir, "com.apple.dock.iconcache"), { force: true });
    NodeFS.rmSync(NodePath.join(cacheDir, "com.apple.iconservices"), {
      recursive: true,
      force: true,
    });
  },
  dockPids: async () => {
    const uid = process.getuid?.();
    if (uid === undefined) return [];
    // pgrep exits 1 when nothing matches.
    const out = await execFile("/usr/bin/pgrep", ["-x", "-U", String(uid), "Dock"]).catch(() => "");
    return out
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  },
  // launchd starts the Dock again right away.
  kill: (pid) => process.kill(pid, "SIGTERM"),
};

function readText(path: string): string | null {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Runs once per version; never throws. */
export async function refreshMacIconAfterUpdate(host: IconRefreshHost): Promise<IconRefreshPlan> {
  const tools = host.tools ?? nativeIconRefreshTools;
  const recordPath = NodePath.join(host.workDir, ICON_REFRESH_FILE);
  const bundle = resolveRunningAppBundle(host.execPath);
  const iconStamp =
    host.platform === "darwin" && host.isPackaged && bundle !== null ? readIconStamp(bundle) : null;
  const plan = planIconRefresh({
    platform: host.platform,
    isPackaged: host.isPackaged,
    execPath: host.execPath,
    appVersion: host.appVersion,
    previous: parseIconRefreshRecord(readText(recordPath)),
    iconStamp,
    hadPriorLaunch: NodeFS.existsSync(NodePath.join(host.workDir, PRIOR_LAUNCH_MARKER)),
  });
  if (plan.kind === "skip") return plan;

  await tools
    .touch(plan.bundle)
    .catch((error: unknown) => host.log("icon refresh: touch failed", { error: String(error) }));
  await tools
    .lsregister(["-f", plan.bundle])
    .catch((error: unknown) =>
      host.log("icon refresh: lsregister failed", { error: String(error) }),
    );
  // Recorded before asking, so a prompt the user closes is never shown again.
  try {
    const record: IconRefreshRecord = { version: host.appVersion, iconStamp };
    NodeFS.writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (error) {
    host.log("icon refresh: record not saved", { error: String(error) });
  }
  host.log("icon refresh: bundle registered", {
    bundle: plan.bundle,
    offerDockRestart: plan.offerDockRestart,
  });

  if (plan.offerDockRestart) {
    const choice = await host.ask(DOCK_RESTART_PROMPT).catch(() => 1);
    if (choice === 0) {
      await tools
        .clearDockIconCache()
        .catch((error: unknown) =>
          host.log("icon refresh: Dock icon cache not cleared", { error: String(error) }),
        );
      const pids = await tools.dockPids();
      for (const pid of pids) {
        try {
          tools.kill(pid);
        } catch (error) {
          host.log("icon refresh: Dock restart failed", { pid, error: String(error) });
        }
      }
      host.log("icon refresh: Dock restarted", { pids });
    }
  }
  return plan;
}
