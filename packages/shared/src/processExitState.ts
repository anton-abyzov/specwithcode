// @effect-diagnostics nodeBuiltinImport:off -- Synchronous pid checks run outside Effect (CLI preflight, the desktop attach loop) and need spawnSync and /proc.
/**
 * Whether a pid that still answers signal 0 is a process on its way out.
 *
 * `kill(pid, 0)` succeeds for a zombie and for a process that is exiting. On
 * macOS a process whose thread is stuck in the kernel (an FSKit read, a hung
 * network volume) stays exiting (`ps` shows `?E`) until the machine restarts:
 * it serves nothing, yet a pid check alone reports it running and refuses
 * every restart. Callers that decide "a server is already running" from a pid
 * ask this after signal 0 succeeds.
 *
 * @module processExitState
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

/** The process state for `pid` (`ps` STAT column or `/proc` state letter), or null where it cannot be read. */
export type ProcessStateReader = (pid: number) => string | null;

const PS_TIMEOUT_MS = 2_000;

/**
 * Z (zombie) or E (macOS and BSD: trying to exit) anywhere in the state, or X
 * (Linux: dead) as its first letter. macOS uses a trailing X for "traced", so
 * X only counts as the state letter itself. Leading spaces and modifiers such
 * as `+`, `s` or `<` do not matter.
 */
export const isExitingProcessState = (state: string): boolean => {
  const trimmed = state.trim();
  return /[EZ]/.test(trimmed) || /^[Xx]/.test(trimmed);
};

/** The state letter from `/proc/<pid>/stat`; the command name may hold spaces and parentheses. */
const readProcStatState = (pid: number): string | null => {
  try {
    const stat = NodeFS.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const state = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/, 1)[0];
    return state !== undefined && state.length > 0 ? state : null;
  } catch {
    return null;
  }
};

const readPsState = (pid: number): string | null => {
  try {
    const result = NodeChildProcess.spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    if (result.error || result.status !== 0) return null;
    const state = result.stdout.trim();
    return state.length > 0 ? state : null;
  } catch {
    // A spawn that throws (no `ps`, a stubbed child_process) leaves the old answer.
    return null;
  }
};

/**
 * Reads the state without a child process on Linux (`/proc`), with one short
 * `ps` elsewhere. Null on Windows and wherever the state cannot be read, so
 * callers keep their old answer. Only call it after signal 0 succeeded: the
 * `ps` spawn is synchronous, which is fine for startup and once-a-second
 * checks but not for a hot loop.
 */
export const readProcessState: ProcessStateReader = (pid) => {
  // oxlint-disable-next-line studio/no-global-process-runtime -- A synchronous pid check with no Effect runtime; it reads the host it runs on.
  const platform = process.platform;
  if (platform === "win32") return null;
  if (platform === "linux") {
    const state = readProcStatState(pid);
    if (state !== null) return state;
  }
  return readPsState(pid);
};

/** True when the state for `pid` says it is exiting or a zombie; false when it runs or cannot be read. */
export const isProcessExiting = (
  pid: number,
  readState: ProcessStateReader = readProcessState,
): boolean => {
  const state = readState(pid);
  return state !== null && isExitingProcessState(state);
};
