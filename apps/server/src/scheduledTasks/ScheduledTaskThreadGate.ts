/**
 * A worker's routine runs on this machine only where a turn on its thread
 * could start (1390 AC-45). The scheduler asks before it admits a run, and
 * again right before the run's check starts and its prompt is sent.
 */
import { type ScheduledTask, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { type HandoffTurnGateShape, routineThreadPlace } from "../handoff/HandoffTurnGate.ts";
import type { RoutineCoordinatorHold } from "./ScheduledTaskCoordinatorGate.ts";
import { isCoordinatorOwnedRoutine } from "./ScheduledTaskCopies.ts";
import { threadHandedOffNote } from "./ScheduledTaskRunnerRecords.ts";

/**
 * Null when the routine may run here; a rest when its thread was handed off
 * to a named machine; otherwise a wait. A coordinator's routine, or one with
 * no thread, is not held here.
 */
export const routineThreadHold = (
  gate: HandoffTurnGateShape,
  task: Pick<ScheduledTask, "ownThread"> & { readonly threadId?: string | null | undefined },
): Effect.Effect<RoutineCoordinatorHold | null> =>
  isCoordinatorOwnedRoutine(task) || task.threadId == null
    ? Effect.succeed(null)
    : routineThreadPlace(gate, ThreadId.make(task.threadId)).pipe(
        Effect.map((place): RoutineCoordinatorHold | null =>
          place.kind === "here"
            ? null
            : place.kind === "moved"
              ? { kind: "rest", note: threadHandedOffNote(place.machineLabel) }
              : { kind: "wait", reason: place.reason },
        ),
      );
