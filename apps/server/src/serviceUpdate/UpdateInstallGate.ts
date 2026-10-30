import * as DateTime from "effect/DateTime";
/**
 * The install gate: a file the update helper keeps while it restarts and verifies the service.
 *
 * `scripts/studio-fleet/update.py` writes `<baseDir>/updates/install-gate.json` just before it
 * restarts the service, and removes it once the new release is verified or rolled back. Until
 * then its readiness and rollback checks need an idle service: no runs, no effects, no working
 * sessions and no child processes. The in-memory hold (`ServiceUpdateHold`) ends with the
 * restart, so the new process reads this file instead and keeps every automatic starter and
 * every new message back while it is live.
 *
 * A gate can never hold the service for long: it ends when its helper exits (a helper killed by
 * the update agent's time limit, a signal or a reboot removes nothing), when it was written
 * before the machine last started, and in any case `INSTALL_GATE_MAX_MS` after it was written.
 * A gate seen ended stays ended: the reader remembers it and removes the file, so a process that
 * later reuses the helper's pid cannot close it again.
 *
 * @module UpdateInstallGate
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no uptime; the boot time dates stale gates.
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

/** File name under `<baseDir>/updates`; `update.py` INSTALL_GATE_FILE. */
export const INSTALL_GATE_FILE = "install-gate.json";
/**
 * The longest a gate lasts, from when it was written, even while its helper runs: the most
 * time the update agent may give the helper (`update.py` APPLY_BUDGET_SECONDS, at most an
 * hour). A helper that exits ends it at once. `update.py` INSTALL_GATE_MAX_SECONDS.
 */
export const INSTALL_GATE_MAX_MS = 60 * 60_000;
/** A gate dated further ahead than this is read by its file time instead. */
const FUTURE_SKEW_MS = 60_000;

export interface InstallGateMarker {
  /** `at`: when the helper wrote the gate; null when missing or unreadable. */
  readonly atMs: number | null;
  /** `helperPid`: the helper process; null when missing. */
  readonly helperPid: number | null;
}

const UNREADABLE: InstallGateMarker = { atMs: null, helperPid: null };

/** Reads the gate file. A file the helper is still writing, or a broken one, still counts. */
export function parseInstallGate(text: string): InstallGateMarker {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return UNREADABLE;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return UNREADABLE;
  const record = value as Record<string, unknown>;
  const at = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
  const pid = record.helperPid;
  return {
    atMs: Number.isFinite(at) ? at : null,
    helperPid: typeof pid === "number" && Number.isInteger(pid) && pid > 1 ? pid : null,
  };
}

/**
 * File name under `<baseDir>/updates`; `update_service.py` INSTALL_GATE_ACK_FILE. A held service
 * writes it once it has read a gate the helper wrote and every command it admitted before has
 * ended, so no commit of one is under way: the helper's last row checks then need not wait out a
 * fixed settle. The helper removes it with the gate.
 */
export const INSTALL_GATE_ACK_FILE = "install-gate-ack.json";

/**
 * The acknowledgement of the gate with this text, by the service `servicePid` at `at`, or null
 * for a gate without its helper's `at` and pid: the helper then waits out the settle.
 */
export function installGateAck(text: string, servicePid: number, at: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== "string" || parseInstallGate(text).helperPid === null) return null;
  return JSON.stringify({
    schemaVersion: 1,
    servicePid,
    helperPid: record.helperPid,
    gateAt: record.at,
    at,
  });
}

/**
 * Whether the helper a gate names still runs. The helper always runs as the service's own user,
 * so a pid this process may not signal (EPERM) belongs to someone else: a root daemon that took
 * the pid after a reboot. Unlike `isProcessAlive`, that counts as exited.
 */
export function isHelperRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** When the machine last started (epoch ms); a gate written before then is stale. */
export const machineBootMs = (): number =>
  DateTime.toEpochMillis(DateTime.nowUnsafe()) - NodeOS.uptime() * 1_000;

/**
 * Until when (epoch ms) a gate keeps the service quiet, or null when it no longer does: its
 * helper exited, it was written before the machine last started (`bootMs`, null when unknown),
 * or it is older than `INSTALL_GATE_MAX_MS`. Without a readable time the file's modification
 * time counts.
 */
export function installGateUntil(input: {
  readonly marker: InstallGateMarker;
  readonly mtimeMs: number | null;
  readonly nowMs: number;
  readonly bootMs: number | null;
  readonly isAlive: (pid: number) => boolean;
}): number | null {
  const { marker, mtimeMs, nowMs, bootMs } = input;
  if (marker.helperPid !== null && !input.isAlive(marker.helperPid)) return null;
  const notAhead = (value: number | null) =>
    value !== null && value <= nowMs + FUTURE_SKEW_MS ? value : null;
  const atMs = notAhead(marker.atMs) ?? notAhead(mtimeMs);
  if (atMs === null) return null;
  // No helper outlives a restart of the machine, whatever process holds its pid now.
  if (bootMs !== null && atMs < bootMs) return null;
  const untilMs = atMs + INSTALL_GATE_MAX_MS;
  return untilMs > nowMs ? untilMs : null;
}

/**
 * A reader of the gate at `gatePath`. Each `read` says until when the gate is live, or null when
 * it is absent or ended. A gate it found ended is remembered by its content and removed, so it
 * stays ended even when another process later takes the helper's pid. A gate written afresh
 * (another install) has other content and is read on its own merits.
 */
export const makeInstallGateReader = (input: {
  readonly gatePath: string;
  readonly bootMs: number | null;
  readonly isAlive: (pid: number) => boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const ended = yield* Ref.make<string | null>(null);
    const readText = fs.readFileString(input.gatePath).pipe(Effect.option);
    const read: Effect.Effect<number | null> = Effect.gen(function* () {
      const text = yield* readText;
      if (Option.isNone(text)) return null;
      if (text.value === (yield* Ref.get(ended))) return null;
      const mtimeMs = yield* fs.stat(input.gatePath).pipe(
        Effect.map((info) => Option.getOrNull(Option.map(info.mtime, (date) => date.getTime()))),
        Effect.orElseSucceed(() => null),
      );
      const untilMs = installGateUntil({
        marker: parseInstallGate(text.value),
        mtimeMs,
        nowMs: yield* Clock.currentTimeMillis,
        bootMs: input.bootMs,
        isAlive: input.isAlive,
      });
      if (untilMs !== null) return untilMs;
      yield* Ref.set(ended, text.value);
      // Only the gate judged here: one a new install wrote meanwhile stays.
      const again = yield* readText;
      if (Option.isSome(again) && again.value === text.value) {
        yield* fs.remove(input.gatePath).pipe(Effect.ignore);
        yield* Effect.logInfo("service-update.gate.removed-ended");
      }
      return null;
    });
    return { read };
  });
