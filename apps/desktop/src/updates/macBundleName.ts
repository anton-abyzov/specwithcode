import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { compareSemverVersions } from "@specweave-studio/shared/semver";

import {
  LSREGISTER_PATH,
  readBundleIdentity,
  resolveRunningAppBundle,
  type BundleIdentity,
} from "./macSwapInstall.ts";

/**
 * Moves an install that still carries an earlier release's bundle name onto
 * the current one, for example `/Applications/SpecWeave Studio (Alpha).app`
 * to `/Applications/SpecWithCode.app`.
 *
 * Updates cannot do this themselves: the bundle swap and Squirrel.Mac both
 * install the new release at the running bundle's path, and the script that
 * performs the swap is the old release's. So the new release renames its own
 * bundle on first launch: it hands a small script the rename, quits, and the
 * script moves the bundle once the app has exited and opens it again.
 *
 * The bundle id, code signature, user data folder and Keychain item do not
 * depend on the bundle's file name, so the renamed app keeps every setting,
 * connection, encrypted secret and macOS permission. See docs/studio/naming.md.
 */

/**
 * Earlier bundle names and the name that replaces each. Only these are ever
 * renamed or cleaned up; a name the user chose is left alone.
 */
export const LEGACY_BUNDLE_SUCCESSORS: Readonly<Record<string, string>> = {
  "SpecWeave Studio (Alpha).app": "SpecWithCode.app",
  "SpecWeave Studio (Nightly).app": "SpecWithCode (Nightly).app",
};

/** The bundle name this build expects: its executable is named after the product. */
export function expectedBundleName(execPath: string): string {
  return `${NodePath.basename(execPath)}.app`;
}

/**
 * Where an update should put the new bundle: under the new release's name
 * when the running bundle still has the earlier name it replaces, otherwise
 * at the running bundle's own path.
 */
export function resolveSwapTarget(currentBundle: string, stagedBundle: string): string {
  const stagedName = NodePath.basename(stagedBundle);
  return LEGACY_BUNDLE_SUCCESSORS[NodePath.basename(currentBundle)] === stagedName
    ? NodePath.join(NodePath.dirname(currentBundle), stagedName)
    : currentBundle;
}

export interface BundleRenameMarker {
  readonly version: string;
  readonly from: string;
}

export type BundleRenamePlan =
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "rename"; readonly current: string; readonly target: string };

export function planBundleRename(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly appVersion: string;
  readonly exists: (path: string) => boolean;
  readonly writable: (path: string) => boolean;
  readonly marker: BundleRenameMarker | null;
}): BundleRenamePlan {
  if (input.platform !== "darwin") return { kind: "skip", reason: "not-macos" };
  if (!input.isPackaged) return { kind: "skip", reason: "development" };
  const current = resolveRunningAppBundle(input.execPath);
  if (current === null) return { kind: "skip", reason: "no-bundle" };
  const name = NodePath.basename(current);
  const expected = expectedBundleName(input.execPath);
  if (name === expected) return { kind: "skip", reason: "already-named" };
  if (LEGACY_BUNDLE_SUCCESSORS[name] !== expected) return { kind: "skip", reason: "custom-name" };
  if (current.includes("/AppTranslocation/") || current.startsWith("/Volumes/")) {
    return { kind: "skip", reason: "read-only-location" };
  }
  if (!input.writable(NodePath.dirname(current)) || !input.writable(current)) {
    return { kind: "skip", reason: "not-writable" };
  }
  const target = NodePath.join(NodePath.dirname(current), expected);
  if (input.exists(target)) return { kind: "skip", reason: "target-exists" };
  // A rename that failed once relaunches this same bundle; trying again on
  // every launch would loop.
  if (input.marker?.version === input.appVersion && input.marker.from === current) {
    return { kind: "skip", reason: "already-attempted" };
  }
  return { kind: "rename", current, target };
}

/**
 * Waits for the app to exit, renames the bundle if the new name is still
 * free, updates Launch Services and opens whichever bundle exists. `open -n`
 * starts this exact bundle even when another copy shares the bundle id.
 */
export const RENAME_SCRIPT = `#!/bin/sh
set -u
pid="$1"; current="$2"; target="$3"; lsregister="$4"; opener="$5"
shift 5
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 1200 ]; then exit 1; fi
  sleep 0.1
done
launch="$current"
if [ ! -e "$target" ] && [ ! -L "$target" ] && mv "$current" "$target"; then
  launch="$target"
  "$lsregister" -u "$current" >/dev/null 2>&1 || true
  "$lsregister" -f "$target" >/dev/null 2>&1 || true
fi
exec "$opener" -n "$@" "$launch"
`;

/**
 * Environment worth keeping across the relaunch. `open` starts apps with the
 * login session's environment, so a copy started with its own HOME or Studio
 * home would otherwise come back on the default profile.
 */
export function relaunchEnvironmentArgs(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "HOME" || key.startsWith("STUDIO_")) args.push("--env", `${key}=${value}`);
  }
  return args;
}

export function startDetachedRename(input: {
  readonly scriptPath: string;
  readonly pid: number;
  readonly current: string;
  readonly target: string;
  readonly env: NodeJS.ProcessEnv;
  readonly lsregister?: string;
  readonly opener?: string;
}): void {
  NodeFS.writeFileSync(input.scriptPath, RENAME_SCRIPT, { mode: 0o700 });
  const child = NodeChildProcess.spawn(
    "/bin/sh",
    [
      input.scriptPath,
      String(input.pid),
      input.current,
      input.target,
      input.lsregister ?? LSREGISTER_PATH,
      input.opener ?? "/usr/bin/open",
      ...relaunchEnvironmentArgs(input.env),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

function readMarker(markerPath: string): BundleRenameMarker | null {
  try {
    const value = JSON.parse(NodeFS.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    return typeof value.version === "string" && typeof value.from === "string"
      ? { version: value.version, from: value.from }
      : null;
  } catch {
    return null;
  }
}

function isWritable(path: string): boolean {
  try {
    NodeFS.accessSync(path, NodeFS.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the rename when this launch needs one. A "rename" plan means the
 * caller must exit now so the script can move the bundle.
 */
export function startBundleRenameIfNeeded(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly appVersion: string;
  readonly pid: number;
  readonly workDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly start?: typeof startDetachedRename;
}): BundleRenamePlan {
  const markerPath = NodePath.join(input.workDir, "bundle-rename.json");
  const plan = planBundleRename({
    platform: input.platform,
    isPackaged: input.isPackaged,
    execPath: input.execPath,
    appVersion: input.appVersion,
    exists: (path) => NodeFS.existsSync(path),
    writable: isWritable,
    marker: readMarker(markerPath),
  });
  if (plan.kind !== "rename") return plan;
  NodeFS.mkdirSync(input.workDir, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(
    markerPath,
    `${JSON.stringify({ version: input.appVersion, from: plan.current })}\n`,
    { mode: 0o600 },
  );
  (input.start ?? startDetachedRename)({
    scriptPath: NodePath.join(input.workDir, "bundle-rename.sh"),
    pid: input.pid,
    current: plan.current,
    target: plan.target,
    env: input.env,
  });
  return plan;
}

export interface LegacySibling {
  readonly path: string;
  readonly identity: BundleIdentity;
  readonly running: boolean;
}

/**
 * Earlier-named copies next to this app that a manual install left behind:
 * same bundle id, not newer than this app and not running. Anything else,
 * including a newer copy or another channel's app, stays.
 */
export function selectLegacySiblingsToRemove(input: {
  readonly current: string;
  readonly own: BundleIdentity;
  readonly siblings: ReadonlyArray<LegacySibling>;
}): string[] {
  const ownName = NodePath.basename(input.current);
  if (input.own.bundleId === null || input.own.version === null) return [];
  const ownVersion = input.own.version;
  return input.siblings
    .filter((sibling) => {
      if (NodePath.dirname(sibling.path) !== NodePath.dirname(input.current)) return false;
      if (LEGACY_BUNDLE_SUCCESSORS[NodePath.basename(sibling.path)] !== ownName) return false;
      if (sibling.running) return false;
      if (sibling.identity.bundleId !== input.own.bundleId) return false;
      if (sibling.identity.version === null) return false;
      try {
        return compareSemverVersions(sibling.identity.version, ownVersion) <= 0;
      } catch {
        return false;
      }
    })
    .map((sibling) => sibling.path);
}

function runningExecutables(): Promise<string[]> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "/bin/ps",
      ["-axo", "comm="],
      { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        resolve(error ? [] : String(stdout).split("\n"));
      },
    );
  });
}

/**
 * Moves leftover earlier-named copies of this app to the Trash, where the
 * user can still restore them, and drops them from Launch Services.
 */
export async function trashLegacySiblings(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly trashItem: (path: string) => Promise<void>;
  readonly lsregister?: string;
}): Promise<string[]> {
  if (input.platform !== "darwin" || !input.isPackaged) return [];
  const current = resolveRunningAppBundle(input.execPath);
  if (current === null) return [];
  const ownName = NodePath.basename(current);
  const candidates = Object.entries(LEGACY_BUNDLE_SUCCESSORS)
    .filter(([, successor]) => successor === ownName)
    .map(([legacy]) => NodePath.join(NodePath.dirname(current), legacy))
    .filter((path) => NodeFS.existsSync(path));
  if (candidates.length === 0) return [];
  const [own, processes] = await Promise.all([readBundleIdentity(current), runningExecutables()]);
  const siblings: LegacySibling[] = [];
  for (const path of candidates) {
    const identity = await readBundleIdentity(path).catch((): BundleIdentity => ({
      bundleId: null,
      version: null,
    }));
    const running = processes.some((line) => line.startsWith(`${path}/`));
    siblings.push({ path, identity, running });
  }
  const removed: string[] = [];
  for (const path of selectLegacySiblingsToRemove({ current, own, siblings })) {
    await input.trashItem(path);
    removed.push(path);
    await new Promise<void>((resolve) => {
      NodeChildProcess.execFile(input.lsregister ?? LSREGISTER_PATH, ["-u", path], () => resolve());
    });
  }
  return removed;
}
