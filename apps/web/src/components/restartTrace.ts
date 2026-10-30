import type { RestartTracePhase } from "@specweave-studio/contracts";

import { randomUUID } from "../lib/utils";

/**
 * Timing for one "Restart to update" press. The press makes a run id and its
 * `t0`; each step after it (feed check, quick look, begin, prepare, install
 * request) is sent to the desktop, which writes it with its time since the
 * press to desktop.trace.ndjson and marks its own steps for the same press.
 * A desktop without the trace channel drops the marks; nothing waits on them.
 */

export interface RestartPress {
  readonly runId: string;
  readonly t0: number;
}

let current: RestartPress | null = null;

/** The press steps are marked for, or null before the first press. */
export function currentRestartPress(): RestartPress | null {
  return current;
}

/** For tests: forget the press. */
export function resetRestartTrace(): void {
  current = null;
}

/** One step of the current press; `startedAt` times the step itself. */
export function markRestartStep(
  phase: RestartTracePhase,
  options: { readonly startedAt?: number; readonly detail?: string } = {},
): void {
  const press = current;
  if (press === null || typeof window === "undefined") return;
  const send = window.desktopBridge?.markRestartTrace;
  if (!send) return;
  const at = Date.now();
  void send({
    runId: press.runId,
    t0: press.t0,
    phase,
    at,
    ...(options.startedAt === undefined ? {} : { ms: Math.max(0, at - options.startedAt) }),
    ...(options.detail === undefined ? {} : { detail: options.detail.slice(0, 200) }),
  }).catch(() => undefined);
}

/** A press of "Restart to update": the steps marked from now on belong to it. */
export function beginRestartPress(detail?: string): RestartPress {
  current = { runId: randomUUID(), t0: Date.now() };
  markRestartStep("press", detail === undefined ? {} : { detail });
  return current;
}
