import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  logicalProjectMemberKey,
  type CoordinatorStandbyAfterMinutes,
  type LogicalProject,
  type LogicalProjectMember,
  type Project,
  type ProjectAcceptStandbyInput,
  type ProjectAcceptStandbyResult,
  type ProjectCoordinatorBinding,
  type CoordinatorRoutineCopy,
  type ProjectCoordinatorReplica,
  type ProjectId,
  type ProjectLinkError,
  type ProjectLinkNote,
  type ProjectLinkReplicateResult,
  type ProjectSetStandbyInput,
  type ProjectSetStandbyResult,
  type ProjectStandbyRearmStatus,
  type ProjectTakeoverResult,
  type StandbyRearmConsent,
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
import type { CoordinatorRearmStore } from "./CoordinatorRearmStore.ts";
import type { CoordinatorRoleShape } from "./CoordinatorRole.ts";
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
  /**
   * The coordinator's routines and their `coordinatorRoutinesDigest`, both
   * absent from a coordinator that predates routine copies. Not in `digest`,
   * so a standby that predates them still accepts the rest.
   */
  readonly routines?: ReadonlyArray<CoordinatorRoutineCopy> | undefined;
  readonly routinesDigest?: string | undefined;
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
  /**
   * Internal: a coordinator that took over automatically registers this
   * machine as its standby, through `studio_coordinator_claim_epoch`. Only
   * under the owner's re-arm consent on this machine, naming the same chain
   * and the caller, at or above the consent's epoch.
   */
  readonly acceptStandbyFromPeer: (
    input: AcceptStandbyFromPeerInput,
  ) => Effect.Effect<ProjectAcceptStandbyResult, ProjectLinkError>;
  /** Internal: takes over when the standby clock fires, re-reading it under the lock. */
  readonly autoTakeover: (input: {
    readonly logicalProjectId: string;
    /** A newer active coordinator another member reported; the registration is spent then. */
    readonly knownHigherEpoch?: number | undefined;
  }) => Effect.Effect<AutoTakeoverOutcome, ProjectLinkError>;
  /**
   * Internal: the coordinator that took over automatically names or clears
   * its own standby while re-arming (CoordinatorStandbyRearm), only at the
   * epoch it took over at and never over the owner's choice.
   */
  readonly rearmStandby: (
    input: RearmStandbyInput,
  ) => Effect.Effect<ProjectSetStandbyResult, ProjectLinkError>;
  /** This machine's re-arm consent and run for a copy, for `projectLink.syncStatus`. */
  readonly rearmStatus: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectStandbyRearmStatus | undefined>;
  /**
   * Internal, Away mode on the coordinator: this active copy gives way to the
   * member on `successorEnvironmentId` before that member takes over, so the
   * two are never active together. Replays for the same operation.
   */
  readonly plannedGiveWay: (
    input: PlannedGiveWayInput,
  ) => Effect.Effect<PlannedGiveWayResult, ProjectLinkError>;
  /**
   * Internal: the member refused the planned takeover, so this copy, which
   * gave way for `operationId` and is still not replaced, coordinates again.
   */
  readonly plannedRevert: (input: {
    readonly projectId: ProjectId;
    readonly operationId: string;
  }) => Effect.Effect<{ readonly coordinatorBinding: ProjectCoordinatorBinding }, ProjectLinkError>;
  /**
   * Internal, Away mode on the target: takes over from the coordinator that
   * asked (its work grant names it) at the epoch it gave way at. Replays for
   * the same operation.
   */
  readonly plannedTakeover: (
    input: PlannedTakeoverInput,
  ) => Effect.Effect<ProjectTakeoverResult, ProjectLinkError>;
  /**
   * Internal, Away mode on the target: the source recorded an away intent and
   * its grace ran out, so this copy takes over from it without its answer,
   * like an armed standby. Spent when another copy coordinates past it.
   */
  readonly awayTakeover: (input: {
    readonly projectId: ProjectId;
    readonly sourceEnvironmentId: string;
  }) => Effect.Effect<ProjectTakeoverResult, ProjectLinkError>;
}

export interface PlannedGiveWayInput {
  readonly projectId: ProjectId;
  readonly operationId: string;
  readonly successorEnvironmentId: string;
}

export interface PlannedGiveWayResult {
  /** This copy's binding after it gave way: `transferred` at the new epoch. */
  readonly coordinatorBinding: ProjectCoordinatorBinding;
  readonly logicalProjectId: string;
  readonly self: LogicalProjectMember;
  readonly successor: LogicalProjectMember;
  readonly replayed: boolean;
}

export interface PlannedTakeoverInput {
  readonly projectId: ProjectId;
  readonly logicalProjectId: string;
  /** The environment the caller's work grant names. */
  readonly callerEnvironmentId: string;
  /** The coordinator that gave way, as it lists itself. */
  readonly predecessor: LogicalProjectMember;
  readonly epoch: number;
  readonly operationId: string;
}

/** `handover:` + 32 hex of the logical project + `:` + the new epoch. */
export function plannedHandoverOperationId(logicalProjectId: string, epoch: number): string {
  return `handover:${sha256([logicalProjectId]).toString("hex").slice(0, 32)}:${epoch}`;
}

/** `away:` + 32 hex of the logical project + `:` + the new epoch. */
export function awayTakeoverOperationId(logicalProjectId: string, epoch: number): string {
  return `away:${sha256([logicalProjectId]).toString("hex").slice(0, 32)}:${epoch}`;
}

/** The start-coordinator operation that undoes a refused planned give-way. */
export function plannedRevertOperationId(operationId: string): string {
  return `revert:${sha256([operationId]).toString("hex").slice(0, 40)}`;
}

export interface RearmStandbyInput {
  readonly projectId: ProjectId;
  readonly logicalProjectId: string;
  /** The epoch this copy took over at; any other refuses. */
  readonly epoch: number;
  readonly operationId: string;
  /** Null clears the standby, only while it is still `expect`. */
  readonly standby: {
    readonly member: LogicalProjectMember;
    readonly afterMinutes: CoordinatorStandbyAfterMinutes;
  } | null;
  readonly expect?: LogicalProjectMember | undefined;
}

/** The detail of a re-arm refused because the owner chose another standby, or none. */
export const REARM_OWNER_CHOSE = "The owner chose the standby here.";

export interface AcceptStandbyFromPeerInput {
  readonly logicalProjectId: string;
  /** The environment the caller's work grant names; the registered coordinator is its listed copy. */
  readonly callerEnvironmentId: string;
  readonly epoch: number;
  readonly chainId: string;
}

/** The detail of a peer registration refused for want of a matching consent. */
export const PEER_ARM_NO_CONSENT = "no_consent";
/** The detail of a registration refused because this server cannot stand by. */
export const STANDBY_CAPABILITY_REFUSAL = "This machine cannot take over automatically. Update it.";

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

const sameMember = (a: LogicalProjectMember, b: LogicalProjectMember) =>
  a.environmentId === b.environmentId &&
  a.projectId === b.projectId &&
  a.coordinatorThreadId === b.coordinatorThreadId;

/** `auto:` + 32 hex of the logical project + `:` + the new epoch; at most 128 characters. */
export function autoTakeoverOperationId(logicalProjectId: string, epoch: number): string {
  return `auto:${sha256([logicalProjectId]).toString("hex").slice(0, 32)}:${epoch}`;
}

/** Which goal and instructions a replica holds, without its notes. */
export function goalDigest(content: { readonly goal: string; readonly instructions: string }) {
  return sha256([JSON.stringify([content.goal, content.instructions])]).toString("hex");
}

/**
 * How a copy a peer pushed is marked: the baseline is the last copy the
 * owner's app wrote, and a peer's copies carry it on, so a takeover can say
 * the goal or instructions changed since the owner's app last saw them.
 */
/**
 * The routines digest a replica write keeps: the held copy's, while it came
 * from the same member. Only the coordinator's lease loop sends routines; the
 * app's and the server-driven copies carry none, and must not make the
 * standby ask for them again.
 */
export function keptRoutinesDigest(
  held: Option.Option<ProjectCoordinatorReplica>,
  from: LogicalProjectMember,
): { readonly routinesDigest?: string } {
  if (Option.isNone(held) || held.value.routinesDigest === undefined) return {};
  return sameMember(held.value.from, from) ? { routinesDigest: held.value.routinesDigest } : {};
}

export function peerReplicaMark(
  held: Option.Option<ProjectCoordinatorReplica>,
  content: { readonly goal: string; readonly instructions: string },
  replicatedAt: string,
): NonNullable<ProjectCoordinatorReplica["peer"]> {
  const clientGoalDigest = Option.match(held, {
    onNone: () => null,
    onSome: (value) => (value.peer === undefined ? goalDigest(value) : value.peer.clientGoalDigest),
  });
  const changed = clientGoalDigest !== null && goalDigest(content) !== clientGoalDigest;
  const instructionsChangedAt = changed
    ? (Option.getOrUndefined(held)?.peer?.instructionsChangedAt ?? replicatedAt)
    : null;
  return { receivedAt: replicatedAt, clientGoalDigest, instructionsChangedAt };
}

export interface ProjectLinkStandbyDeps {
  readonly admission: ProjectAdmission.ProjectAdmission["Service"];
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
  readonly replicas: CoordinatorReplicas.CoordinatorReplicas["Service"];
  readonly store: CoordinatorStandbyStore["Service"];
  readonly rearmStore: CoordinatorRearmStore["Service"];
  /** The coordinator epoch claimed on this machine for a project (WorkerEpochStore); undefined when unread. */
  readonly claimedEpoch?: (
    logicalProjectId: string,
  ) => Effect.Effect<{ readonly epoch: number; readonly claimedBy: string } | undefined>;
  /** Why team rules stop machines working together here, or null. */
  readonly teamRulesRefusal?: Effect.Effect<string | null>;
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
  /**
   * Keeps the coordinator's routines as this copy's own (RoutineCopies);
   * absent when this server has no scheduler, so routines are not kept.
   */
  readonly keepRoutines?:
    | ((input: {
        readonly projectId: ProjectId;
        readonly logicalProjectId: string;
        readonly routines: ReadonlyArray<CoordinatorRoutineCopy>;
      }) => Effect.Effect<void, ProjectLinkError>)
    | undefined;
  /** Publishes this machine's coordinator role changes (CoordinatorRole). */
  readonly publishRole: CoordinatorRoleShape["publish"];
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
    readonly takenOverBy: "auto" | "person";
  }) => Effect.Effect<ProjectTakeoverResult, ProjectLinkError>;
  /**
   * Asks the copy this one gave way to for its member list and adopts it,
   * outside the project lock; never fails. Absent when nothing can ask.
   */
  readonly refreshMembers?: ((projectId: ProjectId) => Effect.Effect<void>) | undefined;
}

export const makeProjectLinkStandby = (deps: ProjectLinkStandbyDeps): ProjectLinkStandbyMethods => {
  const { admission, environment, replicas, store, rearmStore, fail, load } = deps;
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

  /**
   * Registers `wanted.coordinator` as the coordinator this machine stands by
   * for, under the project lock the caller holds. Shared by the owner's
   * `acceptStandby` and a peer's re-arm; neither may replace a registration
   * for a newer coordinator, nor one at the same epoch for another.
   */
  const acceptLocked = (
    project: Project,
    identity: LogicalProject,
    wanted: {
      readonly coordinator: LogicalProjectMember;
      readonly epoch: number;
      readonly afterMinutes: CoordinatorStandbyAfterMinutes;
    },
    armedBy: NonNullable<CoordinatorStandbyRecord["armedBy"]>,
  ) =>
    Effect.gen(function* () {
      const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
      yield* deps.refusePersonal(project);
      const descriptor = yield* environment.getDescriptor;
      if (descriptor.capabilities.coordinatorStandby !== true)
        return yield* fail("invalid", STANDBY_CAPABILITY_REFUSAL);
      const binding = settings.coordinatorBinding;
      if (binding?.state === "transferring") return yield* fail("handoff_in_progress");
      // An active copy runs its own coordinator; standing by for another would make two.
      if (binding?.state !== "transferred") return yield* fail("not_member");
      if (settings.archived) return yield* fail("archived");
      const self = yield* deps.selfMember(project);
      const coordinator = identity.members.find((member) => sameMember(member, wanted.coordinator));
      if (
        coordinator === undefined ||
        logicalProjectMemberKey(coordinator) === logicalProjectMemberKey(self)
      )
        return yield* fail("invalid", "The coordinator is another member listed here.");
      // At this copy's own epoch only the successor it gave way to coordinates.
      const otherSuccessor =
        binding.successor !== undefined &&
        logicalProjectMemberKey(binding.successor) !== logicalProjectMemberKey(coordinator);
      if (wanted.epoch < binding.epoch || (otherSuccessor && wanted.epoch === binding.epoch))
        return yield* fail(
          "superseded_conflict",
          "That coordinator epoch is older than this copy's.",
        );
      const found = yield* store.get(identity.id).pipe(Effect.catch(storeFailed));
      const held = found !== undefined && found.projectId === project.id ? found : undefined;
      const sameRegistration =
        held !== undefined &&
        sameMember(held.coordinator, coordinator) &&
        held.epoch === wanted.epoch;
      // Registrations only move forward, whoever asks.
      if (
        held !== undefined &&
        !sameRegistration &&
        (held.epoch > wanted.epoch ||
          (held.epoch === wanted.epoch && !sameMember(held.coordinator, coordinator)))
      )
        return yield* fail(
          "superseded_conflict",
          "This machine already stands by for a newer coordinator.",
        );
      // The owner's own registration wins over a peer's; a peer's never replaces the owner's
      // mark. A record from before re-arm has none, and the owner registered it.
      const nextArmedBy: NonNullable<CoordinatorStandbyRecord["armedBy"]> =
        sameRegistration && armedBy.kind === "peer" ? (held.armedBy ?? { kind: "owner" }) : armedBy;
      if (
        sameRegistration &&
        held.afterMinutes === wanted.afterMinutes &&
        (held.armedBy?.kind ?? "owner") === nextArmedBy.kind
      )
        return { standby: registration(held), replayed: true };
      const now = yield* Clock.currentTimeMillis;
      const at = DateTime.formatIso(DateTime.makeUnsafe(now));
      const record: CoordinatorStandbyRecord = sameRegistration
        ? { ...held, afterMinutes: wanted.afterMinutes, armedBy: nextArmedBy, updatedAt: at }
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
            armedBy,
          };
      yield* store.modify(identity.id, () => record).pipe(Effect.catch(storeFailed));
      yield* deps.publishRole({
        kind: "standby-armed",
        projectId: project.id,
        logicalProjectId: identity.id,
        coordinator,
        epoch: record.epoch,
        afterMinutes: record.afterMinutes,
      });
      return { standby: registration(record), replayed: false };
    });

  /** Writes or removes the owner's re-arm consent on this machine, under the project lock. */
  const writeConsent = (
    project: Project,
    identity: LogicalProject,
    consent: StandbyRearmConsent | null,
  ) =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      if (consent === null) {
        yield* rearmStore
          .modify(identity.id, (current) =>
            current === undefined || current.consent === null
              ? undefined
              : current.run === null
                ? null
                : { ...current, consent: null, consentUpdatedAt: at },
          )
          .pipe(Effect.catch(storeFailed));
        return null;
      }
      yield* deps.refusePersonal(project);
      const self = yield* deps.selfMember(project);
      const keys = consent.members.map(logicalProjectMemberKey);
      const listed = new Set(identity.members.map(logicalProjectMemberKey));
      if (new Set(keys).size !== keys.length)
        return yield* fail("invalid", "A machine is listed twice for re-arming.");
      if (!keys.every((key) => listed.has(key)))
        return yield* fail("invalid", "Every machine to re-arm is a member of this project.");
      if (!keys.includes(logicalProjectMemberKey(self)))
        return yield* fail("invalid", "This machine is not in the re-arm list it was sent.");
      yield* rearmStore
        .modify(identity.id, (current) => {
          const same =
            current !== undefined &&
            current.projectId === project.id &&
            current.consent !== null &&
            JSON.stringify(current.consent) === JSON.stringify(consent);
          return same
            ? undefined
            : {
                logicalProjectId: identity.id,
                projectId: project.id,
                consent,
                consentUpdatedAt: at,
                run: current?.projectId === project.id ? current.run : null,
              };
        })
        .pipe(Effect.catch(storeFailed));
      return { chainId: consent.chainId };
    });

  /**
   * A consent may name a machine linked after this copy joined: this copy
   * asks its coordinator for the current list first, outside the lock.
   */
  const refreshForConsent = (input: Parameters<ProjectLinkStandbyMethods["acceptStandby"]>[0]) =>
    Effect.gen(function* () {
      const refresh = deps.refreshMembers;
      if (refresh === undefined || input.rearm === undefined || input.rearm === null) return;
      const project = yield* load(input.projectId).pipe(Effect.option);
      if (Option.isNone(project)) return;
      const settings = project.value.workspaceSettings;
      if (settings?.coordinatorBinding?.state !== "transferred") return;
      const listed = new Set((settings.logicalProject?.members ?? []).map(logicalProjectMemberKey));
      if (input.rearm.members.every((member) => listed.has(logicalProjectMemberKey(member))))
        return;
      yield* refresh(input.projectId);
    });

  const acceptStandby: ProjectLinkStandbyMethods["acceptStandby"] = (input) =>
    refreshForConsent(input).pipe(Effect.andThen(acceptStandbyLocked(input)));

  const acceptStandbyLocked = (input: Parameters<ProjectLinkStandbyMethods["acceptStandby"]>[0]) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
        const identity = settings.logicalProject;
        if (!identity || identity.id !== input.logicalProjectId) return yield* fail("not_linked");
        if (input.standby === undefined && input.rearm === undefined)
          return yield* fail("invalid", "Give a standby, a re-arm consent, or both.");
        // The consent comes first, so a standby it names is armed with the list in place.
        const rearm =
          input.rearm === undefined
            ? {}
            : { rearm: yield* writeConsent(project, identity, input.rearm) };
        const held = yield* store.get(identity.id).pipe(Effect.catch(storeFailed));
        const wanted = input.standby;
        if (wanted === undefined)
          return {
            standby:
              held !== undefined && held.projectId === project.id ? registration(held) : null,
            replayed: true,
            ...rearm,
          };
        if (wanted === null) {
          if (held === undefined) return { standby: null, replayed: true, ...rearm };
          // Another member took over as a person at `belowEpoch`: only an older registration is spent.
          if (input.belowEpoch !== undefined && held.epoch >= input.belowEpoch)
            return { standby: registration(held), replayed: true, ...rearm };
          yield* store.modify(identity.id, () => null).pipe(Effect.catch(storeFailed));
          yield* deps.publishRole({
            kind: "standby-released",
            projectId: project.id,
            logicalProjectId: identity.id,
            reason: input.belowEpoch === undefined ? "turned-off" : "outdated",
          });
          return { standby: null, replayed: false, ...rearm };
        }
        const accepted = yield* acceptLocked(project, identity, wanted, { kind: "owner" });
        return { ...accepted, ...rearm };
      }),
    );

  const acceptStandbyFromPeer: ProjectLinkStandbyMethods["acceptStandbyFromPeer"] = (input) =>
    Effect.gen(function* () {
      const noConsent = () => fail("not_member", PEER_ARM_NO_CONSENT);
      const found = yield* rearmStore.get(input.logicalProjectId).pipe(Effect.catch(storeFailed));
      if (found === undefined) return yield* noConsent();
      return yield* admission.withLock(
        found.projectId as ProjectId,
        Effect.gen(function* () {
          if (deps.teamRulesRefusal !== undefined) {
            const refused = yield* deps.teamRulesRefusal;
            if (refused !== null) return yield* fail("invalid", refused);
          }
          const entry = yield* rearmStore
            .get(input.logicalProjectId)
            .pipe(Effect.catch(storeFailed));
          const consent = entry?.consent ?? null;
          if (entry === undefined || consent === null || consent.chainId !== input.chainId)
            return yield* noConsent();
          const project = yield* load(entry.projectId as ProjectId);
          const identity = project.workspaceSettings?.logicalProject;
          if (identity === undefined || identity.id !== input.logicalProjectId)
            return yield* fail("not_linked");
          // Who is calling comes from its work grant only, never from the request.
          const callers = identity.members.filter(
            (member) => member.environmentId === input.callerEnvironmentId,
          );
          const caller = callers.length === 1 ? callers[0] : undefined;
          if (caller === undefined)
            return yield* fail("invalid", "The caller is not one listed copy of this project.");
          if (
            !consent.members.some(
              (member) => logicalProjectMemberKey(member) === logicalProjectMemberKey(caller),
            )
          )
            return yield* noConsent();
          if (input.epoch < consent.fromEpoch)
            return yield* fail(
              "superseded_conflict",
              "That coordinator epoch is older than the owner's re-arm list.",
            );
          return yield* acceptLocked(
            project,
            identity,
            // The delay is always the owner's, never the caller's.
            { coordinator: caller, epoch: input.epoch, afterMinutes: consent.afterMinutes },
            { kind: "peer", chainId: input.chainId },
          );
        }),
      );
    });

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
          // A server without a scheduler records the digest all the same, so
          // the coordinator does not send the same routines on every lease.
          const routines =
            input.content.routines !== undefined && input.content.routinesDigest !== undefined
              ? { list: input.content.routines, digest: input.content.routinesDigest }
              : null;
          if (
            Option.isSome(held) &&
            held.value.peer !== undefined &&
            held.value.digest === input.content.digest &&
            sameMember(held.value.from, record.coordinator) &&
            (routines === null || held.value.routinesDigest === routines.digest)
          )
            return { replicatedAt: held.value.replicatedAt, replayed: true };
          // Kept before the replica records their digest: a failure here is
          // answered, and the coordinator sends them again on its next lease.
          if (routines !== null && deps.keepRoutines !== undefined)
            yield* deps.keepRoutines({
              projectId: project.id,
              logicalProjectId: record.logicalProjectId,
              routines: routines.list,
            });
          const replicatedAt = yield* nowIso;
          yield* replicas
            .write(project.id, {
              from: record.coordinator,
              logicalProjectId: record.logicalProjectId,
              digest: input.content.digest,
              fromEpoch: record.epoch,
              replicatedAt,
              goal: input.content.goal,
              instructions: input.content.instructions,
              notes: [...input.content.notes],
              notesTruncated: input.content.notesTruncated,
              ...(routines !== null
                ? { routinesDigest: routines.digest }
                : keptRoutinesDigest(held, record.coordinator)),
              peer: peerReplicaMark(held, input.content, replicatedAt),
            })
            .pipe(Effect.catch(storeFailed));
          return { replicatedAt, replayed: false };
        }),
      );
    });

  const autoTakeover: ProjectLinkStandbyMethods["autoTakeover"] = ({
    logicalProjectId,
    knownHigherEpoch,
  }) =>
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
          const spend = Effect.gen(function* () {
            yield* store
              .modify(logicalProjectId, (current) =>
                current !== undefined &&
                current.epoch === record.epoch &&
                current.acceptedAt === record.acceptedAt
                  ? null
                  : undefined,
              )
              .pipe(Effect.catch(storeFailed));
            yield* deps.publishRole({
              kind: "standby-released",
              projectId: project.id,
              logicalProjectId,
              reason: "outdated",
            });
            return { outcome: "disarmed" } as const;
          });
          // A binding past the registration's epoch means this copy already took over
          // or was handed past that coordinator; an active copy (or one unlinked since)
          // coordinates itself. Either way the registration is spent: firing on it
          // would take the project from whoever coordinates now, and it would only fail
          // here on every later round.
          if (
            (binding?.epoch ?? 0) > record.epoch ||
            binding === undefined ||
            binding.state === "active" ||
            project.workspaceSettings?.logicalProject?.id !== logicalProjectId
          )
            return yield* spend;
          const decision = shouldTakeOver(record, yield* Clock.currentTimeMillis);
          if (!decision.fire) return { outcome: "not-due", reason: decision.reason } as const;
          if (binding?.state !== "transferred")
            return yield* fail(
              binding?.state === "transferring" ? "handoff_in_progress" : "not_member",
            );
          // The epoch comes first; the operation is named by it, so a retry replays.
          const epoch = Math.max(binding.epoch, record.epoch) + 1;
          // Another machine already coordinates at that epoch or above: it claimed it
          // here after its own takeover, or a member reported it. Firing would make two.
          const claim =
            deps.claimedEpoch === undefined
              ? undefined
              : yield* deps.claimedEpoch(logicalProjectId);
          const selfEnvironmentId = yield* environment.getEnvironmentId;
          if (
            (claim !== undefined &&
              claim.claimedBy !== selfEnvironmentId &&
              claim.epoch >= epoch) ||
            (knownHigherEpoch !== undefined && knownHigherEpoch > record.epoch)
          )
            return yield* spend;
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

  const rearmStandby: ProjectLinkStandbyMethods["rearmStandby"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
        const identity = settings.logicalProject;
        const current = settings.coordinatorBinding;
        if (!identity || identity.id !== input.logicalProjectId) return yield* fail("not_linked");
        if (current?.state === "transferring") return yield* fail("handoff_in_progress");
        if (current?.state !== "active") return yield* fail("not_coordinator");
        // Only the copy that took over automatically at exactly this epoch re-arms.
        if (
          current.epoch !== input.epoch ||
          current.takenOverBy !== "auto" ||
          current.operationId !== autoTakeoverOperationId(identity.id, current.epoch)
        )
          return yield* fail(
            "superseded_conflict",
            "This copy no longer coordinates at that epoch.",
          );
        let next: ProjectCoordinatorBinding;
        const wanted = input.standby;
        if (wanted === null) {
          if (current.standby === undefined) return { coordinatorBinding: current, replayed: true };
          if (input.expect === undefined || !sameMember(current.standby.member, input.expect))
            return yield* fail("superseded_conflict", REARM_OWNER_CHOSE);
          const { standby: _standby, ...rest } = current;
          next = rest;
        } else {
          if (current.standby !== undefined)
            return sameMember(current.standby.member, wanted.member)
              ? { coordinatorBinding: current, replayed: true }
              : yield* fail("superseded_conflict", REARM_OWNER_CHOSE);
          if (settings.archived) return yield* fail("archived");
          const self = yield* deps.selfMember(project);
          const listed = identity.members.find((member) => sameMember(member, wanted.member));
          if (
            listed === undefined ||
            logicalProjectMemberKey(listed) === logicalProjectMemberKey(self)
          )
            return yield* fail("invalid", "The standby is another member listed in this project.");
          next = {
            ...current,
            standby: {
              member: listed,
              afterMinutes: wanted.afterMinutes,
              enabledAt: yield* nowIso,
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

  const rearmStatus: ProjectLinkStandbyMethods["rearmStatus"] = (projectId) =>
    Effect.gen(function* () {
      const project = yield* load(projectId);
      const identity = project.workspaceSettings?.logicalProject;
      if (identity === undefined) return undefined;
      const entry = yield* rearmStore.get(identity.id);
      if (entry === undefined || entry.projectId !== project.id) return undefined;
      const binding = project.workspaceSettings?.coordinatorBinding;
      const run =
        entry.run !== null && binding?.state === "active" && entry.run.epoch === binding.epoch
          ? entry.run
          : null;
      if (entry.consent === null && run === null) return undefined;
      return {
        consent:
          entry.consent === null
            ? null
            : {
                chainId: entry.consent.chainId,
                members: entry.consent.members,
                afterMinutes: entry.consent.afterMinutes,
              },
        run:
          run === null
            ? null
            : {
                state: run.state,
                reason: run.reason,
                detail: run.detail,
                standby: run.standby,
                epoch: run.epoch,
                since: run.since,
              },
      } satisfies ProjectStandbyRearmStatus;
    }).pipe(Effect.orElseSucceed(() => undefined));

  // --- Away mode: a planned handover between two linked copies --------------

  /** Refuses an epoch another machine already claimed here after its own takeover. */
  const refuseClaimed = (logicalProjectId: string, epoch: number) =>
    Effect.gen(function* () {
      if (deps.claimedEpoch === undefined) return;
      const claim = yield* deps.claimedEpoch(logicalProjectId);
      const selfEnvironmentId = yield* environment.getEnvironmentId;
      if (claim !== undefined && claim.claimedBy !== selfEnvironmentId && claim.epoch >= epoch)
        return yield* fail(
          "superseded_conflict",
          "Another machine coordinates this project at a newer epoch.",
        );
    });

  const plannedGiveWay: ProjectLinkStandbyMethods["plannedGiveWay"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        yield* deps.refusePersonal(project);
        const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
        const identity = settings.logicalProject;
        if (!identity) return yield* fail("not_linked");
        const self = yield* deps.selfMember(project);
        const binding: ProjectCoordinatorBinding = settings.coordinatorBinding ?? {
          epoch: 0,
          state: "active",
        };
        if (
          binding.state === "transferred" &&
          binding.operationId === input.operationId &&
          binding.successor !== undefined &&
          binding.successor.environmentId === input.successorEnvironmentId
        )
          return {
            coordinatorBinding: binding,
            logicalProjectId: identity.id,
            self,
            successor: binding.successor,
            replayed: true,
          };
        if (binding.state === "transferring") return yield* fail("handoff_in_progress");
        if (binding.state !== "active") return yield* fail("not_coordinator");
        if (settings.archived) return yield* fail("archived");
        const candidates = identity.members.filter(
          (member) =>
            member.environmentId === input.successorEnvironmentId &&
            logicalProjectMemberKey(member) !== logicalProjectMemberKey(self),
        );
        const successor = candidates.length === 1 ? candidates[0] : undefined;
        if (successor === undefined)
          return yield* fail(
            "not_linked",
            candidates.length === 0
              ? "This project has no linked copy on that machine."
              : "That machine holds more than one copy of this project.",
          );
        const next: ProjectCoordinatorBinding = {
          epoch: binding.epoch + 1,
          state: "transferred",
          operationId: input.operationId,
          successor,
          takenOverAt: yield* nowIso,
        };
        yield* deps.writeOwnership(project, "project-away-give-way", input.operationId, {
          mode: "superseded",
          logicalProject: identity,
          coordinatorBinding: next,
        });
        yield* deps.publishRole({
          kind: "gave-way",
          projectId: project.id,
          logicalProjectId: identity.id,
          epoch: next.epoch,
          successor,
        });
        return {
          coordinatorBinding: next,
          logicalProjectId: identity.id,
          self,
          successor,
          replayed: false,
        };
      }),
    );

  const plannedRevert: ProjectLinkStandbyMethods["plannedRevert"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        const identity = project.workspaceSettings?.logicalProject;
        const binding = project.workspaceSettings?.coordinatorBinding;
        const revertId = plannedRevertOperationId(input.operationId);
        if (!identity) return yield* fail("not_linked");
        if (binding?.state === "active" && binding.operationId === revertId)
          return { coordinatorBinding: binding };
        if (binding?.state !== "transferred" || binding.operationId !== input.operationId)
          return yield* fail(
            "superseded_conflict",
            "Another copy coordinates this project since; this one stays a member.",
          );
        const next: ProjectCoordinatorBinding = {
          epoch: binding.epoch + 1,
          state: "active",
          operationId: revertId,
        };
        yield* deps.writeOwnership(project, "project-away-revert", revertId, {
          mode: "start-coordinator",
          logicalProject: identity,
          coordinatorBinding: next,
        });
        yield* deps.publishRole({
          kind: "took-over",
          projectId: project.id,
          logicalProjectId: identity.id,
          epoch: next.epoch,
          predecessor: null,
          takenOverBy: "person",
        });
        return { coordinatorBinding: next };
      }),
    );

  const plannedTakeover: ProjectLinkStandbyMethods["plannedTakeover"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        yield* deps.refusePersonal(project);
        const identity = project.workspaceSettings?.logicalProject;
        if (!identity || identity.id !== input.logicalProjectId) return yield* fail("not_linked");
        const binding: ProjectCoordinatorBinding = project.workspaceSettings
          ?.coordinatorBinding ?? { epoch: 0, state: "active" };
        const replay = (predecessor: LogicalProjectMember) =>
          deps.takeoverLocked({
            projectId: project.id,
            operationId: input.operationId,
            knownEpoch: binding.epoch,
            predecessor,
            epoch: input.epoch,
            takenOverBy: "person",
          });
        if (
          binding.state === "active" &&
          binding.operationId === input.operationId &&
          binding.predecessor !== undefined
        )
          return yield* replay(binding.predecessor);
        if (input.predecessor.environmentId !== input.callerEnvironmentId)
          return yield* fail("invalid", "Only the coordinator itself may hand it over.");
        if (binding.state === "transferring") return yield* fail("handoff_in_progress");
        if (binding.state !== "transferred")
          return yield* fail(
            "superseded_conflict",
            "This copy runs its own coordinator, so it cannot take over another.",
          );
        if (
          binding.successor === undefined ||
          logicalProjectMemberKey(binding.successor) !== logicalProjectMemberKey(input.predecessor)
        )
          return yield* fail(
            "superseded_conflict",
            "This copy follows another coordinator, not the one handing over.",
          );
        if (input.epoch <= binding.epoch)
          return yield* fail("superseded_conflict", "That epoch is not newer than this copy's.");
        yield* refuseClaimed(identity.id, input.epoch);
        // The listed member, so the takeover names it exactly as this copy lists it.
        return yield* replay(binding.successor);
      }),
    );

  const awayTakeover: ProjectLinkStandbyMethods["awayTakeover"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        yield* deps.refusePersonal(project);
        const identity = project.workspaceSettings?.logicalProject;
        const binding = project.workspaceSettings?.coordinatorBinding;
        if (!identity) return yield* fail("not_linked");
        if (
          binding?.state === "active" &&
          binding.operationId === awayTakeoverOperationId(identity.id, binding.epoch) &&
          binding.predecessor?.environmentId === input.sourceEnvironmentId
        )
          return {
            operationId: binding.operationId,
            logicalProject: identity,
            coordinatorBinding: binding,
            notesWritten: 0,
            replicaFrom: null,
            replayed: true,
          };
        if (binding?.state === "transferring") return yield* fail("handoff_in_progress");
        if (binding?.state !== "transferred")
          return yield* fail(
            "superseded_conflict",
            "This copy runs its own coordinator, so it cannot take over another.",
          );
        if (binding.successor?.environmentId !== input.sourceEnvironmentId)
          return yield* fail(
            "superseded_conflict",
            "Another copy coordinates this project now, not the machine that went away.",
          );
        const record = yield* store.get(identity.id).pipe(Effect.catch(storeFailed));
        const recordEpoch =
          record !== undefined &&
          record.projectId === project.id &&
          record.coordinator.environmentId === input.sourceEnvironmentId
            ? record.epoch
            : 0;
        const epoch = Math.max(binding.epoch, recordEpoch) + 1;
        yield* refuseClaimed(identity.id, epoch);
        return yield* deps.takeoverLocked({
          projectId: project.id,
          operationId: awayTakeoverOperationId(identity.id, epoch),
          knownEpoch: binding.epoch,
          predecessor: binding.successor,
          epoch,
          takenOverBy: "auto",
        });
      }),
    );

  return {
    setStandby,
    acceptStandby,
    acceptStandbyFromPeer,
    replicateFromPeer,
    autoTakeover,
    rearmStandby,
    rearmStatus,
    plannedGiveWay,
    plannedRevert,
    plannedTakeover,
    awayTakeover,
  };
};

function registration(record: CoordinatorStandbyRecord) {
  return {
    coordinator: record.coordinator,
    epoch: record.epoch,
    afterMinutes: record.afterMinutes,
    acceptedAt: record.acceptedAt,
  };
}
