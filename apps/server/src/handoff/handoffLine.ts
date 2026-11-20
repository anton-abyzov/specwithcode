/**
 * The line an automatic hand off leaves in the thread on both machines (1390
 * AC-28): "Handed off to M5 at 14:02: Claude usage limit on m4". Each machine
 * writes the time in its own zone. The source keeps it on its link to the
 * continuation, the destination on the continuation's link back; both show it
 * in the thread's banner.
 *
 * @module handoffLine
 */
import {
  CommandId,
  type EnvironmentId,
  type HandoffTransferTrigger,
  type OrchestrationV2ThreadProjectMoveLink,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

/** A move link's note holds this many characters. */
const LINE_MAX = 300;

const clip = (text: string) =>
  text.length <= LINE_MAX ? text : `${text.slice(0, LINE_MAX - 1).trimEnd()}…`;

/** "14:02" on this machine's clock, or in `timeZone`. */
function clockAt(atMs: number, timeZone: DateTime.TimeZone): string {
  return DateTime.formatIsoZoned(DateTime.setZone(DateTime.makeUnsafe(atMs), timeZone)).slice(
    11,
    16,
  );
}

/** "Handed off to M5 at 14:02: Claude usage limit on m4". */
export function handoffLine(input: {
  readonly machineLabel: string;
  readonly atMs: number;
  readonly reason: string;
  readonly timeZone?: DateTime.TimeZone;
}): string {
  const at = clockAt(input.atMs, input.timeZone ?? DateTime.zoneMakeLocal());
  return clip(`Handed off to ${input.machineLabel} at ${at}: ${input.reason}`);
}

/**
 * The continuation's link back to the thread it came from, with the line, for
 * an automatic move that says why. A move someone asked for gets none: they
 * saw it happen.
 */
export function arrivalLink(input: {
  readonly trigger: Pick<HandoffTransferTrigger, "kind" | "reason"> | null | undefined;
  readonly sourceThreadId: ThreadId | string;
  readonly sourceProjectId: ProjectId | string;
  readonly title: string;
  readonly sourceEnvironmentId: EnvironmentId | string;
  readonly sourceLabel: string;
  /** This machine. */
  readonly machineLabel: string;
  readonly atMs: number;
  readonly timeZone?: DateTime.TimeZone;
}): OrchestrationV2ThreadProjectMoveLink | null {
  const reason = input.trigger?.kind === "automatic" ? input.trigger.reason?.trim() : undefined;
  if (reason === undefined || reason === "") return null;
  return {
    threadId: input.sourceThreadId as ThreadId,
    projectId: input.sourceProjectId as ProjectId,
    title: input.title.trim() === "" ? "Handed off thread" : input.title.trim().slice(0, 500),
    movedAt: DateTime.formatIso(DateTime.makeUnsafe(input.atMs)),
    kind: "handoff",
    environmentId: input.sourceEnvironmentId as EnvironmentId,
    machineLabel: input.sourceLabel,
    note: handoffLine({
      machineLabel: input.machineLabel,
      atMs: input.atMs,
      reason,
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    }),
  };
}

/**
 * Records the line on the continuation `threadId` once it launched, from what
 * the takeover said; a failure is logged and never fails the move.
 */
export const recordArrivalLine = (
  orchestrator: Pick<Orchestrator.OrchestratorV2["Service"], "dispatch">,
  threadId: ThreadId,
  takeover: {
    readonly request: {
      readonly trigger?: Pick<HandoffTransferTrigger, "kind" | "reason"> | null | undefined;
      readonly sourceThreadId: ThreadId;
    };
    readonly sourceEnvironmentId: EnvironmentId;
    readonly sourceProjectId: ProjectId;
    readonly replica: { readonly title: string; readonly sourceLabel: string };
    readonly machineLabel: string;
  },
) =>
  Effect.gen(function* () {
    const link = arrivalLink({
      trigger: takeover.request.trigger,
      sourceThreadId: takeover.request.sourceThreadId,
      sourceProjectId: takeover.sourceProjectId,
      title: takeover.replica.title,
      sourceEnvironmentId: takeover.sourceEnvironmentId,
      sourceLabel: takeover.replica.sourceLabel,
      machineLabel: takeover.machineLabel,
      atMs: DateTime.toEpochMillis(yield* DateTime.now),
    });
    if (link === null) return;
    yield* orchestrator
      .dispatch({
        type: "thread.project-move.record",
        commandId: CommandId.make(`handoff-arrival:${threadId}:${link.threadId}`),
        threadId,
        side: "target",
        link,
      })
      .pipe(Effect.asVoid);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Handoff could not record why the thread arrived", { cause }),
    ),
  );
