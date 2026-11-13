// @effect-diagnostics nodeBuiltinImport:off - lists processes and reads launcher files directly; no Effect service covers either.
/**
 * Removes old app versions from `<baseDir>/runtime/versions`. Every update
 * unpacks a full release there (about 440 MB) and nothing removed the old
 * ones, so a machine that took a hundred updates carried 48 GB of them.
 *
 * Kept: the active version, one rollback (the version the last committed
 * update came from, or else the newest one below the active), every version
 * newer than the active (an install waiting for its switch), and any version a
 * running process, a CLI launcher or the boot service still names. Nothing is
 * removed while an update is pending, or when the process list cannot be read.
 * A version is first renamed out of the way, so a locked file (Windows) leaves
 * it whole, then deleted.
 *
 * @module cloud/runtimeVersionRetention
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { STUDIO_CLI_NAMES } from "../cli/cliName.ts";
import {
  compareExactServiceVersions,
  isExactServiceVersion,
  parseServiceState,
  SERVICE_STATE_FILE,
  type ServiceUpdateRecord,
} from "./serviceProtocol.ts";

const STAGING_PREFIX = ".staging-";
const TRASH_PREFIX = ".trash-";
/** An install's staging folder younger than this may still be in use. */
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;
const PROCESS_LIST_TIMEOUT_MS = 20_000;
const LAUNCHER_READ_LIMIT = 256 * 1024;

export interface RuntimeVersionEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly mtimeMs: number;
}

export interface RuntimeVersionPrunePlan {
  /** Exact versions removed. */
  readonly remove: ReadonlyArray<string>;
  /** Abandoned staging and trash folders removed. */
  readonly leftovers: ReadonlyArray<string>;
  readonly keep: ReadonlyArray<string>;
}

/** The version a rollback would return to. */
export function rollbackVersionOf(input: {
  readonly versions: ReadonlyArray<string>;
  readonly activeVersion: string;
  readonly update: ServiceUpdateRecord | undefined;
}): string | undefined {
  const { update, activeVersion, versions } = input;
  if (
    update?.status === "committed" &&
    update.targetVersion === activeVersion &&
    versions.includes(update.fromVersion)
  ) {
    return update.fromVersion;
  }
  return versions
    .filter((version) => compareExactServiceVersions(version, activeVersion) < 0)
    .toSorted(compareExactServiceVersions)
    .at(-1);
}

/** Which folders go. Pure, so every rule is tested without a disk. */
export function planRuntimeVersionPrune(input: {
  readonly entries: ReadonlyArray<RuntimeVersionEntry>;
  readonly activeVersion: string;
  readonly update: ServiceUpdateRecord | undefined;
  /** Versions something on the machine still names. */
  readonly referenced: ReadonlySet<string>;
  readonly nowMs: number;
}): RuntimeVersionPrunePlan {
  if (input.update?.status === "pending" || !isExactServiceVersion(input.activeVersion)) {
    return { remove: [], leftovers: [], keep: input.entries.map((entry) => entry.name) };
  }
  const versions = input.entries
    .filter((entry) => entry.isDirectory && isExactServiceVersion(entry.name))
    .map((entry) => entry.name);
  const rollback = rollbackVersionOf({
    versions,
    activeVersion: input.activeVersion,
    update: input.update,
  });
  const keep: Array<string> = [];
  const remove: Array<string> = [];
  for (const version of versions) {
    const kept =
      version === input.activeVersion ||
      version === rollback ||
      compareExactServiceVersions(version, input.activeVersion) > 0 ||
      input.referenced.has(version);
    (kept ? keep : remove).push(version);
  }
  const leftovers = input.entries
    .filter(
      (entry) =>
        entry.name.startsWith(TRASH_PREFIX) ||
        (entry.name.startsWith(STAGING_PREFIX) && input.nowMs - entry.mtimeMs > STALE_STAGING_MS),
    )
    .map((entry) => entry.name);
  return {
    remove: remove.toSorted(compareExactServiceVersions),
    leftovers,
    keep: keep.toSorted(compareExactServiceVersions),
  };
}

/** Every `versions/<name>` a text names, under any home: keeping too much is the safe side. */
export function versionsNamedIn(texts: ReadonlyArray<string>): ReadonlySet<string> {
  const named = new Set<string>();
  const pattern = /versions[\\/]([^\\/\s"'<>&;:]+)/g;
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined && isExactServiceVersion(name)) named.add(name);
    }
  }
  return named;
}

const execText = (command: string, args: ReadonlyArray<string>) =>
  new Promise<string | null>((resolve) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      {
        timeout: PROCESS_LIST_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout) => resolve(error === null ? stdout : null),
    );
  });

/** Command lines and executables of running processes, or null when unknown. */
export async function listProcessCommandLines(
  platform: NodeJS.Platform,
  procRoot = "/proc",
): Promise<ReadonlyArray<string> | null> {
  if (platform === "linux") {
    let names: Array<string>;
    try {
      names = await NodeFSP.readdir(procRoot);
    } catch {
      return null;
    }
    const lines: Array<string> = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const cmdline = await NodeFSP.readFile(
        NodePath.join(procRoot, name, "cmdline"),
        "utf8",
      ).catch(() => "");
      const exe = await NodeFSP.readlink(NodePath.join(procRoot, name, "exe")).catch(() => "");
      lines.push(`${exe} ${cmdline.replaceAll("\0", " ")}`);
    }
    return lines;
  }
  if (platform === "win32") {
    const stdout = await execText("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ExecutablePath) $($_.CommandLine)" }',
    ]);
    return stdout === null ? null : stdout.split(/\r?\n/);
  }
  const stdout = await execText("ps", ["-axww", "-o", "command="]);
  return stdout === null ? null : stdout.split("\n");
}

/** CLI launchers and boot service files that may name a version. */
export function launcherAndServiceFiles(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly pathEnv: string;
}): ReadonlyArray<string> {
  const files = new Set<string>();
  const delimiter = input.platform === "win32" ? ";" : ":";
  for (const name of STUDIO_CLI_NAMES) {
    for (const directory of input.pathEnv.split(delimiter)) {
      if (directory.length === 0) continue;
      files.add(NodePath.join(directory, name));
      if (input.platform === "win32") files.add(NodePath.join(directory, `${name}.cmd`));
    }
    files.add(NodePath.join(input.homeDir, ".local", "bin", name));
  }
  files.add(NodePath.join(input.homeDir, ".config", "systemd", "user", "studio.service"));
  files.add(
    NodePath.join(input.homeDir, "Library", "LaunchAgents", "com.specweave.studio.service.plist"),
  );
  const windowsDir = NodePath.join(input.homeDir, "AppData", "Local", "SpecWithCode");
  files.add(NodePath.join(windowsDir, "studio-service.xml"));
  files.add(NodePath.join(windowsDir, "studio-service.cmd"));
  return [...files];
}

async function readSmallText(file: string): Promise<string> {
  try {
    const handle = await NodeFSP.open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return "";
      const buffer = Buffer.alloc(Math.min(stat.size, LAUNCHER_READ_LIMIT));
      await handle.read(buffer, 0, buffer.length, 0);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function folderBytes(folder: string): Promise<number> {
  let total = 0;
  const stack = [folder];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await NodeFSP.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = NodePath.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += (await NodeFSP.lstat(full).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

async function readEntries(versionsDir: string): Promise<Array<RuntimeVersionEntry> | null> {
  let dirents: Array<NodeFS.Dirent>;
  try {
    dirents = await NodeFSP.readdir(versionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  return Promise.all(
    dirents.map(async (dirent) => ({
      name: dirent.name,
      isDirectory: dirent.isDirectory(),
      mtimeMs:
        (await NodeFSP.lstat(NodePath.join(versionsDir, dirent.name)).catch(() => null))?.mtimeMs ??
        0,
    })),
  );
}

async function readState(baseDir: string) {
  const text = await NodeFSP.readFile(
    NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE),
    "utf8",
  ).catch(() => null);
  return text === null ? undefined : parseServiceState(text);
}

export interface RuntimeVersionPruneResult {
  readonly removed: ReadonlyArray<{ readonly version: string; readonly bytes: number }>;
  readonly kept: ReadonlyArray<string>;
  /** Why nothing was considered, when nothing was. */
  readonly skipped?:
    | "no-service-state"
    | "update-pending"
    | "no-versions-folder"
    | "process-list-unavailable";
  readonly failed: ReadonlyArray<string>;
}

export interface RuntimeVersionPruneInput {
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly pathEnv: string;
  readonly nowMs: number;
  /** Tests replace the process list. */
  readonly processCommandLines?: () => Promise<ReadonlyArray<string> | null>;
}

/** Removes old app versions now. Never throws: what it could not remove is in `failed`. */
export async function pruneRuntimeVersions(
  input: RuntimeVersionPruneInput,
): Promise<RuntimeVersionPruneResult> {
  const platform = input.platform;
  const versionsDir = NodePath.join(input.baseDir, "runtime", "versions");
  const state = await readState(input.baseDir);
  if (state === undefined)
    return { removed: [], kept: [], failed: [], skipped: "no-service-state" };
  if (state.update?.status === "pending")
    return { removed: [], kept: [], failed: [], skipped: "update-pending" };
  const entries = await readEntries(versionsDir);
  if (entries === null) return { removed: [], kept: [], failed: [], skipped: "no-versions-folder" };
  const processes = await (
    input.processCommandLines ?? (() => listProcessCommandLines(platform))
  )();
  if (processes === null)
    return { removed: [], kept: [], failed: [], skipped: "process-list-unavailable" };
  const files = launcherAndServiceFiles({
    platform,
    homeDir: input.homeDir,
    pathEnv: input.pathEnv,
  });
  const fileTexts = await Promise.all(files.map(readSmallText));
  const plan = planRuntimeVersionPrune({
    entries,
    activeVersion: state.activeVersion,
    update: state.update,
    referenced: versionsNamedIn([...processes, ...fileTexts]),
    nowMs: input.nowMs,
  });

  const removed: Array<{ version: string; bytes: number }> = [];
  const failed: Array<string> = [];
  for (const version of plan.remove) {
    // The state may have moved on while the process list was read.
    const current = await readState(input.baseDir);
    if (
      current === undefined ||
      current.update?.status === "pending" ||
      current.activeVersion === version
    ) {
      failed.push(version);
      continue;
    }
    const folder = NodePath.join(versionsDir, version);
    const bytes = await folderBytes(folder);
    const trash = NodePath.join(
      versionsDir,
      `${TRASH_PREFIX}${version}-${NodeCrypto.randomUUID()}`,
    );
    try {
      // A file in use (Windows) fails the rename and leaves the version whole.
      await NodeFSP.rename(folder, trash);
    } catch {
      failed.push(version);
      continue;
    }
    await NodeFSP.rm(trash, { recursive: true, force: true }).catch(() => undefined);
    removed.push({ version, bytes });
  }
  for (const leftover of plan.leftovers) {
    await NodeFSP.rm(NodePath.join(versionsDir, leftover), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
  return { removed, kept: plan.keep, failed };
}

/** Old version folders as Storage shows them: the same rules, without the process list. */
export function oldRuntimeVersionDirsSync(baseDir: string): ReadonlyArray<string> {
  const versionsDir = NodePath.join(baseDir, "runtime", "versions");
  try {
    const state = parseServiceState(
      NodeFS.readFileSync(NodePath.join(baseDir, "runtime", SERVICE_STATE_FILE), "utf8"),
    );
    if (state === undefined) return [];
    const entries = NodeFS.readdirSync(versionsDir, { withFileTypes: true }).map((dirent) => ({
      name: dirent.name,
      isDirectory: dirent.isDirectory(),
      mtimeMs: 0,
    }));
    return planRuntimeVersionPrune({
      entries,
      activeVersion: state.activeVersion,
      update: state.update,
      referenced: new Set(),
      nowMs: 0,
    }).remove.map((version) => NodePath.join(versionsDir, version));
  } catch {
    return [];
  }
}

/** The prune as an effect that logs what it removed and never fails. */
export const pruneRuntimeVersionsLogged = (input: {
  readonly baseDir: string;
  readonly reason: string;
}) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const environment = yield* HostProcessEnvironment;
    const nowMs = yield* Clock.currentTimeMillis;
    return yield* Effect.promise(() =>
      pruneRuntimeVersions({
        baseDir: input.baseDir,
        platform,
        homeDir: environment["HOME"] ?? environment["USERPROFILE"] ?? NodeOS.homedir(),
        pathEnv: environment["PATH"] ?? environment["Path"] ?? "",
        nowMs,
      }),
    );
  }).pipe(
    Effect.tap((result) =>
      result.removed.length === 0 && result.failed.length === 0
        ? Effect.logDebug("old app versions: nothing to remove", {
            reason: input.reason,
            skipped: result.skipped,
          })
        : Effect.logInfo("old app versions removed", {
            reason: input.reason,
            removed: result.removed.map((entry) => entry.version),
            bytes: result.removed.reduce((sum, entry) => sum + entry.bytes, 0),
            kept: result.kept,
            failed: result.failed,
          }),
    ),
  );
