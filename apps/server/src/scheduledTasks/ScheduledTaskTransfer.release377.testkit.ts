/**
 * The routines route of release 1.0.377, the release before runner records
 * (1390 EC2-09): its request and answer shapes and the steps its target ran,
 * copied as they shipped and never edited to follow the code beside it
 * (1.0.378 and 1.0.379 left the route as it was). A
 * machine in a test that answers through `receive377` is a machine that was
 * not updated.
 */
import {
  CoordinatorRoutineCopy,
  NonNegativeInt,
  type Project,
  type RuntimeMode,
  type ScheduledTaskGrantedBy,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
} from "@specweave-studio/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { accountInGrant, projectInGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";

// --- wire ---------------------------------------------------------------------------

export const ROUTINE_TRANSFER_PROTOCOL_VERSION = 1;

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** A routine's run state, so the target neither repeats nor skips a run. */
export const TransferRunState = Schema.Struct({
  nextRunAt: Schema.NullOr(bounded(64)),
  lastRunAt: Schema.NullOr(bounded(64)),
  runCount: NonNegativeInt,
  onceGeneration: NonNegativeInt,
});
export type TransferRunState = typeof TransferRunState.Type;

export const RoutineTransferRequest = Schema.Union([
  Schema.Struct({
    protocolVersion: NonNegativeInt,
    op: Schema.Literal("stage"),
    /** The caller's copy of the project; the target uses its own linked copy. */
    sourceProjectId: bounded(256),
    routine: CoordinatorRoutineCopy,
    ownThread: Schema.Boolean,
    /** The target's thread the routine posts into: the continuation of the moved worker. */
    boundThreadId: Schema.NullOr(bounded(512)),
  }),
  Schema.Struct({
    protocolVersion: NonNegativeInt,
    op: Schema.Literal("enable"),
    routineId: ScheduledTaskId,
    runState: TransferRunState,
  }),
  Schema.Struct({
    protocolVersion: NonNegativeInt,
    op: Schema.Literal("release"),
    routineId: ScheduledTaskId,
  }),
]);
export type RoutineTransferRequest = typeof RoutineTransferRequest.Type;

export const RoutineTransferResponse = Schema.Struct({
  routineId: bounded(256),
  /** The target's copy of the project. */
  projectId: Schema.optional(bounded(256)),
  enabled: Schema.Boolean,
  /** `release`: the state the target's copy ended with; null when it had none. */
  runState: Schema.optional(Schema.NullOr(TransferRunState)),
  /** The routine runs with less access there than here (the grant's cap). */
  capped: Schema.optional(Schema.Boolean),
});
export type RoutineTransferResponse = typeof RoutineTransferResponse.Type;

export class RoutineTransferRefusal extends Data.TaggedError("RoutineTransferRefusal")<{
  readonly status: number;
  readonly message: string;
}> {}

// --- the target's side -------------------------------------------------------------------

export interface TransferInDeps {
  readonly projects: Effect.Effect<ReadonlyArray<Project>>;
  /** The project a routine id belongs to here, and the grant it was saved under. */
  readonly findTask: (id: string) => Effect.Effect<{
    readonly projectId: string;
    readonly grantedBy: ScheduledTaskGrantedBy | undefined;
  } | null>;
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
}

const decodeUpsert = Schema.decodeUnknownOption(ScheduledTaskUpsertInput);

const refuse = (status: number, message: string) =>
  new RoutineTransferRefusal({ status, message: message.slice(0, 500) });

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

export const makeTransferIn = (deps: TransferInDeps) => {
  /** The caller's own routine here, or a refusal: Away touches only what it moved. */
  const ownRoutine = (caller: ReceiverCaller, id: string) =>
    Effect.gen(function* () {
      const held = yield* deps.findTask(id);
      if (held === null) return null;
      if (held.grantedBy?.coordinatorEnvironmentId !== caller.sourceEnvironmentId)
        return yield* refuse(403, "That routine was not moved here by that machine.");
      return held;
    });

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
          const held = yield* deps.findTask(routine.id);
          if (held !== null && held.projectId !== project.id)
            return yield* refuse(409, "Another project here uses that routine's id.");
          if (
            held !== null &&
            held.grantedBy !== undefined &&
            held.grantedBy.coordinatorEnvironmentId !== caller.sourceEnvironmentId
          )
            return yield* refuse(409, "Another machine's work set up that routine here.");
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
          return {
            routineId: routine.id,
            projectId: project.id,
            enabled: false,
            capped: runtime.capped,
          };
        }
        case "enable": {
          const held = yield* ownRoutine(caller, request.routineId);
          if (held === null) return yield* refuse(404, "That routine is not on this machine.");
          // On first, then the state: turning on computes its own next run, which the state replaces.
          yield* deps
            .setEnabled(request.routineId, true)
            .pipe(Effect.mapError((message) => refuse(409, `Not turned on here: ${message}`)));
          yield* deps.writeState(held.projectId, request.routineId, request.runState);
          return { routineId: request.routineId, projectId: held.projectId, enabled: true };
        }
        case "release": {
          const held = yield* ownRoutine(caller, request.routineId);
          // Already gone: a retry after the first answer was lost.
          if (held === null)
            return { routineId: request.routineId, enabled: false, runState: null };
          // Read first: turning it off clears its next run.
          const runState = yield* deps.readState(request.routineId);
          yield* deps
            .setEnabled(request.routineId, false)
            .pipe(Effect.mapError((message) => refuse(409, `Not turned off here: ${message}`)));
          yield* deps
            .remove(request.routineId)
            .pipe(Effect.mapError((message) => refuse(409, `Not removed here: ${message}`)));
          return { routineId: request.routineId, enabled: false, runState };
        }
      }
    });
  return { receive } as const;
};

const decode377 = Schema.decodeUnknownOption(RoutineTransferRequest);

/** The route as 1.0.377 ran it: a body it cannot read is a 400 and changes nothing. */
export const receive377 =
  (deps: TransferInDeps) =>
  (
    caller: ReceiverCaller,
    body: unknown,
  ): Effect.Effect<
    { readonly status: 200; readonly json: RoutineTransferResponse },
    RoutineTransferRefusal
  > => {
    const request = decode377(body);
    if (Option.isNone(request))
      return Effect.fail(refuse(400, "The request does not match this version."));
    return makeTransferIn(deps)
      .receive(caller, request.value)
      .pipe(Effect.map((json) => ({ status: 200 as const, json })));
  };
