// @effect-diagnostics nodeBuiltinImport:off - shares plain async helpers with machineTools.ts.
/**
 * What the machine-tools RPCs and the readiness check after an update share
 * in one server: its PATH, the one install that may run at a time, and how a
 * check reads the machine.
 */
import type { MachineReadinessSweep, MachineReadinessToolId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import { nodeToolDirs } from "../project/nodeToolDirs.ts";
import { probeGit } from "../provider/providerDiscovery.ts";
import { makeNodeProvisionHost, type ProvisionHost } from "../provision/host.ts";
import {
  existingManagedToolDirs,
  installMachineTool,
  runsOnGlibc,
  type InstallLog,
  type InstallOutcome,
  type MachineToolsContext,
  withPathDirs,
} from "./machineTools.ts";

/**
 * Puts the folders the app installed tools into on this server's PATH, after
 * the person's own folders. Agents, terminals and Git spawns inherit it.
 */
export function addToServerPath(dirs: ReadonlyArray<string>): void {
  const env = process.env;
  // oxlint-disable-next-line studio/no-global-process-runtime -- the server's own PATH separator.
  const platform = process.platform;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const next = withPathDirs(env[key], dirs, platform);
  if (next !== undefined) env[key] = next;
}

/** The install running on this machine. It is held until the install itself ends, not its stream. */
let installing: MachineReadinessToolId | null = null;

/** The tool being installed on this machine right now, if any. */
export const installingNow = () => installing;

/**
 * Starts one install, or answers which tool is already being installed. The
 * claim is taken before anything waits, so a second caller sees it, and it
 * and the PATH follow the install to its end even if nobody waits for it.
 */
export function startInstall(
  ctx: MachineToolsContext,
  tool: MachineReadinessToolId,
  git: "present" | "missing" | undefined,
  log: InstallLog,
): { readonly busyWith: MachineReadinessToolId } | { readonly run: Promise<InstallOutcome> } {
  if (installing !== null) return { busyWith: installing };
  installing = tool;
  const release = () => {
    installing = null;
  };
  const run = installMachineTool(ctx, tool, git, log).then((outcome) => {
    addToServerPath(outcome.pathDirs);
    return outcome;
  });
  void run.then(release, release);
  return { run };
}

let pathSeeded = false;

/**
 * Puts the tools the app installed earlier on this server's PATH. Called at
 * server start, so agents resumed before any client connects find them.
 */
export const seedManagedToolPath = (baseDir: string) =>
  Effect.gen(function* () {
    if (pathSeeded) return;
    pathSeeded = true;
    const host = makeNodeProvisionHost();
    const installed = yield* Effect.promise(() =>
      existingManagedToolDirs(host, {
        home: baseDir,
        platform: host.platform,
        arch: host.arch,
        glibc: runsOnGlibc(),
      }).catch(() => [] as ReadonlyArray<string>),
    );
    addToServerPath(installed);
  });

/** This machine as a check sees it now: the live PATH, version managers and Git. */
export const machineToolsContext = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const host = makeNodeProvisionHost();
  const env = process.env;
  const nodeManagerDirs = yield* nodeToolDirs({
    home: NodeOS.homedir(),
    platform: host.platform as NodeJS.Platform,
    execPath: process.execPath,
    fnmDir: env.FNM_DIR,
    nvmDir: env.NVM_DIR,
    voltaHome: env.VOLTA_HOME,
    xdgDataHome: env.XDG_DATA_HOME,
  });
  const git = yield* probeGit(env, host.platform as NodeJS.Platform);
  const ctx: MachineToolsContext = {
    host,
    home: config.baseDir,
    glibc: runsOnGlibc(),
    nodeManagerDirs,
  };
  return { ctx, git };
}).pipe(Effect.withSpan("machineTools.context"));

export type MachineToolsContextServices =
  | ServerConfig.ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

/** Where the readiness check after an update records what it did. */
export const readinessFile = (home: string, platform: string) =>
  (platform === "win32" ? NodePath.win32 : NodePath.posix).join(
    home,
    "provision",
    "readiness.json",
  );

/** The last readiness check's record, or null when there is none or it cannot be read. */
export async function readSweepState(
  host: Pick<ProvisionHost, "readText" | "platform">,
  home: string,
): Promise<MachineReadinessSweep | null> {
  const text = await host.readText(readinessFile(home, host.platform));
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<MachineReadinessSweep>;
    if (
      typeof value.version !== "string" ||
      typeof value.at !== "string" ||
      (value.state !== "waiting" && value.state !== "done" && value.state !== "failed") ||
      !Array.isArray(value.installed)
    )
      return null;
    const tools = new Set(["git", "node", "gh", "specweave"]);
    return {
      version: value.version.slice(0, 64),
      at: value.at.slice(0, 64),
      state: value.state,
      installed: value.installed.filter((tool): tool is MachineReadinessToolId =>
        tools.has(tool as string),
      ),
      detail: typeof value.detail === "string" ? value.detail.slice(0, 2000) : null,
    };
  } catch {
    return null;
  }
}
