import type { DesktopRestartTraceMark, RestartTracePhase } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as DesktopObservability from "../app/DesktopObservability.ts";

/**
 * Timing for one "Restart to update" press. The window makes a run id and
 * `t0` at the press and sends a mark for each of its steps (feed check, quick
 * look, prepare, install request); main marks what it does for that same
 * press (the verified service seen, the app install, staging, quitAndInstall).
 * Every mark is a span with its time since the press in desktop.trace.ndjson,
 * so one press can be timed afterwards by its run id.
 */

const { logInfo } = DesktopObservability.makeComponentLogger("restart-to-update");

/** Main's own steps belong to the latest press only this long after it. */
export const RESTART_TRACE_TTL_MS = 30 * 60_000;

export interface RestartPress {
  readonly runId: string;
  readonly t0: number;
}

// One press at a time in this process: the newest one the window marked.
let currentPress: RestartPress | null = null;

/** The press main's own steps belong to, or null when there is none this recent. */
export function pressAt(nowMs: number): RestartPress | null {
  if (currentPress === null) return null;
  return nowMs - currentPress.t0 <= RESTART_TRACE_TTL_MS ? currentPress : null;
}

/** For tests: forget the press. */
export function resetRestartTrace(): void {
  currentPress = null;
}

/** The annotations a mark is written with. */
export function restartTraceFields(mark: DesktopRestartTraceMark) {
  return {
    runId: mark.runId,
    phase: mark.phase,
    elapsedMs: Math.max(0, Math.round(mark.at - mark.t0)),
    at: Number.isFinite(mark.at) ? DateTime.formatIso(DateTime.makeUnsafe(mark.at)) : null,
    ...(mark.ms === undefined ? {} : { ms: Math.max(0, Math.round(mark.ms)) }),
    ...(mark.detail === undefined ? {} : { detail: mark.detail }),
  };
}

const write = (mark: DesktopRestartTraceMark) => {
  const fields = restartTraceFields(mark);
  return logInfo("restart to update step", fields).pipe(
    Effect.withSpan("desktop.updates.restartStep", {
      attributes: Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [`restart.${key}`, value]),
      ),
    }),
  );
};

/** A mark from the window: it also names the press main's own steps belong to. */
export const recordWindowMark = (mark: DesktopRestartTraceMark) =>
  Effect.suspend(() => {
    if (currentPress === null || currentPress.runId !== mark.runId) {
      currentPress = { runId: mark.runId, t0: mark.t0 };
    }
    return write(mark);
  });

/** One of main's own steps, for the latest press; nothing without a recent press. */
export const markRestartStep = (
  phase: RestartTracePhase,
  options: { readonly ms?: number; readonly detail?: string } = {},
) =>
  Effect.gen(function* () {
    const at = DateTime.toEpochMillis(yield* DateTime.now);
    const press = pressAt(at);
    if (press === null) return;
    yield* write({
      runId: press.runId,
      t0: press.t0,
      phase,
      at,
      ...(options.ms === undefined ? {} : { ms: options.ms }),
      ...(options.detail === undefined ? {} : { detail: options.detail.slice(0, 200) }),
    });
  });

/** Starts a clock now; the returned mark writes `phase` with the time since then. */
export const markRestartStepFromNow = (phase: RestartTracePhase) =>
  Effect.map(
    DateTime.now,
    (start) => (detail: string) =>
      Effect.flatMap(DateTime.now, (now) =>
        markRestartStep(phase, {
          ms: DateTime.toEpochMillis(now) - DateTime.toEpochMillis(start),
          detail,
        }),
      ),
  );
