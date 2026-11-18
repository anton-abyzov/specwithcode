// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the probe asks macOS directly, from this process and from a child.
/**
 * Whether agents on this machine may read other apps' data (macOS Full Disk
 * Access), and which item the user must allow for it.
 *
 * macOS charges an agent's file read to the process responsible for it: the
 * app when SpecWithCode.app started this service, otherwise this service's
 * own executable (a launchd job). The probe therefore runs here, in the
 * service, never in the window. It reads folders that only Full Disk Access
 * opens and that every Mac has. The child probe answers for agent runs
 * started from now on; the in-process one for this long-lived service.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { PrivacyAccess, PrivacyAgentHost } from "@specweave-studio/contracts";

/**
 * Folders only Full Disk Access opens; the first that exists decides. The TCC
 * folder leads because no narrower grant (App Data, Files and Folders) opens
 * it, so a partial grant cannot read as Full Disk Access.
 */
export function protectedProbePaths(homeDir: string): ReadonlyArray<string> {
  return [
    NodePath.join(homeDir, "Library", "Application Support", "com.apple.TCC"),
    NodePath.join(homeDir, "Library", "Safari"),
    NodePath.join(homeDir, "Library", "Mail"),
  ];
}

export type ProbeAnswer = "allowed" | "denied" | "missing" | "failed";

const answerForError = (error: unknown): ProbeAnswer => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EPERM" || code === "EACCES") return "denied";
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  return "failed";
};

async function probeInProcess(path: string): Promise<ProbeAnswer> {
  try {
    await NodeFS.readdir(path);
    return "allowed";
  } catch (error) {
    return answerForError(error);
  }
}

/** A fresh child, as an agent run is: `ls` exits 1 with "Operation not permitted". */
function probeInChild(path: string): Promise<ProbeAnswer> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "/bin/ls",
      [path],
      { timeout: 5_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C" } },
      (error, _stdout, stderr) => {
        if (!error) return resolve("allowed");
        const text = String(stderr);
        if (/Operation not permitted|Permission denied/i.test(text)) return resolve("denied");
        if (/No such file or directory/i.test(text)) return resolve("missing");
        resolve("failed");
      },
    );
  });
}

/** The outermost `.app` bundle a path lies in, if any. */
export function outerAppBundle(executable: string): string | null {
  const match = /^(.*?\.app)(?:\/|$)/.exec(executable);
  return match ? match[1]! : null;
}

/**
 * Who macOS holds responsible for this service's children: the first `.app`
 * among this executable and its ancestors (the app started it), else this
 * executable itself (launchd started it).
 */
export function resolveAgentHost(
  execPath: string,
  ancestorExecutables: ReadonlyArray<string>,
): PrivacyAgentHost {
  for (const candidate of [execPath, ...ancestorExecutables]) {
    const bundle = outerAppBundle(candidate);
    if (bundle !== null) {
      return { kind: "app", path: bundle, name: NodePath.basename(bundle, ".app") };
    }
  }
  return { kind: "executable", path: execPath, name: NodePath.basename(execPath) };
}

/** Executables of this process's ancestors, nearest first, up to launchd. */
export function readAncestorExecutables(
  pid: number = process.ppid,
  run: (pid: number) => string | null = psLine,
  limit = 8,
): ReadonlyArray<string> {
  const found: Array<string> = [];
  let current = pid;
  for (let depth = 0; depth < limit && current > 1; depth++) {
    const line = run(current);
    if (line === null) break;
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) break;
    found.push(match[2]!.trim());
    current = Number(match[1]);
  }
  return found;
}

function psLine(pid: number): string | null {
  try {
    return NodeChildProcess.execFileSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    }).trim();
  } catch {
    return null;
  }
}

export interface PrivacyAccessOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly execPath?: string;
  readonly ancestors?: () => ReadonlyArray<string>;
  readonly inProcess?: (path: string) => Promise<ProbeAnswer>;
  readonly inChild?: (path: string) => Promise<ProbeAnswer>;
  readonly now?: () => Date;
}

// The service's ancestry never changes while it runs; walk it once, not every recheck.
let cachedAncestors: ReadonlyArray<string> | null = null;
const serviceAncestors = () => {
  if (cachedAncestors !== null) return cachedAncestors;
  const found = readAncestorExecutables();
  // A walk that found nothing may have failed; ask again next time.
  if (found.length > 0) cachedAncestors = found;
  return found;
};

export async function checkPrivacyAccess(options: PrivacyAccessOptions = {}): Promise<PrivacyAccess> {
  const platform = options.platform ?? process.platform;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  if (platform !== "darwin") {
    return {
      checkedAt,
      fullDiskAccess: "not-applicable",
      agentHost: null,
      runningAgentsNeedRestart: false,
    };
  }
  const agentHost = resolveAgentHost(
    options.execPath ?? process.execPath,
    (options.ancestors ?? serviceAncestors)(),
  );
  const inChild = options.inChild ?? probeInChild;
  const inProcess = options.inProcess ?? probeInProcess;
  for (const path of protectedProbePaths(options.homeDir ?? NodeOS.homedir())) {
    const child = await inChild(path);
    if (child === "missing" || child === "failed") continue;
    const own = child === "allowed" ? await inProcess(path) : child;
    return {
      checkedAt,
      fullDiskAccess: child === "allowed" ? "allowed" : "not-allowed",
      agentHost,
      runningAgentsNeedRestart: child === "allowed" && own === "denied",
    };
  }
  return { checkedAt, fullDiskAccess: "unknown", agentHost, runningAgentsNeedRestart: false };
}
