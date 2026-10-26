/**
 * Whether a pid a file recorded still names the process that wrote it.
 *
 * A pid alone is not enough: after a crash or a reboot another process can
 * take it, and a check that only signals the pid would then refuse forever.
 * Each record also says when its process wrote it (`startedAt`), so a process
 * that started after that moment is someone else.
 *
 * @module processIdentity
 */
import * as Effect from "effect/Effect";

import { isProcessAlive } from "../serverRuntimeState.ts";

/** `ps -o lstart` has one-second resolution. */
const START_SLACK_MS = 2_000;
const PS_TIMEOUT_MS = 2_000;

/** When `pid` started (epoch ms), or null where `ps` cannot tell. */
export const processStartedAtMs = (pid: number): Effect.Effect<number | null> =>
  Effect.tryPromise(async () => {
    const { execFile } = await import("node:child_process");
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        "ps",
        ["-o", "lstart=", "-p", String(pid)],
        { timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C", LANG: "C" } },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    const startedAt = Date.parse(output.trim());
    return Number.isFinite(startedAt) ? startedAt : null;
  }).pipe(Effect.orElseSucceed(() => null));

export type RecordedProcess = "running" | "stale" | "gone";

/**
 * `gone` when no process has the pid, `stale` when the process with that pid
 * started after the record was written (so it did not write it), and
 * `running` otherwise. Where the start time cannot be read (no `ps` on
 * Windows, a BusyBox `ps`, a timeout) or the record has no readable time, the
 * answer is `unknownStart`: `running` (the default) for checks that would
 * otherwise rewrite under a live process, `stale` for checks whose refusal
 * would only keep SpecWithCode from starting.
 */
export const recordedProcess = (
  pid: number,
  recordedAt: string | null | undefined,
  unknownStart: "running" | "stale" = "running",
): Effect.Effect<RecordedProcess> =>
  Effect.gen(function* () {
    if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return "gone";
    const recordedAtMs = typeof recordedAt === "string" ? Date.parse(recordedAt) : Number.NaN;
    if (!Number.isFinite(recordedAtMs)) return unknownStart;
    const startedAtMs = yield* processStartedAtMs(pid);
    if (startedAtMs === null) return unknownStart;
    return startedAtMs > recordedAtMs + START_SLACK_MS ? "stale" : "running";
  });
