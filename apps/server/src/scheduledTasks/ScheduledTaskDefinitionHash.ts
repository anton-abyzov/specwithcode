/**
 * A routine's definition as one value: what a person sees in its form. A
 * change made on a machine that only keeps a copy is sent to the routine's
 * runner with the hash of the definition the change was made on, and the
 * runner makes it only when that is the definition it holds now. A revision
 * count says how often a routine changed; only this says what was seen.
 */
import type { CoordinatorRoutineCopy, ScheduledTask } from "@specweave-studio/contracts";

import { stringifyJson } from "../json.ts";
import { sha256 } from "../nodeCrypto.ts";

type Definition = Pick<
  ScheduledTask | CoordinatorRoutineCopy,
  | "title"
  | "prompt"
  | "enabled"
  | "schedule"
  | "workspaceStrategy"
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
  | "modelPinned"
  | "check"
  | "brief"
>;

/** Keys in one order, and nothing for a value left out: two machines write the same text. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined || entry === null || entry === false) continue;
    out[key] = canonical(entry);
  }
  return out;
};

/** The same for the same definition on any machine, whatever its id, thread, project or run state. */
export const definitionHashOf = (routine: Definition): string =>
  sha256([
    stringifyJson(
      canonical({
        title: routine.title,
        prompt: routine.prompt,
        enabled: routine.enabled,
        schedule: routine.schedule,
        workspaceStrategy: routine.workspaceStrategy,
        modelSelection: routine.modelSelection,
        runtimeMode: routine.runtimeMode,
        interactionMode: routine.interactionMode,
        modelPinned: routine.modelPinned,
        check: routine.check,
        brief: routine.brief,
      }),
    ),
  ]).toString("hex");
