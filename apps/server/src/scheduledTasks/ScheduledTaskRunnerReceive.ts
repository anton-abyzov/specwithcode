/**
 * What this machine answers when another one asks about a routine's runner
 * (1390 AC-45): `status`, `runner-disarm`, `runner-rearm` and `runner-edit`.
 * The move's own steps are ScheduledTaskTransfer's.
 */
import {
  type ScheduledTaskError,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Semaphore from "effect/Semaphore";

import { accountInGrant, projectInGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { othersRoutineRefusal } from "../mcp/routineOwnership.ts";
import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { routineCopyOf } from "./ScheduledTaskCopies.ts";
import type { RoutineRunnerDeps, RoutineRunnerPeers } from "./ScheduledTaskRunner.ts";
import {
  deleteUnreachedRefusal,
  isRunnerRoutine,
  type RoutineRunnerRecord,
  type RoutineRunnerRecords,
  runsHere,
} from "./ScheduledTaskRunnerRecords.ts";
import {
  refuseTransfer,
  ROUTINE_RUNNER_CAPABILITY,
  type RoutineRunnerRequest,
  type RoutineRunnerResponse,
  type RoutineTransferRefusal,
} from "./ScheduledTaskRunnerWire.ts";

const decodeUpsert = Schema.decodeUnknownOption(ScheduledTaskUpsertInput);

/** A refusal passes through; anything else is this machine failing to read its own state. */
const failOrUnreadable = (
  cause: Cause.Cause<unknown>,
  unreadable: () => RoutineTransferRefusal,
): Effect.Effect<never, RoutineTransferRefusal> => {
  const failure = Cause.squash(cause);
  return Effect.fail(
    typeof failure === "object" &&
      failure !== null &&
      "_tag" in failure &&
      (failure as { _tag: unknown })._tag === "RoutineTransferRefusal"
      ? (failure as RoutineTransferRefusal)
      : unreadable(),
  );
};

/** What the receiving side shares with the runner it answers for. */
export interface RunnerReceiveParts {
  readonly deps: RoutineRunnerDeps;
  readonly records: RoutineRunnerRecords;
  /** The runner's change lock. */
  readonly lock: Semaphore.Semaphore;
  readonly peersRef: Ref.Ref<RoutineRunnerPeers | null>;
  readonly revisionOf: (
    taskId: string,
    record: RoutineRunnerRecord | null,
  ) => Effect.Effect<number, ScheduledTaskError>;
  readonly bump: (taskId: string) => Effect.Effect<void, ScheduledTaskError>;
  readonly tellDeleted: (
    record: RoutineRunnerRecord,
    id: ScheduledTaskId,
    except: string | null,
  ) => Effect.Effect<Array<string>>;
}

export const makeRunnerReceive = (parts: RunnerReceiveParts) => {
  const { deps, records, lock, peersRef, revisionOf, bump, tellDeleted } = parts;
  // --- another machine asks --------------------------------------------------------------

  const base = { capabilities: [ROUTINE_RUNNER_CAPABILITY] } as const;

  /** This machine's linked copy of the caller's project, within the caller's grant. */
  const linkedProject = (caller: ReceiverCaller, sourceProjectId: string) =>
    Effect.gen(function* () {
      const grant = caller.grant;
      if (grant === null || grant.revoked)
        return yield* refuseTransfer(403, "This machine does not let that machine run work here.");
      if (!grant.routines && grant.legacy !== true)
        return yield* refuseTransfer(
          403,
          "This machine does not let that machine's coordinator manage routines. Turn on Routines for it in Settings > Machines > Who can run work here.",
        );
      const rows = yield* deps.projects.list().pipe(Effect.orElseSucceed(() => []));
      const row = rows.find(
        (entry) =>
          entry.deletedAt === null &&
          (entry.workspaceSettings?.logicalProject?.members ?? []).some(
            (member) =>
              member.environmentId === caller.sourceEnvironmentId &&
              member.projectId === sourceProjectId,
          ),
      );
      if (row === undefined)
        return yield* refuseTransfer(
          404,
          "This project has no linked copy on this machine. Link it first.",
        );
      if (
        !projectInGrant(grant.projects, caller.sourceEnvironmentId, {
          id: row.projectId,
          workspaceSettings: row.workspaceSettings,
        })
      )
        return yield* refuseTransfer(
          403,
          "This machine's work grant for that machine leaves this project out.",
        );
      return row;
    });

  const disarm = (
    caller: ReceiverCaller,
    request: Extract<RoutineRunnerRequest, { op: "runner-disarm" }>,
  ) =>
    Effect.gen(function* () {
      const project = yield* linkedProject(caller, request.sourceProjectId);
      const self = yield* deps.selfEnvironmentId;
      const coordinates = yield* deps.roleActive(project.projectId);
      const peers = yield* Ref.get(peersRef);
      const label =
        request.runnerLabel ??
        (peers === null ? null : yield* peers.label(caller.sourceEnvironmentId));
      const acked: Array<ScheduledTaskId> = [];
      const refused: Array<ScheduledTaskId> = [];
      // Both machines may coordinate and both may claim: the lower id keeps a routine it runs.
      const winsTie = self !== null && self < caller.sourceEnvironmentId;
      for (const [index, id] of request.routineIds.entries()) {
        const held = yield* deps.findTask(id).pipe(Effect.orElseSucceed(() => null));
        if (held !== null && held.projectId !== project.projectId) {
          refused.push(id);
          continue;
        }
        // Only a routine that follows its project's coordinator has a runner to settle.
        if (held !== null && !isRunnerRoutine(held)) {
          refused.push(id);
          continue;
        }
        const record = yield* records.read(id);
        const runsItToday =
          held !== null &&
          held.enabled &&
          isRunnerRoutine(held) &&
          coordinates &&
          (yield* deps.legacyHold(held)) === null;
        if (
          record !== null &&
          (record.state === "settled" || record.state === "staged" || record.state === "moving")
        ) {
          refused.push(id);
          continue;
        }
        if (runsItToday && winsTie) {
          refused.push(id);
          continue;
        }
        // A runner that took a routine over continues its count from the next, so a
        // revision push from another machine that brings nothing newer was queued
        // before the move: it would name the old runner again.
        if (
          request.refresh === true &&
          record !== null &&
          record.runnerEnvironmentId !== caller.sourceEnvironmentId &&
          (request.revisions?.[index] ?? 0) <= record.revision
        ) {
          refused.push(id);
          continue;
        }
        yield* records.write({
          taskId: id,
          state: "disarmed",
          runnerEnvironmentId: caller.sourceEnvironmentId,
          runnerLabel: label,
          // The runner's revision, so a change made on this copy is made against it.
          revision: request.revisions?.[index] ?? record?.revision ?? 0,
          acked: [],
          operationId: null,
          operation: null,
        });
        acked.push(id);
      }
      yield* deps.notifyChanged;
      return { ...base, acked, refused } satisfies RoutineRunnerResponse;
    });

  const rearmHere = (
    caller: ReceiverCaller,
    request: Extract<RoutineRunnerRequest, { op: "runner-rearm" }>,
  ) =>
    Effect.gen(function* () {
      for (const id of request.routineIds) {
        const record = yield* records.read(id);
        if (
          record?.state === "disarmed" &&
          record.runnerEnvironmentId === caller.sourceEnvironmentId
        ) {
          if (request.deleted === true) {
            // The record goes only with the row: a row left without it would follow
            // the coordinator again, and the runner would take it for deleted.
            const undeleted = () => refuseTransfer(409, "That routine could not be deleted here.");
            const held = yield* deps.findTask(id).pipe(Effect.mapError(undeleted));
            if (held !== null) yield* deps.remove({ id }).pipe(Effect.mapError(undeleted));
            yield* records.dropRevision(id).pipe(Effect.ignore);
          }
          yield* records.remove(id);
        }
      }
      yield* deps.notifyChanged;
      return { ...base, acked: [...request.routineIds] } satisfies RoutineRunnerResponse;
    });

  /** A change a copy's machine sends: made here only by the runner, against the revision it names. */
  const editHere = (
    caller: ReceiverCaller,
    request: Extract<RoutineRunnerRequest, { op: "runner-edit" }>,
  ) =>
    Effect.gen(function* () {
      const grant = caller.grant;
      if (grant === null || grant.revoked)
        return yield* refuseTransfer(403, "This machine does not let that machine run work here.");
      if (!grant.routines && grant.legacy !== true)
        return yield* refuseTransfer(
          403,
          "This machine does not let that machine's coordinator manage routines. Turn on Routines for it in Settings > Machines > Who can run work here.",
        );
      const task = yield* deps
        .findTask(request.routineId)
        .pipe(Effect.mapError(() => refuseTransfer(409, "That routine could not be read here.")));
      if (task === null) {
        // Deleted here already: a delete asked again after its answer was lost is done.
        if (request.edit.kind === "delete")
          return { ...base, revision: 0, copy: null } satisfies RoutineRunnerResponse;
        return yield* refuseTransfer(404, "That routine is not on this machine.");
      }
      const record = yield* records.read(task.id);
      if (record === null || !runsHere(record))
        return yield* refuseTransfer(409, "This machine does not run that routine.");
      const row = yield* deps.projects
        .get(task.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
      if (
        Option.isNone(row) ||
        !projectInGrant(grant.projects, caller.sourceEnvironmentId, {
          id: row.value.projectId,
          workspaceSettings: row.value.workspaceSettings,
        })
      )
        return yield* refuseTransfer(
          403,
          "This machine's work grant for that machine leaves this project out.",
        );
      const grantedBy = yield* deps
        .readGrant(task.id)
        .pipe(
          Effect.mapError(() => refuseTransfer(409, "That routine's grant could not be read.")),
        );
      const others = othersRoutineRefusal(
        {
          coordinatorLabel: "that machine",
          grant: {
            coordinatorEnvironmentId: grant.coordinatorEnvironmentId,
            ...(grant.kind === undefined ? {} : { kind: grant.kind }),
          },
        },
        task,
        grantedBy,
        request.edit.kind === "delete" ? "delete" : "change",
      );
      if (others !== null) return yield* refuseTransfer(403, others);
      const failed = (error: ScheduledTaskError) =>
        refuseTransfer(409, `Not changed: ${error.message}`);
      const current = yield* revisionOf(task.id, record).pipe(Effect.mapError(failed));
      if (request.expectedRevision !== undefined && request.expectedRevision !== current)
        // Not made: the caller gets what this machine holds, to show and to change again.
        return {
          ...base,
          stale: true,
          revision: current,
          copy: routineCopyOf({ ...task, ownThread: true }),
        } satisfies RoutineRunnerResponse;
      switch (request.edit.kind) {
        case "delete": {
          const unreached = yield* tellDeleted(record, task.id, caller.sourceEnvironmentId);
          if (unreached.length > 0)
            return yield* refuseTransfer(409, deleteUnreachedRefusal(unreached));
          yield* deps.remove({ id: task.id }).pipe(Effect.mapError(failed));
          yield* records.remove(task.id).pipe(Effect.ignore);
          yield* records.dropRevision(task.id).pipe(Effect.ignore);
          return {
            ...base,
            revision: current + 1,
            copy: null,
          } satisfies RoutineRunnerResponse;
        }
        case "enabled": {
          yield* deps
            .setEnabled({ id: task.id, enabled: request.edit.enabled })
            .pipe(Effect.mapError(failed));
          break;
        }
        case "save": {
          const routine = request.edit.routine;
          if (routine.id !== task.id)
            return yield* refuseTransfer(400, "That change names another routine.");
          if (!accountInGrant(grant.accounts, routine.modelSelection.instanceId))
            return yield* refuseTransfer(
              403,
              "This machine's work grant does not allow that routine's sign-in.",
            );
          const input = decodeUpsert({
            id: task.id,
            title: routine.title,
            prompt: routine.prompt,
            enabled: routine.enabled,
            schedule: routine.schedule,
            projectId: task.projectId,
            threadId: task.threadId,
            workspaceStrategy: routine.workspaceStrategy,
            modelSelection: routine.modelSelection,
            runtimeMode: routine.runtimeMode,
            interactionMode: routine.interactionMode,
            createdBy: task.createdBy,
            creationSource: task.creationSource,
            modelPinned: routine.modelPinned ?? false,
            check: routine.check ?? null,
            brief: routine.brief ?? null,
            ownThread: task.ownThread === true,
          });
          if (Option.isNone(input))
            return yield* refuseTransfer(400, "That routine does not match this version.");
          yield* deps.upsert(input.value).pipe(Effect.mapError(failed));
          break;
        }
      }
      yield* bump(task.id).pipe(Effect.mapError(failed));
      yield* deps.notifyChanged;
      const after = yield* deps.findTask(task.id).pipe(Effect.orElseSucceed(() => null));
      return {
        ...base,
        revision: current + 1,
        copy: after === null ? null : routineCopyOf({ ...after, ownThread: true }),
      } satisfies RoutineRunnerResponse;
    });

  /** `status`, `runner-disarm`, `runner-rearm`, `runner-edit`; the move ops are ScheduledTaskTransfer's. */
  const receive = (
    caller: ReceiverCaller,
    request: Extract<
      RoutineRunnerRequest,
      { op: "status" | "runner-disarm" | "runner-rearm" | "runner-edit" }
    >,
  ): Effect.Effect<RoutineRunnerResponse, RoutineTransferRefusal> => {
    const unreadable = () =>
      refuseTransfer(503, "This machine could not read its routine runners.");
    switch (request.op) {
      case "status":
        return Effect.gen(function* () {
          const record =
            request.routineId === undefined ? null : yield* records.readStrict(request.routineId);
          const task =
            request.routineId === undefined
              ? null
              : yield* deps.findTask(request.routineId).pipe(Effect.orElseSucceed(() => null));
          const operation =
            request.operationId === undefined
              ? undefined
              : (yield* records.receipt(`${request.operationId}:abort`)) !== null
                ? ("aborted" as const)
                : (yield* records.receipt(`${request.operationId}:enable`)) !== null
                  ? ("enabled" as const)
                  : record?.state === "staged" && record.operationId === request.operationId
                    ? ("staged" as const)
                    : ("unknown" as const);
          return {
            ...base,
            routine:
              task === null
                ? null
                : {
                    state: record?.state ?? "none",
                    runnerEnvironmentId: record?.runnerEnvironmentId ?? null,
                    revision: yield* revisionOf(task.id, record),
                    enabled: task.enabled,
                  },
            ...(operation === undefined ? {} : { operation }),
          } satisfies RoutineRunnerResponse;
        }).pipe(Effect.catchCause(() => Effect.fail(unreadable())));
      case "runner-disarm":
        return lock
          .withPermits(1)(disarm(caller, request))
          .pipe(Effect.catchCause((cause) => failOrUnreadable(cause, unreadable)));
      case "runner-rearm":
        // A delete is sent by a runner that holds its own change lock. Taking this
        // machine's lock too would let two machines wait on each other until the
        // request timed out, so a delete only removes, in single statements.
        return (
          request.deleted === true
            ? rearmHere(caller, request)
            : lock.withPermits(1)(rearmHere(caller, request))
        ).pipe(Effect.catchCause((cause) => failOrUnreadable(cause, unreadable)));
      case "runner-edit":
        return lock
          .withPermits(1)(editHere(caller, request))
          .pipe(Effect.catchCause((cause) => failOrUnreadable(cause, unreadable)));
    }
  };

  return receive;
};
