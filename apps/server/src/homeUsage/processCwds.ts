// @effect-diagnostics nodeBuiltinImport:off - reads /proc and runs lsof directly; no Effect service covers either.
/**
 * Working directories of this user's running processes, so retention never
 * removes a folder a shell, build or agent outside the app is still in.
 * macOS uses `lsof -d cwd` (`-F` output is a stable line-prefixed format),
 * Linux reads `/proc/<pid>/cwd`. Null when they cannot be read (Windows, no
 * lsof, a timeout): callers then remove nothing.
 *
 * @module homeUsage/processCwds
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

const LSOF_TIMEOUT_MS = 30_000;
const LSOF_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** `n<path>` lines of `lsof -F n` output, deduplicated. */
export function parseLsofCwds(stdout: string): ReadonlyArray<string> {
  const cwds = new Set<string>();
  for (const line of stdout.split("\n"))
    if (line.startsWith("n/") || /^n[A-Za-z]:[\\/]/.test(line)) cwds.add(line.slice(1));
  return [...cwds];
}

const lsofCwds = (uid: number, command: string) =>
  Effect.callback<ReadonlyArray<string> | null>((resume) => {
    const child = NodeChildProcess.execFile(
      command,
      ["-n", "-P", "-w", "-a", "-d", "cwd", "-u", String(uid), "-F", "n"],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: LSOF_MAX_OUTPUT_BYTES, encoding: "utf8" },
      (error, stdout) => {
        // Any failure, a non-zero exit included, may mean a process's folder was
        // left out, so the list is unknown and retention removes nothing this run.
        if (error !== null) {
          resume(Effect.succeed(null));
          return;
        }
        resume(Effect.succeed(parseLsofCwds(stdout)));
      },
    );
    return Effect.sync(() => {
      child.kill();
    });
  });

const procCwds = (procRoot: string) =>
  Effect.sync((): ReadonlyArray<string> | null => {
    let names: Array<string>;
    try {
      names = NodeFS.readdirSync(procRoot);
    } catch {
      return null;
    }
    const cwds = new Set<string>();
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        cwds.add(NodeFS.readlinkSync(NodePath.join(procRoot, name, "cwd")));
      } catch {
        // Another user's process, or one that exited: not ours to keep.
      }
    }
    return [...cwds];
  });

export const listProcessCwds = (
  platform: NodeJS.Platform,
  options: {
    readonly procRoot?: string;
    readonly uid?: number;
    /** The lsof to run (tests). */
    readonly lsofCommand?: string;
  } = {},
): Effect.Effect<ReadonlyArray<string> | null> => {
  if (platform === "linux") return procCwds(options.procRoot ?? "/proc");
  const uid = options.uid ?? process.getuid?.();
  if (platform === "darwin" && uid !== undefined)
    return lsofCwds(uid, options.lsofCommand ?? "lsof");
  return Effect.succeed(null);
};
