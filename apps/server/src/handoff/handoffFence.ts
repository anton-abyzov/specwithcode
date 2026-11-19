/**
 * The last step of a handoff on the source: once the destination has taken a
 * thread over, the copy here is fenced, linked to its continuation and marked
 * as running elsewhere. Split from HandoffMoves, which builds it once.
 */
import {
  CommandId,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  appendThreadExecutionHistory,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { HandoffFollowShape } from "./handoffFollow.ts";
import { fenceRecord, type HandoffThreadRecord } from "./handoffState.ts";
import type { TakeoverReason, TakeoverResponse } from "./handoffWire.ts";

export interface FenceSourceDependencies {
  readonly self: EnvironmentId;
  readonly selfLabel: string;
  readonly nowIso: Effect.Effect<string>;
  readonly projections: Pick<
    ProjectionStore.ProjectionStoreV2Shape,
    "getThreadShell" | "getThread"
  >;
  readonly orchestrator: Pick<Orchestrator.OrchestratorV2["Service"], "dispatch">;
  readonly follow: HandoffFollowShape;
  readonly updateRecord: (
    threadId: ThreadId,
    change: (record: HandoffThreadRecord) => HandoffThreadRecord,
  ) => Effect.Effect<unknown, unknown>;
}

/** Records on the source thread that it continues elsewhere: fenced, read-only, linked. */
export const makeFenceSource =
  ({
    self,
    selfLabel,
    nowIso,
    projections,
    orchestrator,
    follow,
    updateRecord,
  }: FenceSourceDependencies) =>
  (
    shell: OrchestrationV2ThreadShell,
    destination: EnvironmentId,
    response: TakeoverResponse,
    epoch: number,
    reason: TakeoverReason,
  ) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* follow.confirm({ shell, destination, epoch, continuation: response });
      yield* updateRecord(shell.id, (record) => ({
        ...fenceRecord(
          record,
          {
            environmentId: destination,
            machineLabel: response.machineLabel,
            threadId: response.threadId,
            at: now,
          },
          reason === "sleep" ? "sleep" : "handoff",
        ),
        lease:
          record.lease === null
            ? null
            : { ...record.lease, epoch, state: "fenced", renewedAt: now },
        lastError: null,
        pendingTakeover: null,
      })).pipe(Effect.ignore);
      // The destination runs the thread now. A turn still running here (an interrupt
      // that did not land, or one that outlived the wait) is stopped again.
      const latest = yield* projections
        .getThreadShell(shell.id)
        .pipe(Effect.orElseSucceed(() => null));
      if (latest !== null && latest.activeRunId !== null) {
        yield* orchestrator
          .dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(`handoff-fenced-interrupt:${latest.activeRunId}:${epoch}`),
            threadId: shell.id,
            runId: latest.activeRunId,
            reason: `This thread continues on ${response.machineLabel}.`,
            cause: "agent",
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Handoff could not interrupt the fenced copy's turn", { cause }),
            ),
          );
      }
      yield* orchestrator
        .dispatch({
          type: "thread.project-move.record",
          commandId: CommandId.make(`handoff-source:${shell.id}:${epoch}`),
          threadId: shell.id,
          side: "source",
          link: {
            threadId: response.threadId,
            projectId: response.projectId ?? shell.projectId,
            title: shell.title,
            movedAt: now,
            kind: "handoff",
            ...(destination === self
              ? {}
              : { environmentId: destination, machineLabel: response.machineLabel }),
          },
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Handoff could not link the source thread", { cause }),
          ),
        );
      const thread = yield* projections.getThread(shell.id).pipe(Effect.option);
      const previous = Option.isSome(thread) ? (thread.value.execution ?? null) : null;
      yield* orchestrator
        .dispatch({
          type: "thread.execution.record",
          commandId: CommandId.make(`handoff-source-execution:${shell.id}:${epoch}`),
          threadId: shell.id,
          execution: {
            ownerMachineId: previous?.ownerMachineId ?? self,
            ownerMachineLabel: previous?.ownerMachineLabel ?? selfLabel,
            executionMachineId: destination,
            executionMachineLabel: response.machineLabel,
            epoch,
            sourceRoot: previous?.sourceRoot ?? null,
            history: appendThreadExecutionHistory(previous?.history ?? [], {
              machine: destination,
              machineLabel: response.machineLabel,
              from: now,
              to: null,
              reason,
              epoch,
            }),
          },
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Handoff could not record the source's execution", { cause }),
          ),
        );
    });
