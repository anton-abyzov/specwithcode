/**
 * Away mode's planned coordinator handover (1267 T-04, AC-05). The machine
 * that coordinates a linked project hands it to another linked copy while it
 * is still awake, in this order:
 *
 * 1. It checks the target copy is listed and the target answers. Nothing changed yet.
 * 2. It gives way here (`plannedGiveWay`): this copy is `transferred` at
 *    epoch+1, naming the target as its successor. From here on no copy is
 *    active until the target takes over, so two never are.
 * 3. It asks the target, over the work-grant channel, to take over at that
 *    epoch (`plannedTakeover`), carrying its workers on other machines and its
 *    coordinator-owned routines with their run state. The target keeps the
 *    routines, takes over, then claims the epoch on every other machine and
 *    adopts the workers, as an automatic takeover's follow-up does.
 * 4. A refusal the target answered means it never took over: this copy
 *    coordinates again (`plannedRevert`). A call without an answer is tried
 *    once more under the same operation id, which the target replays; still
 *    no answer leaves the project without an active coordinator, never with
 *    two, and the same call later finishes it.
 *
 * The caller is the coordinator itself, so this deliberately skips the
 * app's ten-minute unreachable gate on a person's takeover. Re-arming this
 * machine as the target's standby is left to Bring back.
 */
import {
  AWAY_HANDOVER_PATH,
  type AwayHandoverInput,
  AwayHandoverReason,
  type AwayHandoverResult,
  CoordinatorRoutineCopies,
  type CoordinatorRoutineCopy,
  type EnvironmentId,
  isProjectCoordinatorThreadId,
  LogicalProjectMember,
  NonNegativeInt,
  type Project,
  ProjectId,
  type ProjectLinkError,
} from "@specweave-studio/contracts";
import {
  isPersonalAssistantProject,
  PERSONAL_ASSISTANT_PRIVATE_MESSAGE,
} from "@specweave-studio/shared/personalAssistant";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { AwayPeerError, type AwayPeerPost, makeAwayPeerPost } from "../away/awayPeerCall.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  type AdoptWorkersInput,
  type AdoptWorkersResult,
  RemoteWorkerAdoption,
} from "../fleet/RemoteWorkerAdoption.ts";
import { RemoteWorkerStore } from "../fleet/RemoteWorkerStore.ts";
import { projectInGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { HandoffPeers } from "../handoff/handoffPeers.ts";
import { RoutineCopies } from "../scheduledTasks/ScheduledTaskCopies.ts";
import {
  CoordinatorStandbyShadowWorker,
  STANDBY_DELIVERED_RUN_IDS_MAX,
} from "./CoordinatorStandbyStore.ts";
import { ProjectLink } from "./ProjectLink.ts";
import {
  CoordinatorReleaseGuard,
  plannedHandoverOperationId,
  type ProjectLinkStandbyMethods,
} from "./ProjectLinkStandby.ts";
import * as ProjectService from "./ProjectService.ts";

// --- wire -------------------------------------------------------------------

/** Bumped whenever what the two machines do with a handover changes; a mismatch is refused. */
export const PLANNED_HANDOVER_PROTOCOL_VERSION = 1;
const HANDOVER_TIMEOUT_MS = 90_000;
const MAX_WORKERS = 200;

/** A routine's run state, so the target neither repeats nor skips its next run. */
export const RoutineRunState = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(256)),
  nextRunAt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
  lastRunAt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
  runCount: NonNegativeInt,
  onceGeneration: NonNegativeInt,
});
export type RoutineRunState = typeof RoutineRunState.Type;

export const PlannedHandoverRequest = Schema.Struct({
  protocolVersion: NonNegativeInt,
  operationId: Schema.String.check(Schema.isMaxLength(128)),
  reason: AwayHandoverReason,
  logicalProjectId: Schema.String.check(Schema.isMaxLength(512)),
  /** The target's own copy, as the caller lists it. */
  projectId: ProjectId,
  /** The coordinator handing over, as it lists itself. */
  predecessor: LogicalProjectMember,
  /** The epoch the caller gave way at; the target takes over at it. */
  epoch: NonNegativeInt,
  /** The caller's workers on other machines, for the target to adopt. */
  shadowWorkers: Schema.Array(CoordinatorStandbyShadowWorker).check(
    Schema.isMaxLength(MAX_WORKERS),
  ),
  routines: Schema.optional(CoordinatorRoutineCopies),
  runStates: Schema.optional(Schema.Array(RoutineRunState).check(Schema.isMaxLength(200))),
});
export type PlannedHandoverRequest = typeof PlannedHandoverRequest.Type;

export const PlannedHandoverResponse = Schema.Struct({
  operationId: Schema.String,
  epoch: NonNegativeInt,
  replayed: Schema.Boolean,
  /** Machines whose epoch claim got no answer yet. */
  unclaimed: Schema.Array(Schema.String),
});
export type PlannedHandoverResponse = typeof PlannedHandoverResponse.Type;

export class HandoverRefusal extends Data.TaggedError("HandoverRefusal")<{
  readonly status: number;
  readonly message: string;
}> {}

const linkErrorText = (error: ProjectLinkError) => error.detail ?? `refused (${error.code})`;

// --- the coordinator's side ---------------------------------------------------

export interface HandoverGathered {
  readonly shadowWorkers: ReadonlyArray<CoordinatorStandbyShadowWorker>;
  readonly routines?: ReadonlyArray<CoordinatorRoutineCopy> | undefined;
  readonly runStates?: ReadonlyArray<RoutineRunState> | undefined;
}

export interface PlannedHandoverDeps {
  readonly loadProject: (projectId: ProjectId) => Effect.Effect<Project | undefined>;
  readonly giveWay: ProjectLinkStandbyMethods["plannedGiveWay"];
  readonly revert: ProjectLinkStandbyMethods["plannedRevert"];
  /** Whether the target answers as itself with this machine's work grant there. */
  readonly reachable: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
  /** The target's name for messages. */
  readonly labelOf: (environmentId: EnvironmentId) => Effect.Effect<string>;
  /** What travels: workers on other machines, routines and their run state. */
  readonly gather: (project: Project, logicalProjectId: string) => Effect.Effect<HandoverGathered>;
  readonly send: (
    environmentId: EnvironmentId,
    request: PlannedHandoverRequest,
  ) => Effect.Effect<PlannedHandoverResponse, AwayPeerError>;
  /** Releases the standby this copy leases to, so it does not take over too. */
  readonly releaseStandby?:
    | ((project: Project, successor: LogicalProjectMember) => Effect.Effect<void>)
    | undefined;
  /** This machine stops following the workers the target adopted. */
  readonly releaseWorkers?: ((project: Project, reason: string) => Effect.Effect<void>) | undefined;
}

export const makePlannedHandover = (deps: PlannedHandoverDeps) => {
  const handOver = (input: AwayHandoverInput): Effect.Effect<AwayHandoverResult> =>
    Effect.gen(function* () {
      const result = (
        outcome: AwayHandoverResult["outcome"],
        detail: string,
        epoch?: number,
      ): AwayHandoverResult => ({
        projectId: input.projectId,
        outcome,
        detail: detail.slice(0, 500),
        ...(epoch === undefined ? {} : { epoch }),
      });
      const label = yield* deps.labelOf(input.targetEnvironmentId);
      const project = yield* deps.loadProject(input.projectId);
      if (project === undefined) return result("failed", "This project is not on this machine.");
      if (isPersonalAssistantProject(project))
        return result("skipped", PERSONAL_ASSISTANT_PRIVATE_MESSAGE);
      const identity = project.workspaceSettings?.logicalProject;
      if (identity === undefined)
        return result("failed", `This project has no linked copy on ${label}. Link it first.`);
      const binding = project.workspaceSettings?.coordinatorBinding ?? {
        epoch: 0,
        state: "active" as const,
      };
      // A handover that gave way here and was not confirmed: finish it.
      const resuming =
        binding.state === "transferred" &&
        binding.successor?.environmentId === input.targetEnvironmentId &&
        binding.operationId !== undefined &&
        (input.operationId === undefined || input.operationId === binding.operationId) &&
        binding.operationId.startsWith("handover:");
      if (!resuming && binding.state === "transferring")
        return result("failed", "This project is moving to another machine. Try again after.");
      if (!resuming && binding.state !== "active")
        return result("skipped", "This machine does not coordinate this project.");
      if (!identity.members.some((member) => member.environmentId === input.targetEnvironmentId))
        return result("failed", `This project has no linked copy on ${label}. Link it first.`);
      if (!(yield* deps.reachable(input.targetEnvironmentId)))
        return result(
          "failed",
          resuming
            ? `${label} did not answer. No machine coordinates this project until you try again.`
            : `${label} did not answer. Nothing changed.`,
        );
      const gathered = yield* deps.gather(project, identity.id);
      const operationId = resuming
        ? binding.operationId!
        : (input.operationId ?? plannedHandoverOperationId(identity.id, binding.epoch + 1));
      if (!resuming && deps.releaseStandby !== undefined) {
        const successor = identity.members.find(
          (member) => member.environmentId === input.targetEnvironmentId,
        );
        if (successor !== undefined) yield* deps.releaseStandby(project, successor);
      }
      const gave = yield* deps
        .giveWay({
          projectId: project.id,
          operationId,
          successorEnvironmentId: input.targetEnvironmentId,
        })
        .pipe(Effect.result);
      if (gave._tag === "Failure")
        return result("failed", `Not handed over: ${linkErrorText(gave.failure)}`);
      const { coordinatorBinding, self, successor } = gave.success;
      const request: PlannedHandoverRequest = {
        protocolVersion: PLANNED_HANDOVER_PROTOCOL_VERSION,
        operationId,
        reason: input.reason,
        logicalProjectId: gave.success.logicalProjectId,
        projectId: ProjectId.make(successor.projectId),
        predecessor: self,
        epoch: coordinatorBinding.epoch,
        shadowWorkers: gathered.shadowWorkers.slice(0, MAX_WORKERS),
        ...(gathered.routines === undefined ? {} : { routines: gathered.routines }),
        ...(gathered.runStates === undefined ? {} : { runStates: gathered.runStates }),
      };
      const sent = yield* deps.send(input.targetEnvironmentId, request).pipe(
        // The target replays the same operation, so one more try is safe.
        Effect.catchIf(
          (error) => error.uncertain,
          () => deps.send(input.targetEnvironmentId, request),
        ),
        Effect.result,
      );
      if (sent._tag === "Success") {
        if (deps.releaseWorkers !== undefined)
          yield* deps.releaseWorkers(project, `Handed to ${label} for Away.`);
        return result(
          "handed-over",
          sent.success.unclaimed.length === 0
            ? `${label} coordinates this project now.`
            : `${label} coordinates this project now. ${sent.success.unclaimed.length} other machine(s) have not confirmed yet.`,
          sent.success.epoch,
        );
      }
      const error = sent.failure;
      if (!error.refused)
        return result(
          "failed",
          `${label} did not confirm. No machine coordinates this project until you try again.`,
        );
      const reverted = yield* deps
        .revert({ projectId: project.id, operationId })
        .pipe(Effect.result);
      return reverted._tag === "Success"
        ? result("failed", `${error.message}. This machine coordinates it again.`)
        : result(
            "failed",
            `${error.message}. This machine could not take it back: ${linkErrorText(reverted.failure)}`,
          );
    });
  return { handOver } as const;
};

// --- the target's side ----------------------------------------------------------

export interface HandoverReceiverDeps {
  readonly selfEnvironmentId: string;
  readonly loadProject: (projectId: ProjectId) => Effect.Effect<Project | undefined>;
  readonly takeover: ProjectLinkStandbyMethods["plannedTakeover"];
  /** Keeps the coordinator's routines as this copy's own; absent without a scheduler. */
  readonly keepRoutines?:
    | ((input: {
        readonly projectId: ProjectId;
        readonly logicalProjectId: string;
        readonly routines: ReadonlyArray<CoordinatorRoutineCopy>;
      }) => Effect.Effect<void>)
    | undefined;
  readonly applyRunStates?:
    | ((projectId: ProjectId, states: ReadonlyArray<RoutineRunState>) => Effect.Effect<void>)
    | undefined;
  readonly adopt?:
    | ((input: AdoptWorkersInput) => Effect.Effect<Pick<AdoptWorkersResult, "unclaimed">>)
    | undefined;
}

export const makeHandoverReceiver = (deps: HandoverReceiverDeps) => {
  const receive = (
    caller: ReceiverCaller,
    request: PlannedHandoverRequest,
  ): Effect.Effect<PlannedHandoverResponse, HandoverRefusal> =>
    Effect.gen(function* () {
      if (request.protocolVersion !== PLANNED_HANDOVER_PROTOCOL_VERSION)
        return yield* new HandoverRefusal({
          status: 409,
          message: "The two machines run different versions of Away mode. Update both.",
        });
      const project = yield* deps.loadProject(request.projectId);
      if (project === undefined || project.deletedAt !== null)
        return yield* new HandoverRefusal({
          status: 404,
          message: "That copy of the project is not on this machine.",
        });
      if (
        caller.grant !== null &&
        !projectInGrant(caller.grant.projects, caller.sourceEnvironmentId, project)
      )
        return yield* new HandoverRefusal({
          status: 403,
          message: "This machine's work grant for that machine does not cover this project.",
        });
      const binding = project.workspaceSettings?.coordinatorBinding;
      const replaying = binding?.state === "active" && binding.operationId === request.operationId;
      // Routines first: they rest here until this copy coordinates, so none fires early.
      if (!replaying && request.routines !== undefined && deps.keepRoutines !== undefined) {
        yield* deps.keepRoutines({
          projectId: project.id,
          logicalProjectId: request.logicalProjectId,
          routines: request.routines,
        });
        if (request.runStates !== undefined && deps.applyRunStates !== undefined)
          yield* deps.applyRunStates(project.id, request.runStates);
      }
      const taken = yield* deps
        .takeover({
          projectId: project.id,
          logicalProjectId: request.logicalProjectId,
          callerEnvironmentId: caller.sourceEnvironmentId,
          predecessor: request.predecessor,
          epoch: request.epoch,
          operationId: request.operationId,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new HandoverRefusal({
                status: error.code === "not_linked" ? 404 : 409,
                message: `This machine did not take over: ${linkErrorText(error)}`,
              }),
          ),
        );
      const self = taken.logicalProject.members.find(
        (member) =>
          member.environmentId === deps.selfEnvironmentId && member.projectId === project.id,
      );
      let unclaimed: ReadonlyArray<string> = [];
      if (deps.adopt !== undefined && self !== undefined) {
        const adopted = yield* deps.adopt({
          logicalProjectId: request.logicalProjectId,
          epoch: taken.coordinatorBinding.epoch,
          projectId: project.id,
          coordinatorThreadId: self.coordinatorThreadId,
          predecessor: request.predecessor,
          shadowWorkers: request.shadowWorkers,
          claimOn: claimTargets(
            request.shadowWorkers,
            taken.logicalProject.members,
            deps.selfEnvironmentId,
            request.predecessor.environmentId,
          ),
        });
        unclaimed = adopted.unclaimed;
      }
      return {
        operationId: request.operationId,
        epoch: taken.coordinatorBinding.epoch,
        replayed: taken.replayed,
        unclaimed: [...unclaimed],
      };
    });
  return { receive } as const;
};

/** Every machine the replaced coordinator ran a worker on, and every other listed copy. */
export function claimTargets(
  workers: ReadonlyArray<{ readonly environmentId: string }>,
  members: ReadonlyArray<{ readonly environmentId: string }>,
  selfEnvironmentId: string,
  predecessorEnvironmentId: string,
): ReadonlyArray<string> {
  return [
    ...new Set<string>([
      ...workers.map((worker) => worker.environmentId),
      ...members.map((member) => member.environmentId),
    ]),
  ].filter(
    (environmentId) =>
      environmentId !== selfEnvironmentId && environmentId !== predecessorEnvironmentId,
  );
}

// --- routine run state in the scheduler's table ---------------------------------

/** The source's run state for the routines it sends. */
export const readRunStates = (projectId: ProjectId, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (ids.length === 0) return [];
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly task_id: string;
      readonly next_run_at: string | null;
      readonly last_run_at: string | null;
      readonly run_count: number;
      readonly once_generation: number | null;
    }>`
      SELECT task_id, next_run_at, last_run_at, run_count,
        json_extract(run_policy_json, '$.onceGeneration') AS once_generation
      FROM scheduled_tasks
      WHERE project_id = ${projectId}
    `;
    const wanted = new Set(ids);
    return rows
      .filter((row) => wanted.has(row.task_id))
      .map((row): RoutineRunState => ({
        id: row.task_id,
        nextRunAt: row.next_run_at,
        lastRunAt: row.last_run_at,
        runCount: Math.max(0, Math.trunc(row.run_count)),
        onceGeneration:
          typeof row.once_generation === "number" && row.once_generation > 0
            ? Math.trunc(row.once_generation)
            : 0,
      }));
  });

/**
 * Writes the source's run state onto the copies kept here, so an interval
 * routine the source ran recently waits out its interval. A routine running
 * here is left alone.
 */
export const writeRunStates = (projectId: ProjectId, states: ReadonlyArray<RoutineRunState>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.forEach(
      states,
      (state) =>
        state.onceGeneration > 0
          ? sql`
              UPDATE scheduled_tasks
              SET next_run_at = ${state.nextRunAt}, last_run_at = ${state.lastRunAt},
                run_count = ${state.runCount},
                run_policy_json = json_set(COALESCE(run_policy_json, '{}'), '$.onceGeneration', ${state.onceGeneration})
              WHERE task_id = ${state.id} AND project_id = ${projectId}
                AND last_run_status <> 'running'
            `
          : sql`
              UPDATE scheduled_tasks
              SET next_run_at = ${state.nextRunAt}, last_run_at = ${state.lastRunAt},
                run_count = ${state.runCount}
              WHERE task_id = ${state.id} AND project_id = ${projectId}
                AND last_run_status <> 'running'
            `,
      { concurrency: 1, discard: true },
    );
  });

// --- the service ----------------------------------------------------------------

export class CoordinatorPlannedHandover extends Context.Service<
  CoordinatorPlannedHandover,
  {
    /** On the coordinator: hands one project's coordinator to the target. Never fails. */
    readonly handOver: (input: AwayHandoverInput) => Effect.Effect<AwayHandoverResult>;
    /** On the target: the coordinator's request, from the handover route. */
    readonly receive: (
      caller: ReceiverCaller,
      request: PlannedHandoverRequest,
    ) => Effect.Effect<PlannedHandoverResponse, HandoverRefusal>;
  }
>()("specweave-studio/project/CoordinatorPlannedHandover") {}

const TERMINAL_WORKER_STATES = new Set(["stopped", "disposed"]);
const decodeResponse = Schema.decodeUnknownOption(PlannedHandoverResponse);
const encodeRequest = Schema.encodeSync(PlannedHandoverRequest);

export const make = Effect.gen(function* () {
  const link = yield* ProjectLink;
  const projects = yield* ProjectService.ProjectService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const peers = yield* HandoffPeers;
  const workers = yield* RemoteWorkerStore;
  const adoption = yield* RemoteWorkerAdoption;
  const routineCopies = Option.getOrUndefined(yield* Effect.serviceOption(RoutineCopies));
  const releaseGuard = Option.getOrUndefined(yield* Effect.serviceOption(CoordinatorReleaseGuard));
  const sql = Option.getOrUndefined(yield* Effect.serviceOption(SqlClient.SqlClient));
  const post: AwayPeerPost = yield* makeAwayPeerPost;
  const selfEnvironmentId = yield* environment.getEnvironmentId;

  const loadProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
  const withSql = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>, fallback: A) =>
    sql === undefined
      ? Effect.succeed(fallback)
      : effect.pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catchCause((cause) =>
            Effect.logWarning("Away handover could not read or write routine run state", {
              cause,
            }).pipe(Effect.as(fallback)),
          ),
        );

  const source = makePlannedHandover({
    loadProject,
    giveWay: link.plannedGiveWay,
    revert: link.plannedRevert,
    reachable: peers.reachable,
    labelOf: (environmentId) =>
      peers.target(environmentId).pipe(
        Effect.map((target) => target.label),
        Effect.orElseSucceed(() => "The other machine"),
      ),
    gather: (project, logicalProjectId) =>
      Effect.gen(function* () {
        const rows = yield* workers.list.pipe(Effect.orElseSucceed(() => []));
        const shadowWorkers = rows
          .filter((row) => row.projectId === project.id && !TERMINAL_WORKER_STATES.has(row.state))
          .map((row): CoordinatorStandbyShadowWorker => ({
            id: row.id,
            callerThreadId: row.callerThreadId,
            machineId: row.machineId,
            environmentId: row.environmentId,
            remoteProjectId: row.remoteProjectId,
            remoteThreadId: row.remoteThreadId,
            title: row.title,
            state: row.state,
            followedRunId: row.followedRunId,
            deliveredRunIds: row.deliveredRunIds.slice(-STANDBY_DELIVERED_RUN_IDS_MAX),
          }));
        if (routineCopies === undefined) return { shadowWorkers };
        const snapshot = yield* routineCopies
          .snapshot({ projectId: project.id, logicalProjectId })
          .pipe(Effect.orElseSucceed(() => null));
        if (snapshot === null) return { shadowWorkers };
        const runStates = yield* withSql(
          readRunStates(
            project.id,
            snapshot.routines.map((routine) => routine.id),
          ),
          [],
        );
        return { shadowWorkers, routines: snapshot.routines, runStates };
      }),
    send: (environmentId, request) =>
      post(environmentId, AWAY_HANDOVER_PATH, encodeRequest(request), HANDOVER_TIMEOUT_MS).pipe(
        Effect.flatMap((answer) => {
          const decoded = decodeResponse(answer.json);
          return Option.isSome(decoded)
            ? Effect.succeed(decoded.value)
            : Effect.fail(
                // It answered 2xx, so it may have taken over: in doubt, never a refusal.
                new AwayPeerError({
                  message: "The other machine sent an answer this version cannot read.",
                  refused: false,
                  uncertain: true,
                }),
              );
        }),
      ),
    ...(releaseGuard === undefined
      ? {}
      : {
          releaseStandby: (project: Project, successor: LogicalProjectMember) =>
            releaseGuard
              .releaseBefore({
                projectId: project.id,
                unless: successor,
                changeAnyway: true,
                reason: "away-handover",
              })
              .pipe(Effect.ignore),
        }),
    releaseWorkers: (project, reason) =>
      Effect.gen(function* () {
        const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        for (const row of yield* workers.list)
          if (
            row.projectId === project.id &&
            isProjectCoordinatorThreadId(row.callerThreadId, project) &&
            !TERMINAL_WORKER_STATES.has(row.state)
          )
            yield* workers.modify(row.id, (current) =>
              current === undefined
                ? undefined
                : { ...current, state: "stopped", lastError: reason, updatedAt: at },
            );
      }).pipe(Effect.ignore),
  });

  const target = makeHandoverReceiver({
    selfEnvironmentId,
    loadProject,
    takeover: link.plannedTakeover,
    ...(routineCopies === undefined
      ? {}
      : {
          keepRoutines: (input) =>
            routineCopies
              .replace(input)
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Away handover could not keep the routines", { cause }),
                ),
              ),
        }),
    applyRunStates: (projectId, states) => withSql(writeRunStates(projectId, states), undefined),
    adopt: adoption.adopt,
  });

  return CoordinatorPlannedHandover.of({ handOver: source.handOver, receive: target.receive });
});

export const layer = Layer.effect(CoordinatorPlannedHandover, make);
