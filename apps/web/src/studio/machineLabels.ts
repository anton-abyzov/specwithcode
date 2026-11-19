/**
 * Words that say which machine the window is on, which machine's coordinator it shows and
 * which machine a message or thread belongs to (1427). Each machine runs its own coordinator,
 * and a window may show another machine's: nothing here says "this machine".
 * Kept free of UI imports so components, fixtures and tests share one rule.
 *
 * @module machineLabels
 */
import type { ThreadExecutionSummary } from "@specweave-studio/contracts";

import { modelLabel, type ProviderNameSource } from "./shellModel";
import { threadLocation } from "./threadLocation";

/** Every phrase below, once; each is in all eight phrase catalogs (`i18n.test.ts`). */
export const MACHINE_LABEL_PHRASES = {
  window: "Window on {machine}",
  tag: "{machine}'s coordinator",
  tip: "Showing {machine}'s coordinator. This window runs on {window}.",
  thisWindow: "this window",
  reply: "Coordinator on {machine} · {model}",
  user: "To {machine}'s coordinator",
  restart: "Restart {machine} to update",
  update: "Update {machine} now",
  retry: "Retry update on {machine}",
  notConnected: "{machine} is not connected. Changes can be made once it reconnects.",
  filterWindow: "{machine} · this window",
} as const;

/** An English phrase and its `{slot}` values, translated where it is shown. */
export interface MachineWords {
  readonly text: string;
  readonly values?: Readonly<Record<string, string>>;
}

/** The sidebar header: the machine this window is served by. */
export function windowMachineWords(machine: string): MachineWords {
  return { text: MACHINE_LABEL_PHRASES.window, values: { machine } };
}

/** The header tag while the window shows another machine's coordinator. */
export function coordinatorTagWords(input: { readonly shown: string; readonly window: string }) {
  return {
    tag: { text: MACHINE_LABEL_PHRASES.tag, values: { machine: input.shown } },
    window: windowMachineWords(input.window),
    tip: {
      text: MACHINE_LABEL_PHRASES.tip,
      values: { machine: input.shown, window: input.window },
    },
  } satisfies Record<string, MachineWords>;
}

const RESTART_LABELS: Readonly<Record<string, string>> = {
  "Update now": MACHINE_LABEL_PHRASES.update,
  "Restart to update": MACHINE_LABEL_PHRASES.restart,
  "Retry update": MACHINE_LABEL_PHRASES.retry,
};

/** The sidebar's restart and update button, naming the machine it acts on. */
export function restartButtonLabel(label: string, machine: string | null): MachineWords {
  const named = machine ? RESTART_LABELS[label] : undefined;
  return named ? { text: named, values: { machine: machine! } } : { text: label };
}

/**
 * The label under a coordinator message: "Coordinator on M4 · Claude Code · Opus 5.5" for a
 * reply, "To M4's coordinator" for what the user sent it. The model is the run's, never
 * today's picker.
 */
export function coordinatorExecutionLabel(
  message: { readonly role: string; readonly createdBy?: string; readonly runId?: string | null },
  runs: readonly { id: string; modelSelection?: { instanceId: string; model: string } }[],
  machine: string,
  entries?: ReadonlyMap<string, ProviderNameSource>,
): MachineWords {
  if (message.role !== "assistant") return { text: MACHINE_LABEL_PHRASES.user, values: { machine } };
  const run = message.runId ? runs.find((candidate) => candidate.id === message.runId) : undefined;
  const selection = run?.modelSelection;
  const model = selection
    ? modelLabel(entries?.get(selection.instanceId) ?? null, selection.instanceId, selection.model)
        .full
    : "Model not recorded";
  return { text: MACHINE_LABEL_PHRASES.reply, values: { machine, model } };
}

/**
 * The machine a chip or note adds after a thread's title, " · M5": only when the thread
 * lives or runs on another machine than the coordinator's. "M4 → M5" once it was handed off.
 */
export function threadMachineSuffix(
  thread: {
    readonly environmentId: string;
    readonly ownerMachineId?: string;
    readonly executionMachineId?: string;
    readonly executionMachineLabel?: string;
  },
  coordinatorEnvironmentId: string | null | undefined,
  name: (environmentId: string, fallbackLabel?: string | null) => string,
): string | null {
  if (!coordinatorEnvironmentId) return null;
  const location = threadLocation({
    summary: thread as ThreadExecutionSummary,
    servingEnvironmentId: thread.environmentId,
    name,
  });
  return location.ownerMachineId === coordinatorEnvironmentId &&
    location.executionMachineId === coordinatorEnvironmentId
    ? null
    : location.label;
}
