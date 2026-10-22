import type {
  ServiceUpdateBlocker,
  StudioServiceUpdateRun,
  StudioServiceUpdateRunAction,
  StudioServiceUpdateRunResult,
} from "@specweave-studio/contracts";

import {
  CallTimeout,
  callPrepare,
  QUICK_CALL_MS,
  STOP_WORK_TIMEOUT_MS,
  withTimeout,
} from "./serviceUpdateCalls";
import { describeServiceUpdateRun } from "./serviceUpdateRunView";
import { hiddenToastActionProps, stackedThreadToast, toastManager } from "./ui/toast";

/**
 * "Update now" as one durable run (0988). The press asks the desktop to
 * `begin` the run, which makes exactly one per Mac; it then stops and holds
 * the service's work and names the run in its install request. From there
 * the desktop and the agent own the run: every window, a reload and a
 * relaunched app only follow it. A desktop or agent without run support
 * answers `legacy`, and the window updates the way it did before runs.
 */

/** How long the install request may take before the run is left to the agent. */
const INSTALL_REQUEST_MS = 30_000;
/** A run that ended longer ago than this is not reported to a window opening now. */
const REPORT_WINDOW_MS = 30 * 60_000;
const REPORTED_KEY = "specwithcode.serviceUpdateRun.reported";

export type ServiceUpdateRunStart = "legacy" | "following" | "started";

/** Why the run ended when its install request failed, for every window that follows it. */
export function installRequestFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : "";
  return detail
    ? `The install request could not be made: ${detail}`
    : "The install request could not be made.";
}

async function askRun(
  action: StudioServiceUpdateRunAction,
): Promise<StudioServiceUpdateRunResult | null> {
  const ask = window.desktopBridge?.serviceUpdateRun;
  if (!ask) return null;
  try {
    return await withTimeout(ask(action), QUICK_CALL_MS);
  } catch {
    return null;
  }
}

/**
 * Begins a run for `targetVersion` (and the app's `appTargetVersion` after
 * it), or follows the one going on. "legacy" when this desktop or its agent
 * has no runs. Throws when the install request failed; the run then ends as
 * failed with that reason, since nobody claimed it.
 */
export async function startServiceUpdateRun(input: {
  readonly targetVersion: string | null;
  readonly appTargetVersion: string | null;
}): Promise<ServiceUpdateRunStart> {
  const bridge = window.desktopBridge;
  if (!bridge?.serviceUpdateRun || !bridge.installServiceUpdate || input.targetVersion === null) {
    return "legacy";
  }
  const begun = await askRun({
    type: "begin",
    targetVersion: input.targetVersion,
    appTargetVersion: input.appTargetVersion,
  });
  if (begun === null || !begun.supported || begun.run === null) return "legacy";
  if (!begun.created) return "following";
  const run = begun.run;
  // Stop and hold the work, as before runs; the agent then installs on a quiet service.
  await callPrepare({ stopWork: true, hold: true, reason: "install" }, STOP_WORK_TIMEOUT_MS);
  try {
    await withTimeout(
      bridge.installServiceUpdate({
        force: true,
        holdUntil: run.deadlineAt,
        version: run.targetVersion,
        runId: run.runId,
      }),
      INSTALL_REQUEST_MS,
    );
  } catch (error) {
    // A slow desktop still writes the request; the run follows what it does.
    if (error instanceof CallTimeout) return "started";
    // The update failed, nobody cancelled it: the run ends as failed, with why.
    // A run main had already ended is left as it ended (a cancel of it does nothing).
    await askRun({ type: "cancel", runId: run.runId, reason: installRequestFailure(error) });
    // Nothing will install, so the work held for it is let go now, not at the
    // hold's 15-minute expiry, as a failed update before runs did.
    await callPrepare({ stopWork: false, releaseHold: true }, QUICK_CALL_MS);
    throw error;
  }
  return "started";
}

/** "Restart now" for a run whose app half failed. */
export function retryServiceUpdateRunApp(run: StudioServiceUpdateRun): Promise<unknown> {
  return askRun({ type: "retry-app", runId: run.runId });
}

function reportedRunId(): string | null {
  try {
    return window.localStorage.getItem(REPORTED_KEY);
  } catch {
    return null;
  }
}

/**
 * Whether this window shows the outcome of `run`: once per run on this
 * computer (every window shares the record), and only for a run that ended
 * recently or that this window followed.
 */
export function shouldReportRun(run: StudioServiceUpdateRun, seenLive: boolean, nowMs: number) {
  if (!run.terminal || reportedRunId() === run.runId) return false;
  if (seenLive) return true;
  const ended = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
  return Number.isFinite(ended) && nowMs - ended < REPORT_WINDOW_MS;
}

/** Records that the outcome of `run` was shown, here and for the desktop's app record. */
export function acknowledgeRun(run: StudioServiceUpdateRun): void {
  try {
    window.localStorage.setItem(REPORTED_KEY, run.runId);
  } catch {
    // A window without storage may show it again after a reload.
  }
  void askRun({ type: "acknowledge", runId: run.runId });
}

let toastId: ReturnType<typeof toastManager.add> | null = null;
let toastRunId: string | null = null;
let closedRunId: string | null = null;
const seenLive = new Set<string>();

/**
 * Keeps the one toast that follows the run in step with it. Live, it shows
 * the step, the elapsed and expected time, the threads whose questions it
 * waits on, and in amber when nothing moved for 2 minutes; never a button.
 * Terminal, it reports the outcome once, with Try again or Restart now.
 */
export function syncServiceUpdateRunToast(
  run: StudioServiceUpdateRun | null,
  blockers: ReadonlyArray<ServiceUpdateBlocker>,
  actions: { readonly retry: () => void; readonly restartApp: () => void },
  nowMs = Date.now(),
): void {
  if (run === null || (run.terminal && !shouldReportRun(run, seenLive.has(run.runId), nowMs))) {
    if (toastId !== null && (run === null || toastRunId !== run.runId || !run.terminal)) {
      toastManager.close(toastId);
      toastId = null;
      toastRunId = null;
    }
    return;
  }
  if (!run.terminal) seenLive.add(run.runId);
  if (closedRunId === run.runId && !run.terminal) return;
  const view = describeServiceUpdateRun(run, nowMs, blockers);
  const options = stackedThreadToast({
    type: view.tone === "info" ? "info" : view.warning !== null ? "warning" : view.tone,
    title: view.title,
    description: [...view.lines, view.warning].filter(Boolean).join("\n"),
    timeout: run.terminal ? 15_000 : 0,
    priority: view.tone === "error" || view.warning !== null ? "high" : "low",
    actionProps:
      view.action === null
        ? hiddenToastActionProps
        : {
            children: view.action.label,
            onClick: view.action.kind === "retry" ? actions.retry : actions.restartApp,
          },
    data: {
      hideCopyButton: view.tone !== "error",
      onClose: () => {
        closedRunId = run.runId;
        toastId = null;
        toastRunId = null;
      },
    },
  });
  if (toastId === null || toastRunId !== run.runId) {
    if (toastId !== null) toastManager.close(toastId);
    toastId = toastManager.add(options);
    toastRunId = run.runId;
  } else toastManager.update(toastId, options);
  if (run.terminal) acknowledgeRun(run);
}

export function resetServiceUpdateRunFlowForTests(): void {
  toastId = null;
  toastRunId = null;
  closedRunId = null;
  seenLive.clear();
  try {
    window.localStorage.removeItem(REPORTED_KEY);
  } catch {
    // Nothing stored.
  }
}
