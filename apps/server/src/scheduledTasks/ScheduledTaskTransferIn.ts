/**
 * The target's side of a runner move, and of the release before's `stage`,
 * `enable` and `release` (1267 T-05; 1390 AC-45). See ScheduledTaskTransfer
 * for the order of a move.
 */
import {
  type CoordinatorRoutineCopy,
  type Project,
  type RuntimeMode,
  type ScheduledTaskGrantedBy,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { accountInGrant, projectInGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import {
  type RoutineRunnerRecord,
  type RoutineRunnerRecords,
} from "./ScheduledTaskRunnerRecords.ts";
import {
  refuseTransfer,
  ROUTINE_RUNNER_CAPABILITY,
  ROUTINE_TRANSFER_PROTOCOL_VERSION,
  type RoutineRunnerRequest,
  RoutineRunnerResponse,
  type RoutineTransferRefusal,
  type RoutineTransferRequest,
  type RoutineTransferResponse,
  TransferRunState,
} from "./ScheduledTaskRunnerWire.ts";

export interface TransferInDeps {
  readonly projects: Effect.Effect<ReadonlyArray<Project>>;
  /** The project a routine id belongs to here, and the grant it was saved under. */
  readonly findTask: (id: string) => Effect.Effect<
    {
      readonly projectId: string;
      readonly grantedBy: ScheduledTaskGrantedBy | undefined;
    } | null,
    string
  >;
  /** Every write of `effect`, or none of them. */
  readonly atomically: <A>(
    effect: Effect.Effect<A, RoutineTransferRefusal>,
  ) => Effect.Effect<A, RoutineTransferRefusal>;
  readonly upsert: (
    input: ScheduledTaskUpsertInput,
    grantedBy: ScheduledTaskGrantedBy,
  ) => Effect.Effect<void, string>;
  readonly setEnabled: (id: ScheduledTaskId, enabled: boolean) => Effect.Effect<boolean, string>;
  readonly remove: (id: ScheduledTaskId) => Effect.Effect<void, string>;
  readonly readState: (id: string) => Effect.Effect<TransferRunState | null>;
  readonly writeState: (
    projectId: string,
    id: string,
    state: TransferRunState,
  ) => Effect.Effect<void>;
  /** This machine's runner records (ScheduledTaskRunner). */
  readonly records: Pick<
    RoutineRunnerRecords,
    "read" | "write" | "remove" | "receipt" | "putReceipt"
  >;
  readonly selfEnvironmentId: Effect.Effect<string | null>;
  /** This machine's count of changes to a routine it runs. */
  readonly revisionOf: (taskId: string) => Effect.Effect<number>;
  /**
   * The end of a move, as one write: the carried run state, this machine as
   * the runner, and the receipt that answers every repeat. All of it or none.
   */
  readonly commitEnable: (input: {
    readonly projectId: string;
    readonly routineId: string;
    readonly runState: TransferRunState;
    readonly record: RoutineRunnerRecord;
    readonly receiptKey: string;
    readonly answer: RoutineRunnerResponse;
  }) => Effect.Effect<void, string>;
}

const decodeUpsert = Schema.decodeUnknownOption(ScheduledTaskUpsertInput);

const refuse = refuseTransfer;

/** The routine's mode, no higher than the caller's ceiling here. */
export function cappedRuntimeMode(
  mode: RuntimeMode,
  ceiling: RuntimeMode | null | undefined,
): { readonly mode: RuntimeMode; readonly capped: boolean } {
  if (ceiling == null) return { mode, capped: false };
  const over = exceededDispatchModeLimit(
    { runtimeMode: ceiling, interactionMode: "default" },
    { runtimeMode: mode, interactionMode: "default" },
  );
  return over === undefined ? { mode, capped: false } : { mode: ceiling, capped: true };
}

type MoveRequest = Extract<
  RoutineRunnerRequest,
  { op: "runner-stage" | "runner-enable" | "runner-abort" }
>;
const decodeStoredAnswer = Schema.decodeUnknownOption(RoutineRunnerResponse);
/** What a release answered, kept on the record that rests here afterwards. */
const decodeReleased = Schema.decodeUnknownOption(
  Schema.Struct({ released: Schema.NullOr(TransferRunState) }),
);

export const makeTransferIn = (deps: TransferInDeps) => {
  const capable = { capabilities: [ROUTINE_RUNNER_CAPABILITY] } as const;
  const unreadable = () => refuse(503, "This machine could not read its routine runners.");
  const strict = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.catchCause(() => Effect.fail(unreadable())));

  /** The caller's own routine here, or a refusal: Away touches only what it moved. */
  const ownRoutine = (caller: ReceiverCaller, id: string) =>
    Effect.gen(function* () {
      // Unreadable is not absent: a caller told "gone" would run the routine as well.
      const held = yield* strict(deps.findTask(id));
      if (held === null) return null;
      if (held.grantedBy?.coordinatorEnvironmentId !== caller.sourceEnvironmentId)
        return yield* refuse(403, "That routine was not moved here by that machine.");
      return held;
    });

  /** Saves the caller's routine here, turned off, in its linked copy and within its grant. */
  const stageHere = (
    caller: ReceiverCaller,
    request: {
      readonly sourceProjectId: string;
      readonly routine: CoordinatorRoutineCopy;
      readonly ownThread: boolean;
      readonly boundThreadId: string | null;
    },
  ) =>
    Effect.gen(function* () {
      const grant = caller.grant;
      if (grant === null || grant.revoked)
        return yield* refuse(403, "This machine does not let that machine run work here.");
      if (!grant.routines && grant.legacy !== true)
        return yield* refuse(
          403,
          "This machine does not let that machine's coordinator manage routines. Turn on Routines for it in Settings > Machines > Who can run work here.",
        );
      const all = yield* deps.projects;
      const project = all.find(
        (entry) =>
          entry.deletedAt === null &&
          (entry.workspaceSettings?.logicalProject?.members ?? []).some(
            (member) =>
              member.environmentId === caller.sourceEnvironmentId &&
              member.projectId === request.sourceProjectId,
          ),
      );
      if (project === undefined)
        return yield* refuse(
          404,
          "This project has no linked copy on this machine. Link it first.",
        );
      if (!projectInGrant(grant.projects, caller.sourceEnvironmentId, project))
        return yield* refuse(
          403,
          "This machine's work grant for that machine leaves this project out.",
        );
      const routine = request.routine;
      if (!accountInGrant(grant.accounts, routine.modelSelection.instanceId))
        return yield* refuse(
          403,
          "This machine's work grant does not allow that routine's sign-in.",
        );
      const held = yield* strict(deps.findTask(routine.id));
      if (held !== null && held.projectId !== project.id)
        return yield* refuse(409, "Another project here uses that routine's id.");
      if (
        held !== null &&
        held.grantedBy !== undefined &&
        held.grantedBy.coordinatorEnvironmentId !== caller.sourceEnvironmentId
      )
        return yield* refuse(409, "Another machine's work set up that routine here.");
      // A routine this machine runs itself, or is moving, is not another machine's to stage.
      const record = yield* strict(deps.records.read(routine.id));
      // A copy the same machine staged before, in a move that never ended, is staged over.
      const leftover =
        record?.state === "staged" && record.runnerEnvironmentId === caller.sourceEnvironmentId;
      if (record !== null && record.state !== "disarmed" && !leftover)
        return yield* refuse(409, "This machine runs that routine itself.");
      const runtime = cappedRuntimeMode(routine.runtimeMode, caller.runtimeCeiling);
      const input = decodeUpsert({
        id: routine.id,
        title: routine.title,
        prompt: routine.prompt,
        enabled: false,
        schedule: routine.schedule,
        projectId: project.id,
        threadId: request.boundThreadId,
        workspaceStrategy: routine.workspaceStrategy,
        modelSelection: routine.modelSelection,
        runtimeMode: runtime.mode,
        interactionMode: routine.interactionMode,
        createdBy: routine.createdBy,
        creationSource: "server",
        modelPinned: routine.modelPinned ?? false,
        check: routine.check ?? null,
        brief: routine.brief ?? null,
        ownThread: request.ownThread,
      });
      if (Option.isNone(input))
        return yield* refuse(400, "That routine does not match this version.");
      yield* deps
        .upsert(input.value, {
          coordinatorEnvironmentId: caller.sourceEnvironmentId,
          runtimeCap: caller.runtimeCeiling ?? null,
          accounts: grant.accounts,
        })
        .pipe(Effect.mapError((message) => refuse(409, `Not saved here: ${message}`)));
      return { routineId: routine.id, projectId: project.id, capped: runtime.capped };
    });

  /** The requests of the release before runner records; answered as that release answers them. */
  const receive = (
    caller: ReceiverCaller,
    request: RoutineTransferRequest,
  ): Effect.Effect<RoutineTransferResponse, RoutineTransferRefusal> =>
    Effect.gen(function* () {
      if (request.protocolVersion !== ROUTINE_TRANSFER_PROTOCOL_VERSION)
        return yield* refuse(
          409,
          "The two machines run different versions of Away mode. Update both.",
        );
      const grant = caller.grant;
      if (grant === null || grant.revoked)
        return yield* refuse(403, "This machine does not let that machine run work here.");
      switch (request.op) {
        case "stage": {
          const staged = yield* stageHere(caller, request);
          return { ...staged, enabled: false };
        }
        case "enable": {
          const held = yield* ownRoutine(caller, request.routineId);
          if (held === null) return yield* refuse(404, "That routine is not on this machine.");
          // A routine with a runner record is turned on only by its move's own enable.
          if ((yield* strict(deps.records.read(request.routineId))) !== null)
            return yield* refuse(
              409,
              "That routine has a runner here; it is not turned on this way.",
            );
          // On first, then the state: turning on computes its own next run, which the state replaces.
          yield* deps
            .setEnabled(request.routineId, true)
            .pipe(Effect.mapError((message) => refuse(409, `Not turned on here: ${message}`)));
          yield* deps.writeState(held.projectId, request.routineId, request.runState);
          return { routineId: request.routineId, projectId: held.projectId, enabled: true };
        }
        case "release": {
          const held = yield* ownRoutine(caller, request.routineId);
          // Already gone: a retry after the first answer was lost. It gets the state
          // the first answer carried, kept on the record that rests here.
          if (held === null) {
            const rests = yield* strict(deps.records.read(request.routineId));
            const before =
              rests?.runnerEnvironmentId === caller.sourceEnvironmentId
                ? Option.getOrNull(decodeReleased(rests.operation))
                : null;
            return {
              routineId: request.routineId,
              enabled: false,
              runState: before?.released ?? null,
              ...(rests === null ? {} : { revision: rests.revision }),
            };
          }
          // Off, gone and the answer kept, in one write: a routine released here is
          // never left on, and a repeat of this request answers the same state.
          return yield* deps.atomically(
            Effect.gen(function* () {
              // Read first: turning it off clears its next run.
              const runState = yield* deps.readState(request.routineId);
              yield* deps
                .setEnabled(request.routineId, false)
                .pipe(Effect.mapError((message) => refuse(409, `Not turned off here: ${message}`)));
              yield* deps
                .remove(request.routineId)
                .pipe(Effect.mapError((message) => refuse(409, `Not removed here: ${message}`)));
              // The record stays, resting for the caller, so a copy that arrives later
              // cannot fire here as well.
              const record = yield* strict(deps.records.read(request.routineId));
              // A routine that release moved here has no record, and gets none: its
              // next move from that release must find it as this one left it.
              if (record === null)
                return { routineId: request.routineId, enabled: false, runState };
              const revision = yield* deps.revisionOf(request.routineId);
              yield* strict(
                deps.records.write({
                  ...record,
                  state: "disarmed",
                  runnerEnvironmentId: caller.sourceEnvironmentId,
                  runnerLabel: null,
                  revision,
                  acked: [],
                  operation: { released: runState },
                  asked: [],
                  copyEnabled: null,
                }),
              );
              return { routineId: request.routineId, enabled: false, runState, revision };
            }),
          );
        }
      }
    });

  /** The steps of a runner move, each under the move's operation id. */
  const receiveMove = (
    caller: ReceiverCaller,
    request: MoveRequest,
  ): Effect.Effect<RoutineRunnerResponse, RoutineTransferRefusal> =>
    Effect.gen(function* () {
      const stored = (key: string) =>
        strict(deps.records.receipt(key)).pipe(
          Effect.map((answer) =>
            answer === null ? null : Option.getOrNull(decodeStoredAnswer(answer)),
          ),
        );
      switch (request.op) {
        case "runner-stage": {
          const routineId = request.routine.id;
          const before = yield* stored(`${request.operationId}:stage`);
          if (before !== null) return before;
          if ((yield* stored(`${request.operationId}:abort`)) !== null)
            return yield* refuse(409, "That move was called off.");
          const staged = yield* stageHere(caller, request);
          const answer: RoutineRunnerResponse = {
            ...capable,
            projectId: staged.projectId,
            enabled: false,
            capped: staged.capped,
            operation: "staged",
          };
          yield* strict(
            deps.records.write({
              taskId: routineId,
              state: "staged",
              runnerEnvironmentId: caller.sourceEnvironmentId,
              runnerLabel: null,
              revision: 0,
              acked: [],
              operationId: request.operationId,
              operation: { projectId: staged.projectId, capped: staged.capped },
            }),
          );
          yield* strict(deps.records.putReceipt(`${request.operationId}:stage`, routineId, answer));
          return answer;
        }
        case "runner-enable": {
          // Asked again: the first answer, and nothing written. The routine may have run since.
          const before = yield* stored(`${request.operationId}:enable`);
          if (before !== null) return before;
          if ((yield* stored(`${request.operationId}:abort`)) !== null)
            return yield* refuse(409, "That move was called off.");
          const record = yield* strict(deps.records.read(request.routineId));
          if (
            record === null ||
            record.state !== "staged" ||
            record.operationId !== request.operationId
          )
            return yield* refuse(409, "That move is not staged on this machine.");
          const held = yield* ownRoutine(caller, request.routineId);
          if (held === null) return yield* refuse(404, "That routine is not on this machine.");
          const self = yield* deps.selfEnvironmentId;
          // On, but still `staged`: it cannot fire until the write below ends the move.
          yield* deps
            .setEnabled(request.routineId, true)
            .pipe(Effect.mapError((message) => refuse(409, `Not turned on here: ${message}`)));
          const revision = request.revision + 1;
          const answer: RoutineRunnerResponse = {
            ...capable,
            projectId: held.projectId,
            enabled: true,
            revision,
            operation: "enabled",
          };
          yield* deps
            .commitEnable({
              projectId: held.projectId,
              routineId: request.routineId,
              runState: request.runState,
              record: {
                taskId: request.routineId,
                state: "settled",
                runnerEnvironmentId: self ?? "",
                runnerLabel: null,
                revision,
                acked: [...request.acked],
                operationId: request.operationId,
                operation: null,
              },
              receiptKey: `${request.operationId}:enable`,
              answer,
            })
            .pipe(Effect.mapError((message) => refuse(503, `Not turned on here: ${message}`)));
          return answer;
        }
        case "runner-abort": {
          if ((yield* stored(`${request.operationId}:enable`)) !== null)
            return yield* refuse(409, "That move already turned the routine on here.");
          const answer: RoutineRunnerResponse = {
            ...capable,
            enabled: false,
            operation: "aborted",
          };
          // First, so an enable that arrives late is refused for good.
          yield* strict(
            deps.records.putReceipt(`${request.operationId}:abort`, request.routineId, answer),
          );
          const record = yield* strict(deps.records.read(request.routineId));
          if (record?.state === "staged" && record.operationId === request.operationId) {
            const held = yield* ownRoutine(caller, request.routineId);
            if (held !== null) {
              yield* deps
                .setEnabled(request.routineId, false)
                .pipe(Effect.mapError((message) => refuse(409, `Not turned off here: ${message}`)));
              yield* deps
                .remove(request.routineId)
                .pipe(Effect.mapError((message) => refuse(409, `Not removed here: ${message}`)));
            }
            yield* strict(deps.records.remove(request.routineId));
          }
          return answer;
        }
      }
    });
  return { receive, receiveMove } as const;
};
