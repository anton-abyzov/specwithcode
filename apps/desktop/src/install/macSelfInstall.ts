// @effect-diagnostics-next-line nodeBuiltinImport:off -- The install step runs before the app runtime and must keep spawn, rename and detached-process semantics.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The install step runs before the app runtime and must keep spawn, rename and detached-process semantics.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The install step runs before the app runtime and must keep spawn, rename and detached-process semantics.
import * as NodePath from "node:path";

import { compareSemverVersions } from "@specweave-studio/shared/semver";

import {
  expectedBundleName,
  LEGACY_BUNDLE_SUCCESSORS,
  relaunchEnvironmentArgs,
} from "../updates/macBundleName.ts";
import {
  LSREGISTER_PATH,
  readBundleIdentity,
  removeTree,
  resolveRunningAppBundle,
  type BundleIdentity,
} from "../updates/macSwapInstall.ts";
import {
  fillCopy,
  folderLabel,
  selfInstallCopy,
  type SelfInstallLocale,
} from "./macSelfInstallCopy.ts";

/**
 * "Install SpecWithCode": when the app is opened straight from its disk image
 * (or from the read-only copy macOS makes of a quarantined app, App
 * Translocation), it offers to install itself before anything else starts.
 *
 * It does not use Electron's `app.moveToApplicationsFolder()`. In Electron
 * 44 that call moves the installed app to the Trash before copying the new
 * one, always targets /Applications and asks for an administrator password
 * when that folder is not writable, quits before the app can re-register
 * anything, and knows nothing of earlier bundle names. This step follows the
 * order in docs/studio/releasing.md ("Swapping the desktop app") instead:
 * copy beside the destination, verify, rename, then trash the old copy.
 *
 * Bundle paths are macOS paths on every host, so the planning code uses
 * POSIX paths and its tests give the same answer on Windows.
 */
const BundlePath = NodePath.posix;

export const SELF_INSTALL_ENV = "STUDIO_SELF_INSTALL";
export const SYSTEM_APPLICATIONS = "/Applications";

export type SelfInstallLocation = "disk-image" | "translocated";

export type SelfInstallDetection =
  | { readonly kind: "skip"; readonly reason: string }
  | {
      readonly kind: "offer";
      readonly bundle: string;
      readonly location: SelfInstallLocation;
      readonly bundleName: string;
    };

export function detectSelfInstall(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly inApplicationsFolder: boolean;
}): SelfInstallDetection {
  if (input.platform !== "darwin") return { kind: "skip", reason: "not-macos" };
  if (!input.isPackaged) return { kind: "skip", reason: "development" };
  const optOut = input.env[SELF_INSTALL_ENV]?.trim().toLowerCase();
  if (optOut === "off" || optOut === "0" || optOut === "false") {
    return { kind: "skip", reason: "turned-off" };
  }
  const bundle = resolveRunningAppBundle(input.execPath);
  if (bundle === null) return { kind: "skip", reason: "no-bundle" };
  const location: SelfInstallLocation | null = bundle.includes("/AppTranslocation/")
    ? "translocated"
    : bundle.startsWith("/Volumes/")
      ? "disk-image"
      : null;
  if (location === null) return { kind: "skip", reason: "installed" };
  // Electron also counts any path with an "Applications" folder in it, such
  // as an Applications folder on a second disk.
  if (input.inApplicationsFolder && location === "disk-image") {
    return { kind: "skip", reason: "installed" };
  }
  return { kind: "offer", bundle, location, bundleName: expectedBundleName(input.execPath) };
}

export interface SelfInstallDestination {
  readonly dir: string;
  readonly userFolder: boolean;
}

/** /Applications when this user may write to it, otherwise ~/Applications. */
export function chooseDestination(input: {
  readonly homeDir: string;
  readonly writable: (path: string) => boolean;
}): SelfInstallDestination {
  if (input.writable(SYSTEM_APPLICATIONS)) return { dir: SYSTEM_APPLICATIONS, userFolder: false };
  return { dir: BundlePath.join(input.homeDir, "Applications"), userFolder: true };
}

/** The current bundle name and every earlier name it replaces. */
export function candidateBundleNames(bundleName: string): string[] {
  return [
    bundleName,
    ...Object.entries(LEGACY_BUNDLE_SUCCESSORS)
      .filter(([, successor]) => successor === bundleName)
      .map(([legacy]) => legacy),
  ];
}

export interface InstalledCopy {
  readonly path: string;
  readonly identity: BundleIdentity;
  readonly running: boolean;
  /** Its folder can be written, so it can be replaced or moved to the Trash. */
  readonly removable: boolean;
}

export type SelfInstallDecision =
  | {
      readonly kind: "install";
      readonly target: string;
      /** An older copy at the target path, swapped out after the new one is verified. */
      readonly replace: string | null;
      /** Older same-id copies elsewhere (earlier names, the other Applications folder). */
      readonly trash: ReadonlyArray<string>;
    }
  | { readonly kind: "open-installed"; readonly path: string; readonly version: string }
  | { readonly kind: "switch-to-running"; readonly path: string }
  | { readonly kind: "quit-older-first"; readonly path: string }
  | { readonly kind: "blocked"; readonly path: string };

function isNewerOrSame(version: string | null, own: string): boolean {
  if (version === null) return false;
  try {
    return compareSemverVersions(version, own) >= 0;
  } catch {
    return false;
  }
}

/**
 * What to do about the copies already installed. Only copies with this app's
 * bundle id count; an unrelated app under the target name blocks the install
 * and is never touched. A target with no readable Info.plist is a broken
 * install (a cut-short copy) and is replaced.
 */
export function decideSelfInstall(input: {
  readonly own: BundleIdentity;
  readonly target: string;
  readonly copies: ReadonlyArray<InstalledCopy>;
}): SelfInstallDecision {
  const ownVersion = input.own.version ?? "0.0.0";
  const atTarget = input.copies.find((copy) => copy.path === input.target);
  if (
    atTarget !== undefined &&
    atTarget.identity.bundleId !== null &&
    atTarget.identity.bundleId !== input.own.bundleId
  ) {
    return { kind: "blocked", path: atTarget.path };
  }
  const same = input.copies.filter(
    (copy) => copy.identity.bundleId === input.own.bundleId && copy.identity.bundleId !== null,
  );
  // The target first, so a running or newer copy under the current name wins.
  const ordered = [...same].sort(
    (a, b) => Number(b.path === input.target) - Number(a.path === input.target),
  );
  const running = ordered.find((copy) => copy.running);
  if (running !== undefined && isNewerOrSame(running.identity.version, ownVersion)) {
    return { kind: "switch-to-running", path: running.path };
  }
  // An older copy that is open blocks only when this install would replace
  // or trash it; one this user cannot remove simply stays.
  const runningOlder = ordered.find((copy) => copy.running && copy.removable);
  if (runningOlder !== undefined) return { kind: "quit-older-first", path: runningOlder.path };
  const newer = ordered.find((copy) => isNewerOrSame(copy.identity.version, ownVersion));
  if (newer !== undefined) {
    return {
      kind: "open-installed",
      path: newer.path,
      version: newer.identity.version ?? ownVersion,
    };
  }
  if (atTarget !== undefined && !atTarget.removable) {
    return { kind: "blocked", path: atTarget.path };
  }
  return {
    kind: "install",
    target: input.target,
    replace: atTarget === undefined ? null : atTarget.path,
    trash: same
      .filter((copy) => copy.path !== input.target && copy.removable)
      .map((copy) => copy.path),
  };
}

// ---------------------------------------------------------------------------
// Launch Services and LaunchAgents

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Points every path inside one of the old bundles at the installed bundle.
 * Only whole bundle paths match: `/Volumes/X/SpecWithCode.app` followed by
 * `/` or the end of the string value, never a longer name.
 */
export function rewriteBundlePaths(
  plistText: string,
  from: ReadonlyArray<string>,
  to: string,
): string {
  let text = plistText;
  for (const old of from) {
    const pattern = new RegExp(`${escapeRegExp(escapeXml(old))}(?=[/<:])`, "g");
    text = text.replace(pattern, () => escapeXml(to));
  }
  return text;
}

/** True when the job's program runs from one of the old bundles, so it fails once that is gone. */
export function programUsesBundle(plistText: string, from: ReadonlyArray<string>): boolean {
  const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plistText);
  if (program === null) return false;
  return from.some((old) => program[1]!.includes(`${escapeXml(old)}/`));
}

export interface ReregisterResult {
  readonly rewritten: ReadonlyArray<string>;
  readonly reloaded: ReadonlyArray<string>;
}

/**
 * Rewrites this app's LaunchAgents that name an old bundle path. A job whose
 * program ran from the old bundle is reloaded; one that only lists the old
 * bundle (for example in PATH) keeps running and picks the change up on its
 * next load, so a live service is not restarted for nothing.
 */
export function reregisterLaunchAgents(input: {
  readonly homeDir: string;
  readonly uid: number;
  readonly from: ReadonlyArray<string>;
  readonly to: string;
  readonly launchctl?: (args: ReadonlyArray<string>) => void;
}): ReregisterResult {
  const dir = NodePath.join(input.homeDir, "Library", "LaunchAgents");
  let names: string[];
  try {
    names = NodeFS.readdirSync(dir);
  } catch {
    return { rewritten: [], reloaded: [] };
  }
  const launchctl =
    input.launchctl ??
    ((args: ReadonlyArray<string>) => {
      try {
        NodeChildProcess.execFileSync("/bin/launchctl", [...args], {
          stdio: "ignore",
          timeout: 15_000,
        });
      } catch {
        // bootout of a job that is not loaded fails; bootstrap failures are
        // left for the service's own repair on the next launch.
      }
    });
  const rewritten: string[] = [];
  const reloaded: string[] = [];
  for (const name of names) {
    if (!name.startsWith("com.specweave.studio") || !name.endsWith(".plist")) continue;
    const file = NodePath.join(dir, name);
    let stat: NodeFS.Stats;
    let text: string;
    try {
      stat = NodeFS.lstatSync(file);
      if (!stat.isFile() || stat.uid !== input.uid) continue;
      text = NodeFS.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const next = rewriteBundlePaths(text, input.from, input.to);
    if (next === text) continue;
    const reload = programUsesBundle(text, input.from);
    const temp = `${file}.self-install-${process.pid}`;
    NodeFS.writeFileSync(temp, next, { mode: stat.mode & 0o777 });
    NodeFS.renameSync(temp, file);
    rewritten.push(file);
    if (reload) {
      const label = name.slice(0, -".plist".length);
      launchctl(["bootout", `gui/${input.uid}/${label}`]);
      launchctl(["bootstrap", `gui/${input.uid}`, file]);
      reloaded.push(file);
    }
  }
  return { rewritten, reloaded };
}

// ---------------------------------------------------------------------------
// Disk image and translocation

export interface MountEntry {
  readonly from: string;
  readonly on: string;
}

/** Parses `/sbin/mount` output: `<from> on <mountpoint> (<options>)`. */
export function parseMountTable(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const match = /^(.+?) on (.+) \([^()]*\)$/.exec(line.trim());
    if (match) entries.push({ from: match[1]!, on: match[2]! });
  }
  return entries;
}

/**
 * The folder macOS translocated: the translocation mount whose mount point
 * holds the running bundle. Its source is the bundle's real folder, for a
 * disk image somewhere under /Volumes.
 */
export function translocationSource(
  bundle: string,
  mounts: ReadonlyArray<MountEntry>,
): string | null {
  let best: MountEntry | null = null;
  for (const entry of mounts) {
    if (!entry.on.includes("/AppTranslocation/")) continue;
    if (!bundle.startsWith(`${entry.on}/`)) continue;
    if (best === null || entry.on.length > best.on.length) best = entry;
  }
  return best?.from ?? null;
}

/** `/Volumes/SpecWithCode 1.0.306/SpecWithCode.app` -> `/Volumes/SpecWithCode 1.0.306` */
export function volumeOf(path: string): string | null {
  const match = /^\/Volumes\/[^/]+/.exec(path);
  return match ? match[0] : null;
}

/**
 * True when `volume` is a mounted disk image according to `hdiutil info`,
 * whose entity lines end with a tab and the mount point. A USB disk or a
 * network share never appears there, so it is never ejected.
 */
export function isDiskImageMount(hdiutilInfo: string, volume: string): boolean {
  return hdiutilInfo.split("\n").some((line) => {
    const fields = line.split("\t");
    return fields.length > 1 && fields[fields.length - 1]!.trim() === volume;
  });
}

// ---------------------------------------------------------------------------
// The install itself

function run(command: string, args: ReadonlyArray<string>, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim();
          reject(detail ? new Error(`${error.message}: ${detail}`) : error);
        } else resolve(String(stdout));
      },
    );
  });
}

function exists(path: string): boolean {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function isWritable(path: string): boolean {
  try {
    NodeFS.accessSync(path, NodeFS.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function stagingPath(target: string, version: string): string {
  return BundlePath.join(
    BundlePath.dirname(target),
    `.${BundlePath.basename(target)}-${version}-install`,
  );
}

export interface SelfInstallTools {
  readonly copy: (source: string, destination: string) => Promise<void>;
  readonly verify: (bundle: string) => Promise<void>;
  readonly identity: (bundle: string) => Promise<BundleIdentity>;
  readonly trash: (path: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly lsregister: (args: ReadonlyArray<string>) => Promise<void>;
}

export const nativeTools = (trash: (path: string) => Promise<void>): SelfInstallTools => ({
  // --noqtn: the copy must not carry the disk image's quarantine flag, or
  // macOS would translocate the installed app again on its first launch.
  // The bundle is the one already running, checked by Gatekeeper on open.
  copy: async (source, destination) => {
    await run("/usr/bin/ditto", ["--noqtn", source, destination], 600_000);
  },
  verify: async (bundle) => {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], 600_000);
  },
  identity: readBundleIdentity,
  trash,
  remove: removeTree,
  lsregister: async (args) => {
    await run(LSREGISTER_PATH, args).catch(() => undefined);
  },
});

/**
 * Copies the running bundle to the target in the swap order. Throws, with the
 * destination as it was, when the copy or its check fails.
 */
export async function installBundle(input: {
  readonly source: string;
  readonly target: string;
  readonly own: BundleIdentity;
  readonly trash: ReadonlyArray<string>;
  readonly tools: SelfInstallTools;
  /** Checked again right before the installed copy is moved aside. */
  readonly isRunning?: (bundle: string) => Promise<boolean>;
}): Promise<{ readonly trashed: ReadonlyArray<string> }> {
  const { tools, target } = input;
  const version = input.own.version ?? "0.0.0";
  const staging = stagingPath(target, version);
  const old = `${target}.install-old`;
  NodeFS.mkdirSync(BundlePath.dirname(target), { recursive: true });
  // A run cut short between the two renames left the old app aside: put it
  // back when nothing took its place.
  if (exists(old) && !exists(target)) NodeFS.renameSync(old, target);
  // A leftover from an earlier run goes to the Trash, never straight to
  // deletion; if that fails it stays, and the rename below refuses to
  // overwrite it.
  if (exists(old)) await tools.trash(old).catch(() => undefined);
  await tools.remove(staging);
  try {
    await tools.copy(input.source, staging);
    await tools.verify(staging);
    const copied = await tools.identity(staging);
    if (copied.bundleId !== input.own.bundleId || copied.version !== input.own.version) {
      throw new Error("The copied app does not match the app that is running.");
    }
  } catch (error) {
    await tools.remove(staging).catch(() => undefined);
    throw error;
  }
  if (exists(target)) {
    if (input.isRunning !== undefined && (await input.isRunning(target))) {
      await tools.remove(staging).catch(() => undefined);
      throw new Error(
        `${BundlePath.basename(target)} was opened while installing. Quit it and try again.`,
      );
    }
    NodeFS.renameSync(target, old);
    try {
      NodeFS.renameSync(staging, target);
    } catch (error) {
      NodeFS.renameSync(old, target);
      await tools.remove(staging).catch(() => undefined);
      throw error;
    }
    // Kept as .install-old when the Trash refuses it; the next install moves
    // it to the Trash again.
    await tools.trash(old).catch(() => undefined);
    await tools.lsregister(["-u", old]).catch(() => undefined);
  } else {
    NodeFS.renameSync(staging, target);
  }
  const trashed: string[] = [];
  for (const path of input.trash) {
    try {
      await tools.trash(path);
      trashed.push(path);
      await tools.lsregister(["-u", path]).catch(() => undefined);
    } catch {
      // Left in place; the installed app trashes leftover earlier-named
      // copies on each launch (macBundleName.trashLegacySiblings).
    }
  }
  return { trashed };
}

/**
 * Waits for this process to exit, opens the installed app, then ejects the
 * disk image it came from. `hdiutil detach` without `-force` leaves a disk
 * image that is still in use mounted.
 */
export const RELAUNCH_SCRIPT = `#!/bin/sh
set -u
pid="$1"; target="$2"; opener="$3"; volume="$4"; hdiutil="$5"
shift 5
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 1200 ]; then exit 1; fi
  sleep 0.1
done
"$opener" -n "$@" "$target"
if [ -n "$volume" ]; then
  sleep 3
  "$hdiutil" detach "$volume" >/dev/null 2>&1 || true
fi
`;

export function startDetachedRelaunch(input: {
  readonly scriptPath: string;
  readonly pid: number;
  readonly target: string;
  readonly volume: string | null;
  readonly env: NodeJS.ProcessEnv;
  readonly opener?: string;
  readonly hdiutil?: string;
}): void {
  NodeFS.mkdirSync(NodePath.dirname(input.scriptPath), { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(input.scriptPath, RELAUNCH_SCRIPT, { mode: 0o700 });
  const child = NodeChildProcess.spawn(
    "/bin/sh",
    [
      input.scriptPath,
      String(input.pid),
      input.target,
      input.opener ?? "/usr/bin/open",
      input.volume ?? "",
      input.hdiutil ?? "/usr/bin/hdiutil",
      ...relaunchEnvironmentArgs(input.env),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

// ---------------------------------------------------------------------------
// The step

export interface SelfInstallPrompt {
  readonly title: string;
  readonly detail: string;
  readonly buttons: ReadonlyArray<string>;
  readonly cancelId: number;
}

export interface SelfInstallHost {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly uid: number;
  readonly pid: number;
  readonly workDir: string;
  readonly locale: SelfInstallLocale;
  readonly inApplicationsFolder: () => boolean;
  /** Shows a native alert and resolves the index of the button pressed. */
  readonly ask: (prompt: SelfInstallPrompt) => Promise<number>;
  readonly open: (path: string) => void;
  readonly log: (message: string, data?: Record<string, unknown>) => void;
  readonly tools: SelfInstallTools;
  readonly writable?: (path: string) => boolean;
  readonly runningExecutables?: () => Promise<ReadonlyArray<string>>;
  readonly mountTable?: () => Promise<string>;
  readonly diskImages?: () => Promise<string>;
  readonly relaunch?: typeof startDetachedRelaunch;
  readonly reregister?: typeof reregisterLaunchAgents;
}

export type SelfInstallOutcome =
  /** Start the app as usual. */
  | { readonly kind: "continue"; readonly reason: string }
  /** Another copy takes over; this process must exit now. */
  | { readonly kind: "exit"; readonly reason: string };

/** Executable paths of this user's processes; another user's copy is theirs to run. */
export function parseOwnProcesses(psOutput: string, uid: number): string[] {
  const paths: string[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match && Number(match[1]) === uid) paths.push(match[2]!);
  }
  return paths;
}

function runningExecutables(uid: number): Promise<string[]> {
  return run("/bin/ps", ["-axo", "uid=,comm="], 15_000)
    .then((stdout) => parseOwnProcesses(stdout, uid))
    .catch(() => []);
}

async function scanCopies(input: {
  readonly names: ReadonlyArray<string>;
  readonly dirs: ReadonlyArray<string>;
  readonly identity: (bundle: string) => Promise<BundleIdentity>;
  readonly processes: ReadonlyArray<string>;
  readonly writable: (path: string) => boolean;
}): Promise<InstalledCopy[]> {
  const copies: InstalledCopy[] = [];
  for (const dir of input.dirs) {
    for (const name of input.names) {
      const path = BundlePath.join(dir, name);
      if (!exists(path)) continue;
      const identity = await input
        .identity(path)
        .catch((): BundleIdentity => ({ bundleId: null, version: null }));
      copies.push({
        path,
        identity,
        running: input.processes.some((line) => line.startsWith(`${path}/`)),
        removable: input.writable(dir),
      });
    }
  }
  return copies;
}

/**
 * Runs the step. Resolves "exit" when the app was installed (or another copy
 * opened) and this copy must quit; "continue" otherwise, including after
 * "Not now" and after a failed install.
 */
export async function runMacSelfInstall(host: SelfInstallHost): Promise<SelfInstallOutcome> {
  const detection = detectSelfInstall({
    platform: host.platform,
    isPackaged: host.isPackaged,
    execPath: host.execPath,
    env: host.env,
    inApplicationsFolder: host.platform === "darwin" && host.inApplicationsFolder(),
  });
  if (detection.kind === "skip") return { kind: "continue", reason: detection.reason };

  const copy = selfInstallCopy(host.locale);
  const writable = host.writable ?? isWritable;
  const own = await host.tools.identity(detection.bundle);
  const destination = chooseDestination({ homeDir: host.homeDir, writable });
  const target = BundlePath.join(destination.dir, detection.bundleName);
  const otherDir = destination.userFolder
    ? SYSTEM_APPLICATIONS
    : BundlePath.join(host.homeDir, "Applications");
  const folder = folderLabel(host.locale, destination.userFolder);
  const fill = (text: string, values: Record<string, string> = {}) =>
    fillCopy(text, { folder, ...values });
  // A copy found may sit in the other Applications folder.
  const folderOf = (path: string) => ({
    folder: folderLabel(host.locale, BundlePath.dirname(path) !== SYSTEM_APPLICATIONS),
  });
  host.log("self-install offered", {
    bundle: detection.bundle,
    location: detection.location,
    target,
  });

  const decide = async () => {
    const processes = await (host.runningExecutables ?? (() => runningExecutables(host.uid)))();
    const copies = await scanCopies({
      names: candidateBundleNames(detection.bundleName),
      dirs: [destination.dir, otherDir],
      identity: host.tools.identity,
      processes,
      writable,
    });
    return decideSelfInstall({ own, target, copies });
  };

  for (;;) {
    const decision = await decide();
    switch (decision.kind) {
      case "blocked": {
        await host.ask({
          title: copy.blockedTitle,
          detail: fill(copy.blockedDetail, folderOf(decision.path)),
          buttons: [copy.ok],
          cancelId: 0,
        });
        host.log("self-install blocked", { path: decision.path });
        return { kind: "continue", reason: "blocked" };
      }
      case "open-installed":
      case "switch-to-running": {
        const running = decision.kind === "switch-to-running";
        const where = folderOf(decision.path);
        const choice = await host.ask({
          title: running ? copy.runningTitle : copy.installedTitle,
          detail: running
            ? fill(copy.runningDetail, where)
            : fill(copy.installedDetail, { version: decision.version, ...where }),
          buttons: [running ? copy.switchToIt : copy.openIt, copy.notNow],
          cancelId: 1,
        });
        if (choice !== 0) return { kind: "continue", reason: "not-now" };
        host.open(decision.path);
        host.log("self-install opened the installed copy", { path: decision.path });
        return { kind: "exit", reason: decision.kind };
      }
      case "quit-older-first": {
        const choice = await host.ask({
          title: copy.quitOlderTitle,
          detail: fill(copy.quitOlderDetail, folderOf(decision.path)),
          buttons: [copy.install, copy.notNow],
          cancelId: 1,
        });
        if (choice !== 0) return { kind: "continue", reason: "not-now" };
        continue;
      }
      case "install": {
        const detail = [
          fill(copy.offerDetail),
          ...(decision.replace !== null ? [fill(copy.replaceDetail)] : []),
          ...(destination.userFolder ? [copy.userFolderDetail] : []),
        ].join("\n\n");
        const choice = await host.ask({
          title: copy.offerTitle,
          detail,
          buttons: [copy.install, copy.notNow],
          cancelId: 1,
        });
        if (choice !== 0) return { kind: "continue", reason: "not-now" };
        // Something may have changed while the dialog was open.
        const now = await decide();
        if (
          now.kind !== "install" ||
          now.replace !== decision.replace ||
          now.trash.join("\n") !== decision.trash.join("\n")
        ) {
          continue;
        }
        return install(host, detection, own, now, copy, fill);
      }
    }
  }
}

async function install(
  host: SelfInstallHost,
  detection: Extract<SelfInstallDetection, { kind: "offer" }>,
  own: BundleIdentity,
  decision: Extract<SelfInstallDecision, { kind: "install" }>,
  copy: ReturnType<typeof selfInstallCopy>,
  fill: (text: string, values?: Record<string, string>) => string,
): Promise<SelfInstallOutcome> {
  let volume: string | null = null;
  const oldPaths = [detection.bundle];
  let result: { readonly trashed: ReadonlyArray<string> };
  try {
    if (detection.location === "translocated") {
      const source = translocationSource(
        detection.bundle,
        parseMountTable(await (host.mountTable ?? (() => run("/sbin/mount", [])))()),
      );
      if (source !== null) {
        oldPaths.push(BundlePath.join(source, BundlePath.basename(detection.bundle)));
        volume = volumeOf(source);
      }
    } else {
      volume = volumeOf(detection.bundle);
    }
    if (volume !== null) {
      const images = await (host.diskImages ?? (() => run("/usr/bin/hdiutil", ["info"])))().catch(
        () => "",
      );
      if (!isDiskImageMount(images, volume)) volume = null;
    }

    const processes = host.runningExecutables ?? (() => runningExecutables(host.uid));
    result = await installBundle({
      source: detection.bundle,
      target: decision.target,
      own,
      trash: decision.trash,
      tools: host.tools,
      isRunning: async (bundle) =>
        (await processes()).some((line) => line.startsWith(`${bundle}/`)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.log("self-install failed", { error: message });
    await host.ask({
      title: copy.failedTitle,
      detail: fill(copy.failedDetail, { error: message }),
      buttons: [copy.ok],
      cancelId: 0,
    });
    return { kind: "continue", reason: "failed" };
  }

  // The app is installed. What follows is best effort: none of it may keep
  // this copy running from the disk image.
  const warnings: string[] = [];
  const attempt = async (step: string, action: () => unknown) => {
    try {
      return await action();
    } catch (error) {
      warnings.push(`${step}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  // Everything that names the disk image copy now names the installed one,
  // before the disk image goes away.
  for (const old of oldPaths) await attempt("lsregister", () => host.tools.lsregister(["-u", old]));
  await attempt("lsregister", () => host.tools.lsregister(["-f", decision.target]));
  const agents = (await attempt("launch agents", () =>
    (host.reregister ?? reregisterLaunchAgents)({
      homeDir: host.homeDir,
      uid: host.uid,
      from: oldPaths,
      to: decision.target,
    }),
  )) as ReregisterResult | undefined;
  const relaunched = await attempt("relaunch", () => {
    (host.relaunch ?? startDetachedRelaunch)({
      scriptPath: NodePath.join(host.workDir, "self-install-relaunch.sh"),
      pid: host.pid,
      target: decision.target,
      volume,
      env: host.env,
    });
    return true;
  });
  // Without the script, open the installed copy now; the disk image stays.
  if (relaunched !== true) await attempt("open", () => host.open(decision.target));
  host.log("self-install installed", {
    target: decision.target,
    replaced: decision.replace,
    trashed: result.trashed,
    launchAgentsRewritten: agents?.rewritten ?? [],
    launchAgentsReloaded: agents?.reloaded ?? [],
    ejects: volume,
    warnings,
  });
  return { kind: "exit", reason: "installed" };
}
