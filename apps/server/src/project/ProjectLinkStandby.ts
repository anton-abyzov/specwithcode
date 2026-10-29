import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  logicalProjectMemberKey,
  type LogicalProjectMember,
  type Project,
  type ProjectAcceptStandbyInput,
  type ProjectAcceptStandbyResult,
  type ProjectCoordinatorBinding,
  type ProjectCoordinatorReplica,
  type ProjectId,
  type ProjectLinkError,
  type ProjectLinkNote,
  type ProjectLinkReplicateResult,
  type ProjectSetStandbyInput,
  type ProjectSetStandbyResult,
  type ProjectTakeoverResult,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { sha256 } from "../nodeCrypto.ts";
import type { ProjectOwnershipUpdate } from "../orchestration-v2/ProjectCommands.ts";
import type * as CoordinatorReplicas from "./CoordinatorReplicas.ts";
import type {
  CoordinatorStandbyRecord,
  CoordinatorStandbyStore,
} from "./CoordinatorStandbyStore.ts";
import { shouldTakeOver, type StandbyDecision } from "./CoordinatorStandbyWatch.ts";
import type * as ProjectAdmission from "./ProjectAdmission.ts";

/**
 * The linked-project half of automatic coordinator takeover, kept apart from
 * ProjectLink.ts for size. The owner arms it on both machines (`setStandby`
 * on the coordinator, `acceptStandby` on the standby); the coordinator pushes
 * its content (`replicateFromPeer`); the standby takes over by itself once its
 * clock says so (`autoTakeover`), under the same lock the lease handler holds.
 */

/** The content the coordinator pushes with `coordinator-replica`. */
export interface PeerReplicaContent {
  readonly digest: string;
  readonly goal: string;
  readonly instructions: string;
  readonly notes: ReadonlyArray<ProjectLinkNote>;
  readonly notesTruncated: boolean;
}

export interface ReplicateFromPeerInput {
  readonly logicalProjectId: string;
  /** The environment the caller's grant names as its coordinator. */
  readonly callerEnvironmentId: string;
  readonly epoch: number;
  readonly content: PeerReplicaContent;
}

export type AutoTakeoverOutcome =
  | { readonly outcome: "disarmed" }
  | {
      readonly outcome: "not-due";
      readonly reason: Extract<StandbyDecision, { fire: false }>["reason"];
    }
  | {
      readonly outcome: "taken-over";
      readonly result: ProjectTakeoverResult;
      /** When the coordinator changed the goal or instructions after the app's last copy. */
      readonly instructionsChangedAt: string | null;
    };

export interface ProjectLinkStandbyMethods {
  readonly setStandby: (
    input: ProjectSetStandbyInput,
  ) => Effect.Effect<ProjectSetStandbyResult, ProjectLinkError>;
  readonly acceptStandby: (
    input: ProjectAcceptStandbyInput,
  ) => Effect.Effect<ProjectAcceptStandbyResult, ProjectLinkError>;
  /** Internal: the registered coordinator's own copy of its content, for the lease route. */
  readonly replicateFromPeer: (
    input: ReplicateFromPeerInput,
  ) => Effect.Effect<ProjectLinkReplicateResult, ProjectLinkError>;
  /** Internal: takes over when the standby clock fires, re-reading it under the lock. */
  readonly autoTakeover: (input: {
    readonly logicalProjectId: string;
  }) => Effect.Effect<AutoTakeoverOutcome, ProjectLinkError>;
}

export interface ReleaseBeforeChangeInput {
  readonly projectId: ProjectId;
  /** No release when the standby leased to now is this member: it stays, or it is the one taking over. */
  readonly unless?: LogicalProjectMember | undefined;
  /** Release only when the standby leased to now is this member. */
  readonly onlyFor?: LogicalProjectMember | undefined;
  /** The owner chose Change anyway: an unanswered release is sent again later instead of refusing. */
  readonly changeAnyway: boolean;
  readonly reason: string;
}

/**
 * Before the owner turns automatic takeover off, changes the standby, unlinks
 * or supersedes this copy, the standby it leases to is released and answers.
 * Served by CoordinatorLease; kept here so ProjectLink's handlers need not
 * import the lease loop, which itself depends on ProjectLink.
 */
export class CoordinatorReleaseGuard extends Context.Service<
  CoordinatorReleaseGuard,
  {
    readonly releaseBefore: (
      input: ReleaseBeforeChangeInput,
    ) => Effect.Effect<void, ProjectLinkError>;
  }
>()("specweave-studio/project/ProjectLinkStandby/CoordinatorReleaseGuard") {}

/** `auto:` + 32 hex of the logical project + `:` + the new epoch; at most 128 characters. */
export function autoTakeoverOperationId(logicalProjectId: string, epoch: number): string {
  return `auto:${sha256([logicalProjectId]).toString("hex").slice(0, 32)}:${epoch}`;
}

/** Which goal and instructions a replica holds, without its notes. */
export function goalDigest(content: { readonly goal: string; readonly instructions: string }) {
  return sha256([JSON.stringify([content.goal, content.instructions])]).toString("hex");
}

const sameMember = (a: LogicalProjectMember, b: LogicalProjectMember) =>
  a.environmentId === b.environmentId &&
  a.projectId === b.projectId &&
  a.coordinatorThreadId === b.coordinatorThreadId;

export interface ProjectLinkStandbyDeps {
  readonly admission: ProjectAdmission.ProjectAdmission["Service"];
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
  readonly replicas: CoordinatorReplicas.CoordinatorReplicas["Service"];
  readonly store: CoordinatorStandbyStore["Service"];
  readonly fail: (
    code: ProjectLinkError["code"],
    detail?: string,
  ) => Effect.Effect<never, ProjectLinkError>;
  readonly load: (projectId: ProjectId) => Effect.Effect<Project, ProjectLinkError>;
  readonly refusePersonal: (project: Project) => Effect.Effect<void, ProjectLinkError>;
  readonly selfMember: (project: Project) => Effect.Effect<LogicalProjectMember>;
  readonly readReplica: (
    project: Project,
  ) => Effect.Effect<Option.Option<ProjectCoordinatorReplica>, ProjectLinkError>;
  readonly coordinatorContentDigest: (content: PeerReplicaContent) => string;
  readonly writeOwnership: (
    project: Project,
    commandPrefix: string,
    operationId: string,
    ownership: Omit<ProjectOwnershipUpdate, "expectedRevision">,
  ) => Effect.Effect<Project, ProjectLinkError>;
  readonly takeoverLocked: (input: {
    readonly projectId: ProjectId;
    readonly operationId: string;
    readonly knownEpoch: number;
    readonly predecessor: LogicalProjectMember;
    readonly epoch: number;
    readonly takenOverBy: "auto";
  }) => Effect.Effect<ProjectTakeoverResult, ProjectLinkError>;
}

export const makeProjectLinkStandby = (deps: ProjectLinkStandbyDeps): ProjectLinkStandbyMethods => {
  const { admission, environment, replicas, store, fail, load } = deps;
  const storeFailed = () => fail("storage_failed");
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const setStandby: ProjectLinkStandbyMethods["setStandby"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        yield* deps.refusePersonal(project);
        const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
        const identity = settings.logicalProject;
        const current: ProjectCoordinatorBinding = settings.coordinatorBinding ?? {
          epoch: 0,
          state: "active",
        };
        if (!identity) return yield* fail("not_linked");
        if (current.state === "transferring") return yield* fail("handoff_in_progress");
        if (current.state !== "active") return yield* fail("not_coordinator");
        const self = yield* deps.selfMember(project);
        const wanted = input.standby;
        let next: ProjectCoordinatorBinding;
        if (wanted === null) {
          if (current.standby === undefined) return { coordinatorBinding: current, replayed: true };
          const { standby: _standby, ...rest } = current;
          next = rest;
        } else {
          if (settings.archived) return yield* fail("archived");
          const listed = identity.members.find((member) => sameMember(member, wanted.member));
          if (
            listed === undefined ||
            logicalProjectMemberKey(listed) === logicalProjectMemberKey(self)
          )
            return yield* fail("invalid", "The standby is another member listed in this project.");
          const kept = current.standby;
          if (
            kept !== undefined &&
            sameMember(kept.member, listed) &&
            kept.afterMinutes === wanted.afterMinutes
          )
            return { coordinatorBinding: current, replayed: true };
          next = {
            ...current,
            standby: {
              member: listed,
              afterMinutes: wanted.afterMinutes,
              // The same standby with a new delay keeps when it was first enabled.
              enabledAt:
                kept !== undefined && sameMember(kept.member, listed)
                  ? kept.enabledAt
                  : yield* nowIso,
            },
          };
        }
        yield* deps.writeOwnership(project, "project-set-standby", input.operationId, {
          mode: "set-standby",
          logicalProject: identity,
          coordinatorBinding: next,
        });
        return { coordinatorBinding: next, replayed: false };
      }),
    );

  const acceptStandby: ProjectLinkStandbyMethods["acceptStandby"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
        const identity = settings.logicalProject;
        if (!identity || identity.id !== input.logicalProjectId) return yield* fail("not_linked");
        const held = yield* store.get(identity.id).pipe(Effect.catch(storeFailed));
        const wanted = input.standby;
        if (wanted === null) {
          if (held === undefined) return { standby: null, replayed: true };
          yield* store.modify(identity.id, () => null).pipe(Effect.catch(storeFailed));
          return { standby: null, replayed: false };
        }
        yield* deps.refusePersonal(project);
        const descriptor = yield* environment.getDescriptor;
        if (descriptor.capabilities.coordinatorStandby !== true)
          return yield* fail("invalid", "This machine cannot take over automatically. Update it.");
        const binding = settings.coordinatorBinding;
        if (binding?.state === "transferring") return yield* fail("handoff_in_progress");
        // An active copy runs its own coordinator; standing by for another would make two.
        if (binding?.state !== "transferred") return yield* fail("not_member");
        if (settings.archived) return yield* fail("archived");
        const self = yield* deps.selfMember(project);
        const coordinator = identity.members.find((member) =>
          sameMember(member, wanted.coordinator),
        );
        if (
          coordinator === undefined ||
          logicalProjectMemberKey(coordinator) === logicalProjectMemberKey(self)
        )
          return yield* fail("invalid", "The coordinator is another member listed here.");
        if (wanted.epoch < binding.epoch)
          return yield* fail(
            "superseded_conflict",
            "That coordinator epoch is older than this copy's.",
          );
        if (
          held !== undefined &&
          held.projectId === project.id &&
          sameMember(held.coordinator, coordinator) &&
          held.epoch === wanted.epoch &&
          held.afterMinutes === wanted.afterMinutes
        )
          return { standby: registration(held), replayed: true };
        const now = yield* Clock.currentTimeMillis;
        const at = DateTime.formatIso(DateTime.makeUnsafe(now));
        const keepsWatch =
          held !== undefined &&
          held.projectId === project.id &&
          sameMember(held.coordinator, coordinator) &&
          held.epoch === wanted.epoch;
        const record: CoordinatorStandbyRecord = keepsWatch
          ? { ...held, afterMinutes: wanted.afterMinutes, updatedAt: at }
          : {
              logicalProjectId: identity.id,
              projectId: project.id,
              coordinator,
              epoch: wanted.epoch,
              afterMinutes: wanted.afterMinutes,
              acceptedAt: at,
              lastLeaseAt: null,
              lastSeq: null,
              watchingSince: at,
              leaseSinceWatching: false,
              pausedUntil: null,
              coordinatorSleptAt: null,
              standbySleeping: false,
              armedFor: [],
              runningThreads: [],
              shadowWorkers: [],
              lastRefusal: null,
              updatedAt: at,
            };
        yield* store.modify(identity.id, () => record).pipe(Effect.catch(storeFailed));
        return { standby: registration(record), replayed: false };
      }),
    );

  const replicateFromPeer: ProjectLinkStandbyMethods["replicateFromPeer"] = (input) =>
    Effect.gen(function* () {
      const found = yield* store.get(input.logicalProjectId).pipe(Effect.catch(storeFailed));
      if (found === undefined) return yield* fail("not_member");
      return yield* admission.withLock(
        found.projectId as ProjectId,
        Effect.gen(function* () {
          const record = yield* store.get(input.logicalProjectId).pipe(Effect.catch(storeFailed));
          if (
            record === undefined ||
            record.coordinator.environmentId !== input.callerEnvironmentId ||
            record.epoch !== input.epoch
          )
            return yield* fail("not_member");
          const project = yield* load(record.projectId as ProjectId);
          const settings = project.workspaceSettings;
          if (
            settings?.logicalProject?.id !== record.logicalProjectId ||
            settings.coordinatorBinding?.state !== "transferred"
          )
            return yield* fail("not_member");
          if (deps.coordinatorContentDigest(input.content) !== input.content.digest)
            return yield* fail("invalid");
          const held = yield* deps.readReplica(project);
          if (
            Option.isSome(held) &&
            held.value.peer !== undefined &&
            held.value.digest === input.content.digest &&
            sameMember(held.value.from, record.coordinator)
          )
            return { replicatedAt: held.value.replicatedAt, replayed: true };
          const replicatedAt = yield* nowIso;
          // The baseline is the last copy the owner's app wrote; a peer's copies carry it on.
          const clientGoalDigest = Option.match(held, {
            onNone: () => null,
            onSome: (value) =>
              value.peer === undefined ? goalDigest(value) : value.peer.clientGoalDigest,
          });
          const changed =
            clientGoalDigest !== null && goalDigest(input.content) !== clientGoalDigest;
          const instructionsChangedAt = changed
            ? (Option.getOrUndefined(held)?.peer?.instructionsChangedAt ?? replicatedAt)
            : null;
          yield* replicas
            .write(project.id, {
              from: record.coordinator,
              logicalProjectId: record.logicalProjectId,
              digest: input.content.digest,
              replicatedAt,
              goal: input.content.goal,
              instructions: input.content.instructions,
              notes: [...input.content.notes],
              notesTruncated: input.content.notesTruncated,
              peer: { receivedAt: replicatedAt, clientGoalDigest, instructionsChangedAt },
            })
            .pipe(Effect.catch(storeFailed));
          return { replicatedAt, replayed: false };
        }),
      );
    });

  const autoTakeover: ProjectLinkStandbyMethods["autoTakeover"] = ({ logicalProjectId }) =>
    Effect.gen(function* () {
      const found = yield* store.get(logicalProjectId).pipe(Effect.catch(storeFailed));
      if (found === undefined) return { outcome: "disarmed" } as const;
      return yield* admission.withLock(
        found.projectId as ProjectId,
        Effect.gen(function* () {
          // Re-read under the lock: a lease that landed meanwhile resets the clock.
          const record = yield* store.get(logicalProjectId).pipe(Effect.catch(storeFailed));
          if (record === undefined) return { outcome: "disarmed" } as const;
          const project = yield* load(record.projectId as ProjectId);
          const binding = project.workspaceSettings?.coordinatorBinding;
          const changedAt = Effect.map(deps.readReplica(project), (replica) =>
            Option.match(replica, {
              onNone: () => null,
              onSome: (value) => value.peer?.instructionsChangedAt ?? null,
            }),
          );
          if (
            binding?.state === "active" &&
            binding.takenOverBy === "auto" &&
            binding.predecessor !== undefined &&
            sameMember(binding.predecessor, record.coordinator) &&
            binding.operationId !== undefined &&
            binding.operationId === autoTakeoverOperationId(logicalProjectId, binding.epoch) &&
            project.workspaceSettings?.logicalProject !== undefined
          )
            return {
              outcome: "taken-over",
              result: {
                operationId: binding.operationId,
                logicalProject: project.workspaceSettings.logicalProject,
                coordinatorBinding: binding,
                notesWritten: 0,
                replicaFrom: null,
                replayed: true,
              },
              instructionsChangedAt: yield* changedAt,
            } as const;
          const decision = shouldTakeOver(record, yield* Clock.currentTimeMillis);
          if (!decision.fire) return { outcome: "not-due", reason: decision.reason } as const;
          if (binding?.state !== "transferred")
            return yield* fail(
              binding?.state === "transferring" ? "handoff_in_progress" : "not_member",
            );
          // The epoch comes first; the operation is named by it, so a retry replays.
          const epoch = Math.max(binding.epoch, record.epoch) + 1;
          const instructionsChangedAt = yield* changedAt;
          const result = yield* deps.takeoverLocked({
            projectId: project.id,
            operationId: autoTakeoverOperationId(logicalProjectId, epoch),
            knownEpoch: record.epoch,
            predecessor: record.coordinator,
            epoch,
            takenOverBy: "auto",
          });
          return { outcome: "taken-over", result, instructionsChangedAt } as const;
        }),
      );
    });

  return { setStandby, acceptStandby, replicateFromPeer, autoTakeover };
};

function registration(record: CoordinatorStandbyRecord) {
  return {
    coordinator: record.coordinator,
    epoch: record.epoch,
    afterMinutes: record.afterMinutes,
    acceptedAt: record.acceptedAt,
  };
}
