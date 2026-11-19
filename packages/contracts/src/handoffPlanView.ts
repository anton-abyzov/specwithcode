/**
 * The Hand off dialog's plan (1390 AC-17, AC-22): what the source would hand
 * to one machine, read on the source and checked with that machine. Nothing is
 * held, copied or sent to answer it.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId } from "./baseSchemas.ts";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const percent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

/** The most rows one plan lists. */
export const HANDOFF_PLAN_MAX_ITEMS = 500;

export const HandoffPlanReadInput = Schema.Struct({
  destinationEnvironmentId: EnvironmentId,
  /** The project scope; null lists every project on this machine. */
  projectId: Schema.NullOr(ProjectId),
  /**
   * Weigh what each row would send. Without it every row stays "Not measured
   * yet" and only the machine's usage lines are meant to be read.
   */
  measure: Schema.Boolean,
});
export type HandoffPlanReadInput = typeof HandoffPlanReadInput.Type;

/** One provider the moving threads would use there, as that machine confirmed it. */
export const HandoffPlanUsage = Schema.Struct({
  providerName: text(120),
  kind: Schema.Literals(["different-account", "same-account", "usage-unknown"]),
  percentLeft: Schema.NullOr(percent),
});
export type HandoffPlanUsage = typeof HandoffPlanUsage.Type;

export const HandoffPlanGroupName = Schema.Literals([
  "running",
  "queued",
  "waiting",
  "unsaved",
  "folder-work",
  "stays",
]);
export type HandoffPlanGroupName = typeof HandoffPlanGroupName.Type;

export const HandoffPlanRow = Schema.Struct({
  kind: Schema.Literals(["thread", "folder-work"]),
  /** The thread, or the project whose folder work this is. */
  id: text(256),
  title: text(500),
  projectId: ProjectId,
  group: HandoffPlanGroupName,
  ticked: Schema.Boolean,
  canTick: Schema.Boolean,
  disposition: Schema.Literals(["resume", "ready", "stays"]),
  /** Why it stays: question, approval, sign-in, review, limit, broken-folder and the rest. */
  stay: Schema.NullOr(text(32)),
  /** Why it stays or cannot be ticked, or what the row carries. */
  reason: Schema.NullOr(text(1000)),
});
export type HandoffPlanRow = typeof HandoffPlanRow.Type;

export const HandoffPlanView = Schema.Struct({
  destinationEnvironmentId: EnvironmentId,
  destinationLabel: text(120),
  sourceLabel: text(120),
  /** Why the machine could not be asked; then `usage` is empty and says nothing. */
  unreachable: Schema.NullOr(text(500)),
  usage: Schema.Array(HandoffPlanUsage).check(Schema.isMaxLength(16)),
  items: Schema.Array(HandoffPlanRow).check(Schema.isMaxLength(HANDOFF_PLAN_MAX_ITEMS)),
});
export type HandoffPlanView = typeof HandoffPlanView.Type;
