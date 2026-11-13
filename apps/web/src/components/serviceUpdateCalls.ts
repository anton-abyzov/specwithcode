import type {
  ServiceUpdateBlocker,
  ServerPrepareServiceUpdateInput,
  ServerPrepareServiceUpdateResult,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import { ClockIcon, HourglassIcon, RotateCwIcon } from "lucide-react";
import { createElement, type ReactNode } from "react";

import { requestChoiceDialog } from "../confirmDialog";
import { ensureLocalApi } from "../localApi";
import { markRestartStep } from "./restartTrace";
import {
  APP_RESTART_UNKNOWN,
  describeAppRestartWarning,
  describeServiceUpdateStop,
  interruptedWork,
} from "./sidebar/SidebarRestartToUpdate.logic";
import { describeListedRestart, WAIT_UNTIL_QUIET } from "./sidebar/restartRunningWork.logic";

/** What the person chose before a restart or update that would cut off work. */
export type RestartWorkChoice = "wait" | "now" | "later";

/** Renders the live list of what a restart cuts off, under the dialog's question. */
export type RenderRestartWork = (
  working: ReadonlyArray<ServiceUpdateBlocker>,
  all: ReadonlyArray<ServiceUpdateBlocker>,
) => ReactNode;

const buttonIcon = (icon: typeof ClockIcon) => createElement(icon, { "aria-hidden": true });

/**
 * The one question every restart and update asks before it cuts off work:
 * Wait until quiet (the default, the button Enter picks), Restart now, or
 * Later. Without `canWait` it offers Restart now and Later. Undefined when no
 * themed dialog host is mounted.
 */
export function askRestartForWork(
  question: string,
  options: {
    readonly details?: ReactNode;
    readonly canWait: boolean;
    /** The label of the button that goes ahead now. */
    readonly nowLabel?: string;
  },
): Promise<RestartWorkChoice> | undefined {
  const nowLabel = options.nowLabel ?? "Restart now";
  const details = options.details === undefined ? {} : { details: options.details };
  const choice = options.canWait
    ? requestChoiceDialog(question, {
        confirmLabel: WAIT_UNTIL_QUIET,
        confirmIcon: buttonIcon(HourglassIcon),
        alternateLabel: nowLabel,
        alternateIcon: buttonIcon(RotateCwIcon),
        alternateVariant: "destructive-outline",
        cancelLabel: "Later",
        cancelIcon: buttonIcon(ClockIcon),
        ...details,
      })
    : requestChoiceDialog(question, {
        variant: "destructive",
        confirmLabel: nowLabel,
        confirmIcon: buttonIcon(RotateCwIcon),
        cancelLabel: "Later",
        cancelIcon: buttonIcon(ClockIcon),
        ...details,
      });
  return choice?.then((picked) =>
    picked === "cancel"
      ? "later"
      : options.canWait
        ? picked === "confirm"
          ? "wait"
          : "now"
        : "now",
  );
}

/**
 * The calls "Update now" and an app restart make to the service (through the
 * newest mounted component's way to reach it) and to the desktop, each one
 * bounded in time, and the questions an app restart asks before it stops work.
 */

export type PrepareServiceUpdate = (
  input: ServerPrepareServiceUpdateInput,
) => Promise<ServerPrepareServiceUpdateResult | null>;

/** Reads and checks answer within this, or count as no answer. */
export const QUICK_CALL_MS = 5_000;
/** Stopping work can take a while on a busy service; the install proceeds after this. */
export const STOP_WORK_TIMEOUT_MS = 90_000;

export class CallTimeout extends Error {
  constructor() {
    super("The call did not answer in time.");
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new CallTimeout()), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// The newest mounted component's way to reach the server.
const prepares: PrepareServiceUpdate[] = [];

export function registerPrepare(prepare: PrepareServiceUpdate): () => void {
  prepares.push(prepare);
  return () => {
    const index = prepares.lastIndexOf(prepare);
    if (index >= 0) prepares.splice(index, 1);
  };
}

export function forgetPreparesForTests(): void {
  prepares.length = 0;
}

export async function callPrepare(
  input: ServerPrepareServiceUpdateInput,
  timeoutMs: number,
  prepare: PrepareServiceUpdate | undefined = prepares.at(-1),
): Promise<ServerPrepareServiceUpdateResult | null> {
  if (!prepare) return null;
  // An older service without this call, one already restarting, or one too busy
  // to answer still installs: the update agent checks for itself before it does.
  const checked = await withTimeout(prepare(input), timeoutMs).catch(() => null);
  if (checked !== null && !input.stopWork && input.releaseHold !== true) {
    for (const listener of [...lookListeners]) listener(checked.blockers);
  }
  return checked;
}

// Whoever wants what the last look found (0991): the sidebar's automatic
// install wait reuses the window's own looks instead of asking again.
const lookListeners = new Set<(blockers: ReadonlyArray<ServiceUpdateBlocker>) => void>();

/** Hears the blockers of every look (a prepare that stops nothing). */
export function onServiceUpdateLook(
  listener: (blockers: ReadonlyArray<ServiceUpdateBlocker>) => void,
): () => void {
  lookListeners.add(listener);
  return () => void lookListeners.delete(listener);
}

export async function readAgentState(): Promise<StudioServiceUpdateState | null> {
  const read = window.desktopBridge?.getServiceUpdateState;
  if (!read) return null;
  return withTimeout(read(), QUICK_CALL_MS).catch(() => null);
}

// A withdrawal still being written; a new install request waits for it.
let withdrawal: Promise<unknown> | null = null;

/** The withdrawal still being written, if any: a new install request waits for it. */
export function pendingWithdrawal(): Promise<unknown> | null {
  return withdrawal;
}

export function forgetWithdrawalForTests(): void {
  withdrawal = null;
}

/**
 * Withdraws the install request. `withdrawn` is false when the desktop could
 * not save that (or offers no way to), so the agent may still install.
 * `agent` is the agent's state after the withdrawal, when it could be read.
 */
export async function withdrawRequest(): Promise<{
  readonly withdrawn: boolean;
  readonly agent: StudioServiceUpdateState | null;
}> {
  const cancel = window.desktopBridge?.cancelServiceUpdate;
  if (!cancel) return { withdrawn: false, agent: await readAgentState() };
  const pending = withTimeout(cancel(), QUICK_CALL_MS);
  const settled = pending.catch(() => null);
  withdrawal = settled;
  void settled.then(() => {
    if (withdrawal === settled) withdrawal = null;
  });
  try {
    return { withdrawn: true, agent: await pending };
  } catch {
    return { withdrawn: false, agent: await readAgentState() };
  }
}

/**
 * Asks before an app restart installs an update while work runs. Resolves true
 * when the restart may go ahead: nothing runs, or the user chose to restart
 * anyway. Nothing runs and no question is asked when the service says so, or
 * when its threads only wait on a person: their questions are asked again.
 */
export async function confirmAppRestartForUpdate(
  options: {
    readonly version?: string | null;
    /** The running work as the dialog shows it, under the question. */
    readonly renderDetails?: RenderRestartWork;
  } = {},
): Promise<AppRestartChoice> {
  const lookAt = Date.now();
  const checked = await callPrepare({ stopWork: false }, QUICK_CALL_MS);
  // Only copies run, or threads that only wait on a person: no work to list.
  const working = checked === null ? [] : interruptedWork(checked.blockers);
  const listed = working.length > 0 && options.renderDetails !== undefined;
  const warning =
    checked === null
      ? APP_RESTART_UNKNOWN
      : describeAppRestartWarning(checked, { version: options.version ?? null, listed });
  markRestartStep("quick-look", {
    startedAt: lookAt,
    detail: warning === null ? "nothing runs" : "asks before the restart",
  });
  if (warning === null) return "now";
  // The listed question is one title and one line: the list says the rest.
  const question =
    listed && checked !== null
      ? describeListedRestart({
          title: `Restart to install SpecWithCode ${options.version ?? "the update"}?`,
          continues: working.every((blocker) => blocker.continuesAfterRestart === true),
          folderCopies: checked.folderCopies ?? 0,
        })
      : warning;
  const choice = askRestartForWork(question, {
    canWait: true,
    ...(listed && checked !== null
      ? { details: options.renderDetails!(working, checked.blockers) }
      : {}),
  });
  if (choice === undefined) {
    const text =
      checked === null ? warning : (describeAppRestartWarning(checked, options) ?? warning);
    return (await ensureLocalApi().dialogs.confirm(text, { variant: "destructive" }))
      ? "now"
      : "cancel";
  }
  const picked = await choice;
  return picked === "wait" ? "idle" : picked === "now" ? "now" : "cancel";
}

/**
 * What runs now, for an open restart dialog's live list: the blockers a
 * restart would cut off, or null when the service did not answer in time.
 */
export async function readInterruptedWork(): Promise<ReadonlyArray<ServiceUpdateBlocker> | null> {
  const checked = await callPrepare({ stopWork: false }, QUICK_CALL_MS);
  return checked === null ? null : interruptedWork(checked.blockers);
}

/** What the user chose before an update restart: now, once idle, or not at all. */
export type AppRestartChoice = "now" | "idle" | "cancel";

/**
 * Whether work still runs on the service: false when idle, null when the
 * service cannot say.
 */
export async function isServiceWorkRunning(): Promise<boolean | null> {
  const checked = await callPrepare({ stopWork: false }, QUICK_CALL_MS);
  if (checked === null) return null;
  return describeAppRestartWarning(checked) !== null;
}

/**
 * Whether a service update would still stop something (running work, open
 * terminals or a folder copy): false when nothing, null when the service cannot say.
 */
export async function isServiceUpdateStopNeeded(): Promise<boolean | null> {
  const checked = await callPrepare({ stopWork: false }, QUICK_CALL_MS);
  if (checked === null) return null;
  return describeServiceUpdateStop(checked) !== null;
}

/**
 * Before an app restart that takes the bundled service down with it: stops
 * running work for the update, as "Update now" does, and holds the service so
 * nothing new starts. Runs stopped this way carry the update as their cause,
 * so they continue after the restart instead of ending as cancelled. Resolves
 * true when the service answered.
 */
export async function drainWorkForAppRestart(): Promise<boolean> {
  // A short hold: should the service outlive the restart, it lets work start again soon.
  const prepareAt = Date.now();
  const prepared = await callPrepare(
    { stopWork: true, hold: true, reason: "app-restart" },
    STOP_WORK_TIMEOUT_MS,
  );
  markRestartStep("prepare", {
    startedAt: prepareAt,
    detail: prepared === null ? "no answer" : "drained for the app restart",
  });
  return prepared !== null;
}

/** Lets work start again after a drained app restart did not happen. */
export async function releaseAppRestartDrain(): Promise<void> {
  await callPrepare({ stopWork: false, releaseHold: true, reason: "app-restart" }, QUICK_CALL_MS);
}
