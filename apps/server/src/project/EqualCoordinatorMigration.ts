/**
 * Equal coordinators. Every machine that has a project runs its own active
 * coordinator, and typing on a machine goes to that machine's coordinator.
 * Nothing makes a coordinator give way, takes one over or moves one.
 *
 * Before this, linking a second machine wrote `transferred` on the joining
 * copy, and only the one `active` copy could run a coordinator turn. This
 * module holds what changed:
 *
 * - `equalCoordinatorBinding`: what a binding from before becomes. `active`
 *   stays active, without its standby. `transferred` becomes active at the
 *   same epoch and follows no successor. `transferring` becomes active too,
 *   and its operation id is retired, so a late write under that operation
 *   never fences this copy again (`ownershipRejection`). Each keeps whether it
 *   was the one owner of the project's routines (`routineOwner`), so two
 *   machines never both fire a routine no runner is settled for.
 * - `joinedBinding`: what link acceptance writes on the joining copy.
 * - `migrate`: the one pass over this machine's projects, run when the server
 *   starts. It also clears what only ever held a coordinator back: standby
 *   records, re-arm consents and the "superseded" marks of peer sync. Holds on
 *   single threads (a thread handed to another machine) are not touched.
 * - `retiredRoleChange`: the refusal every retired entry point answers with.
 *   A peer on an older version that reconnects holding a superseding binding
 *   is refused each time it asks; it keeps its own coordinator, and so does
 *   this copy.
 *
 * Both coordinator conversations, each machine's own workers, the shared
 * identity and its member list stay exactly as they were.
 *
 * @module EqualCoordinatorMigration
 */
import {
  CommandId,
  coordinatorOwnsRoutines,
  MachineHandoffError,
  type MachineHandoffPrepareInput,
  type Project,
  type ProjectCoordinatorBinding,
  ProjectLinkError,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CoordinatorRearmStore } from "./CoordinatorRearmStore.ts";
import { CoordinatorStandbyStore } from "./CoordinatorStandbyStore.ts";
import { LinkedPeerSyncState } from "./LinkedPeerSyncState.ts";
import type { ProjectLinkStandbyMethods } from "./ProjectLinkStandby.ts";
import * as ProjectService from "./ProjectService.ts";

/** What a retired entry point says. */
export const EQUAL_COORDINATORS_DETAIL =
  "Every machine runs its own coordinator for this project. A coordinator no longer gives way, is taken over or moves to another machine.";

/** The most retired operation ids a binding remembers. */
const RETIRED_OPERATIONS_MAX = 16;

/**
 * The refusal of a retired role change. `superseded_conflict` is a code peer
 * sync takes as final for a takeover claimed against this copy
 * (`PERMANENT_GIVE_WAY_REFUSALS`), so the hold it put on this copy's
 * coordinator turns before asking is lifted at once.
 */
export const retiredRoleChange = (
  code: ProjectLinkError["code"] = "superseded_conflict",
): Effect.Effect<never, ProjectLinkError> =>
  Effect.fail(new ProjectLinkError({ code, detail: EQUAL_COORDINATORS_DETAIL }));

/** The standby and planned-move calls of `ProjectLink`, as equal coordinators answer them. */
export type RetiredStandbyMethods = Pick<
  ProjectLinkStandbyMethods,
  | "setStandby"
  | "acceptStandby"
  | "acceptStandbyFromPeer"
  | "rearmStandby"
  | "plannedGiveWay"
  | "plannedTakeover"
  | "awayTakeover"
>;

/**
 * Nobody stands by for, or takes over, a coordinator: every such call is refused. Turning a
 * standby off is the one exception, so a copy that still shows one can clear it.
 */
export const retiredStandbyMethods = (
  standby: Pick<ProjectLinkStandbyMethods, "setStandby">,
): RetiredStandbyMethods => {
  const retired = () => retiredRoleChange("invalid");
  return {
    setStandby: (input) => (input.standby === null ? standby.setStandby(input) : retired()),
    acceptStandby: retired,
    acceptStandbyFromPeer: retired,
    rearmStandby: retired,
    plannedGiveWay: retired,
    plannedTakeover: retired,
    awayTakeover: retired,
  };
};

/**
 * `machineHandoff.prepare` as a window may call it now. Publishing a handoff was the step
 * that relinquished this machine's coordinator; it is refused before a checkpoint is cut or
 * anything is pushed. Reading what a handoff would carry stays.
 */
export const withoutCoordinatorMove =
  <A, E, R>(prepare: (input: MachineHandoffPrepareInput) => Effect.Effect<A, E, R>) =>
  (input: MachineHandoffPrepareInput): Effect.Effect<A, E | MachineHandoffError, R> =>
    input.publish
      ? Effect.fail(new MachineHandoffError({ code: "conflict", detail: COORDINATOR_STAYS_DETAIL }))
      : prepare(input);

/** What a window is told when it asks to move a coordinator. */
export const COORDINATOR_STAYS_DETAIL =
  "Every machine runs its own coordinator now, so it is not moved. Files already copied stay where they are; hand off threads instead.";

/**
 * A link is made only between two machines that both keep their coordinator. The caller
 * says it checked the other end; one from before equal coordinators cannot say so, and is
 * refused before this copy writes anything (EC2-04).
 */
export const requireEqualPeer = (input: {
  readonly equalCoordinators?: true | undefined;
}): Effect.Effect<void, ProjectLinkError> =>
  input.equalCoordinators === true
    ? Effect.void
    : Effect.fail(new ProjectLinkError({ code: "needs_update" }));

/** Whether a binding is already an equal coordinator's: active, following and awaiting nobody. */
export function isEqualCoordinatorBinding(binding: ProjectCoordinatorBinding | undefined): boolean {
  return (
    binding === undefined ||
    (binding.state === "active" &&
      binding.successor === undefined &&
      binding.predecessor === undefined &&
      binding.standby === undefined &&
      binding.takenOverAt === undefined &&
      binding.takenOverBy === undefined)
  );
}

/**
 * Whether another machine may believe it coordinates this project too. A copy that armed a
 * standby cannot know the standby did not take over while it was away, and a copy that took
 * over cannot know the one it replaced ever heard. Neither is the routines' one owner: both
 * hold them until the machines settle a runner (AC-45).
 */
export function takeoverUnsettled(binding: ProjectCoordinatorBinding): boolean {
  return (
    binding.standby !== undefined ||
    binding.takenOverAt !== undefined ||
    binding.takenOverBy !== undefined
  );
}

/** The binding of an equal coordinator, from whatever a copy held before. */
export function equalCoordinatorBinding(
  binding: ProjectCoordinatorBinding | undefined,
): ProjectCoordinatorBinding {
  if (binding === undefined) return { epoch: 0, state: "active" };
  // An operation that was moving the coordinator ends here; one that finished is only history.
  const open = binding.state === "transferring" ? binding.operationId : undefined;
  const retired = [
    ...new Set([...(binding.retiredOperationIds ?? []), ...(open === undefined ? [] : [open])]),
  ].slice(-RETIRED_OPERATIONS_MAX);
  return {
    epoch: binding.epoch,
    state: "active",
    ...(binding.operationId !== undefined && open === undefined
      ? { operationId: binding.operationId }
      : {}),
    ...(binding.removedMembers === undefined ? {} : { removedMembers: binding.removedMembers }),
    ...(retired.length === 0 ? {} : { retiredOperationIds: retired }),
    // Read before the binding loses what said so: a copy that followed another machine, or
    // was moving, never becomes a second owner of the project's routines.
    routineOwner: coordinatorOwnsRoutines(binding) && !takeoverUnsettled(binding),
  };
}

/** What link acceptance writes on the joining copy: its own coordinator, at the kept epoch. */
export function joinedBinding(operationId: string, epoch: number): ProjectCoordinatorBinding {
  // The project's routines already have their owner on the machine this copy joins.
  return { epoch, state: "active", operationId, routineOwner: false };
}

/** Whether a joining copy already holds the binding `joinedBinding` wrote for this link. */
export function joinedBy(
  binding: ProjectCoordinatorBinding | undefined,
  operationId: string,
): boolean {
  return binding?.state === "active" && binding.operationId === operationId;
}

export interface EqualCoordinatorMigrationReport {
  /** Linked copies whose binding was rewritten, with the state each had. */
  readonly migrated: ReadonlyArray<{
    readonly projectId: string;
    readonly from: ProjectCoordinatorBinding["state"];
    readonly retiredOperationId: string | null;
  }>;
  /** Copies whose write was refused or failed; the next start tries again. */
  readonly failed: ReadonlyArray<string>;
  readonly standbyRecordsCleared: number;
  readonly rearmEntriesCleared: number;
}

/** One project: writes the equal binding when the copy does not hold one yet. */
const migrateProject = (projects: ProjectService.ProjectService["Service"], project: Project) =>
  Effect.gen(function* () {
    const settings = project.workspaceSettings;
    const identity = settings?.logicalProject;
    const binding = settings?.coordinatorBinding;
    if (
      identity === undefined ||
      binding === undefined ||
      project.deletedAt !== null ||
      isPersonalAssistantProject(project) ||
      isEqualCoordinatorBinding(binding)
    )
      return null;
    const next = equalCoordinatorBinding(binding);
    const revision = settings?.revision ?? 0;
    yield* projects.update({
      projectId: project.id,
      // Named by the project and what it replaces, so a second start replays instead of
      // writing twice, and two projects at the same epoch and revision never share a receipt.
      commandId: CommandId.make(
        `project-equal-coordinators:${project.id}:${binding.state}:${binding.epoch}:${revision}`,
      ),
      ownership: {
        mode: "equal-coordinators",
        expectedRevision: revision,
        logicalProject: identity,
        coordinatorBinding: next,
      },
    });
    return {
      projectId: project.id as string,
      from: binding.state,
      retiredOperationId:
        binding.state === "transferring" ? (binding.operationId ?? null) : null,
    };
  });

/**
 * The migration, over `projects` (this machine's own). Safe to run at every
 * start: a copy that is already equal is left alone. It never fails; what
 * could not be written is reported and tried again at the next start.
 */
export const migrate = (
  projects: ReadonlyArray<Project>,
): Effect.Effect<
  EqualCoordinatorMigrationReport,
  never,
  ProjectService.ProjectService
> =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    // The stores are the runtime's; a server built without one has nothing of it to clear.
    const standby = Option.getOrUndefined(yield* Effect.serviceOption(CoordinatorStandbyStore));
    const rearm = Option.getOrUndefined(yield* Effect.serviceOption(CoordinatorRearmStore));
    const syncState = yield* Effect.serviceOption(LinkedPeerSyncState);
    const migrated: Array<EqualCoordinatorMigrationReport["migrated"][number]> = [];
    const failed: string[] = [];
    for (const project of projects) {
      const outcome = yield* migrateProject(service, project).pipe(Effect.option);
      if (Option.isNone(outcome)) failed.push(project.id);
      else if (outcome.value !== null) migrated.push(outcome.value);
      // The mark that kept a superseded copy's coordinator from starting a turn.
      if (Option.isSome(syncState))
        yield* syncState.value.clearSuperseded(project.id).pipe(Effect.ignore);
    }
    // Coordinator-only holds: nobody stands by for, or is re-armed behind, a coordinator now.
    const armed =
      standby === undefined ? [] : yield* standby.list.pipe(Effect.orElseSucceed(() => []));
    let standbyRecordsCleared = 0;
    for (const record of armed) {
      const cleared = yield* standby!.modify(record.logicalProjectId, () => null).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (cleared) standbyRecordsCleared += 1;
    }
    const consents =
      rearm === undefined ? [] : yield* rearm.list.pipe(Effect.orElseSucceed(() => []));
    let rearmEntriesCleared = 0;
    for (const entry of consents) {
      const cleared = yield* rearm!.modify(entry.logicalProjectId, () => null).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (cleared) rearmEntriesCleared += 1;
    }
    const report = { migrated, failed, standbyRecordsCleared, rearmEntriesCleared };
    if (migrated.length + failed.length + standbyRecordsCleared + rearmEntriesCleared > 0)
      yield* Effect.logInfo("Coordinators made equal", {
        migrated: migrated.length,
        failed: failed.length,
        standbyRecordsCleared,
        rearmEntriesCleared,
      });
    return report;
  });

/** Runs the migration over every project of this machine when the server starts. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    const snapshot = yield* service.snapshot.pipe(Effect.option);
    if (Option.isNone(snapshot)) {
      yield* Effect.logWarning("Could not list projects to make their coordinators equal");
      return;
    }
    yield* migrate(snapshot.value.projects);
  }),
);
