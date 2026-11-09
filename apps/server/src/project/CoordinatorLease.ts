import {
  CommandId,
  type EnvironmentId,
  isProjectCoordinatorThreadId,
  logicalProjectMemberKey,
  type LogicalProjectMember,
  type Project,
  type ProjectCoordinatorBinding,
  type ProjectId,
  ProjectLinkError,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { makeFileWakeHoldStore } from "../away/AwayWakeHold.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { RemoteWorkerStore } from "../fleet/RemoteWorkerStore.ts";
import { type HandoffPeerError, HandoffPeers } from "../handoff/handoffPeers.ts";
import {
  COORDINATOR_LEASE_PROTOCOL_VERSION,
  type CoordinatorLeaseRequest,
  type CoordinatorLeaseResponse,
} from "../handoff/handoffWire.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import {
  type CoordinatorLeaseRecord,
  CoordinatorLeaseStore,
  type CoordinatorLeaseTarget,
  type CoordinatorPendingRelease,
  emptyLeaseRecord,
  layer as CoordinatorLeaseStoreLayer,
} from "./CoordinatorLeaseStore.ts";
import type { CoordinatorStandbyShadowWorker } from "./CoordinatorStandbyStore.ts";
import { PLANNED_PAUSE_MAX_MS, STANDBY_TICK_MS } from "./CoordinatorStandbyWatch.ts";
import { makeFenceSweep } from "./CoordinatorWakeGate.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import { coordinatorContentDigest, ProjectLink } from "./ProjectLink.ts";
import { CoordinatorReleaseGuard, type ReleaseBeforeChangeInput } from "./ProjectLinkStandby.ts";
import * as ProjectService from "./ProjectService.ts";
import {
  RoutineCopies,
  type RoutineCopiesSnapshot,
} from "../scheduledTasks/ScheduledTaskCopies.ts";

/**
 * The coordinator's side of automatic takeover. Every 30 seconds it sends a
 * lease to the standby the owner chose, and its notes, goal and instructions
 * when the standby asks; it releases standbys it no longer leases to, and it
 * gives way when the standby answers that it took over.
 *
 * Every lease carries a sequence above any this copy sent before, persisted
 * before it is sent. `lastSuccessfulLeaseAt` is the send time of the last
 * lease that came back with no takeover, so this copy's own silence clock
 * (the fence in CoordinatorWakeGate) never runs behind the standby's.
 */

const LEASES_MAX = 200;
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const sameMember = (a: LogicalProjectMember, b: LogicalProjectMember) =>
  logicalProjectMemberKey(a) === logicalProjectMemberKey(b) &&
  a.coordinatorThreadId === b.coordinatorThreadId;

const sameTarget = (a: CoordinatorLeaseTarget | null, b: CoordinatorLeaseTarget | null) =>
  a === null || b === null ? a === b : sameMember(a.standby, b.standby) && a.epoch === b.epoch;

/** A pending release naming the standby and epoch leased to now. */
const isTarget = (entry: CoordinatorPendingRelease, target: CoordinatorLeaseTarget | null) =>
  target !== null && sameMember(entry.standby, target.standby) && entry.epoch === target.epoch;

/**
 * Whether a standby's refusal of a release settles it: it does not stand by
 * for this copy (`not_found`), or it ignored the release because it holds no
 * registration from this copy at that epoch (`invalid`). A version mismatch
 * (`check: "version"`) and anything decided on this machine stay owed.
 */
export function releaseSettledBy(error: HandoffPeerError): boolean {
  return (
    error.local !== true &&
    (error.code === "not_found" || (error.code === "invalid" && error.check !== "version"))
  );
}

/** The standby this copy should lease to: only an active, linked, unarchived copy with one set. */
export function desiredLeaseTarget(project: Project): CoordinatorLeaseTarget | null {
  const settings = project.workspaceSettings;
  const binding = settings?.coordinatorBinding;
  if (
    project.deletedAt !== null ||
    settings?.logicalProject === undefined ||
    settings.archived ||
    binding?.state !== "active" ||
    binding.standby === undefined
  )
    return null;
  return {
    standby: binding.standby.member,
    epoch: binding.epoch,
    afterMinutes: binding.standby.afterMinutes,
    enabledAt: binding.standby.enabledAt,
  };
}

/**
 * Whether a standby's `takenOver` answer may make this copy give way (AC-09):
 * the binding is active above this copy's epoch, names this copy as its
 * predecessor, and comes from the standby this copy sent to, or from the
 * machine a lid-close Away recorded as its target (`alsoFrom`, 1267 AC-09).
 */
export function verifyTakenOver(input: {
  readonly own: ProjectCoordinatorBinding;
  readonly self: LogicalProjectMember;
  readonly sentTo: LogicalProjectMember;
  readonly answer: NonNullable<CoordinatorLeaseResponse["takenOver"]>;
  /** Environments whose own takeover is accepted too: the recorded away target. */
  readonly alsoFrom?: ReadonlyArray<string> | undefined;
  /** This copy's listed members; an `alsoFrom` successor must be one of them. */
  readonly members?: ReadonlyArray<LogicalProjectMember> | undefined;
}): string | null {
  const incoming = input.answer.coordinatorBinding;
  if (input.own.state !== "active") return "this copy no longer coordinates";
  if (incoming.state !== "active") return "the binding is not active";
  if (!(incoming.epoch > input.own.epoch)) return "the epoch is not above this copy's";
  if (incoming.predecessor === undefined || !sameMember(incoming.predecessor, input.self))
    return "the predecessor is not this copy";
  const fromAwayTarget =
    input.alsoFrom !== undefined &&
    input.alsoFrom.includes(input.answer.successor.environmentId) &&
    (input.members ?? []).some(
      (member) =>
        logicalProjectMemberKey(member) === logicalProjectMemberKey(input.answer.successor),
    );
  if (!fromAwayTarget && !sameMember(input.answer.successor, input.sentTo))
    return "the sender is not the standby";
  if (incoming.operationId === undefined || incoming.takenOverAt === undefined)
    return "the takeover has no operation or time";
  return null;
}

/**
 * The first turn to review after giving way, in this machine's clock: the
 * standby's takeover time moved by the offset its receive time shows, or the
 * last lease the standby confirmed if that is earlier.
 */
export function reviewBoundary(input: {
  readonly takenOverAt: string;
  readonly standbyReceivedAt: string;
  readonly sentAtMs: number;
  readonly answeredAtMs: number;
  readonly lastSuccessfulLeaseAt: string | null;
}): number {
  const offset = Date.parse(input.standbyReceivedAt) - (input.sentAtMs + input.answeredAtMs) / 2;
  const translated = Date.parse(input.takenOverAt) - (Number.isFinite(offset) ? offset : 0);
  const confirmed =
    input.lastSuccessfulLeaseAt === null ? Number.NaN : Date.parse(input.lastSuccessfulLeaseAt);
  return Number.isFinite(confirmed) ? Math.min(translated, confirmed) : translated;
}

export interface CoordinatorLeaseDeps {
  readonly store: CoordinatorLeaseStore["Service"];
  readonly peers: Pick<HandoffPeers["Service"], "coordinatorLease" | "coordinatorReplica">;
  readonly admission: ProjectAdmission.ProjectAdmission["Service"];
  readonly link: Pick<ProjectLink["Service"], "digest" | "preview" | "supersede">;
  readonly selfEnvironmentId: string;
  /** This machine's projects, deleted ones left out. */
  readonly listProjects: Effect.Effect<ReadonlyArray<Project>>;
  readonly loadProject: (projectId: ProjectId) => Effect.Effect<Project | undefined>;
  readonly runningThreads: (
    project: Project,
  ) => Effect.Effect<ReadonlyArray<{ readonly threadId: string; readonly title: string }>>;
  readonly workers: (
    project: Project,
  ) => Effect.Effect<ReadonlyArray<CoordinatorStandbyShadowWorker>>;
  /** Interrupts the project's coordinator turn and the local children it started. */
  readonly stopCoordinator: (project: Project, reason: string) => Effect.Effect<void>;
  /** Marks workers the coordinator thread started on other machines as stopped; returns how many. */
  readonly stopCoordinatorWorkers: (project: Project, reason: string) => Effect.Effect<number>;
  /** When a planned stop (a service update) ends, while one is under way. */
  readonly plannedPauseUntil: Effect.Effect<number | null>;
  /**
   * The routines the standby keeps (RoutineCopies), or null when they cannot
   * be read or are too large to send; absent on a server without a scheduler, which sends none.
   */
  readonly routines?:
    | ((project: Project) => Effect.Effect<RoutineCopiesSnapshot | null>)
    | undefined;
  /**
   * The machine a lid-close Away recorded as its target (`AwayWakeHold`); its
   * takeover answer is accepted like the standby's. Absent: none.
   */
  readonly awayTargets?: Effect.Effect<ReadonlyArray<string>> | undefined;
  /** Runs after every tick with the records it left; the wake gate fences from them. */
  readonly afterTick?: (records: ReadonlyArray<CoordinatorLeaseRecord>) => Effect.Effect<void>;
}

export type PauseInput =
  | { readonly pausedUntil: string; readonly sleeping?: undefined }
  | { readonly sleeping: true; readonly pausedUntil?: undefined };

export interface CoordinatorLeaseShape {
  /** One round: sync targets from bindings, send releases still owed, then leases. Never fails. */
  readonly tick: Effect.Effect<void>;
  /** Announces a planned stop to every standby; returns how many answered. Never fails. */
  readonly pause: (input: PauseInput) => Effect.Effect<number>;
  readonly releaseBefore: CoordinatorReleaseGuard["Service"]["releaseBefore"];
  readonly records: Effect.Effect<ReadonlyArray<CoordinatorLeaseRecord>>;
  /**
   * Lid-close Away, back (1267 AC-09): the away target says it took this copy
   * over. Verified as a standby's answer, then this copy stops its coordinator
   * and its workers and gives way, under the project lock. True once this copy
   * no longer coordinates (now or already). Never fails.
   */
  readonly acceptAwayTakeover: (input: {
    readonly projectId: ProjectId;
    readonly takenOver: NonNullable<CoordinatorLeaseResponse["takenOver"]>;
    /** The target's receive time and this machine's send and answer times. */
    readonly receivedAt: string;
    readonly sentAtMs: number;
    readonly answeredAtMs: number;
  }) => Effect.Effect<boolean>;
  /** Interrupts the project's coordinator turn and its local children. Never fails. */
  readonly stopCoordinatorOf: (projectId: ProjectId, reason: string) => Effect.Effect<void>;
}

export class CoordinatorLease extends Context.Service<CoordinatorLease, CoordinatorLeaseShape>()(
  "specweave-studio/project/CoordinatorLease",
) {}

/** The "may have reached it" mark a lease wrote before it left, and the value it replaced. */
interface DeliveryMark {
  readonly value: string;
  readonly prior: string | null;
}

type SendOutcome =
  | {
      readonly kind: "answered";
      readonly answer: CoordinatorLeaseResponse;
      readonly mark: DeliveryMark | null;
    }
  | {
      readonly kind: "refused";
      readonly error: HandoffPeerError;
      readonly mark: DeliveryMark | null;
    }
  | { readonly kind: "skipped" };

export const makeCoordinatorLease = (deps: CoordinatorLeaseDeps): CoordinatorLeaseShape => {
  const { store, peers, admission, link } = deps;
  const now = Clock.currentTimeMillis;
  const quiet = <A, E>(effect: Effect.Effect<A, E>, message: string) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => Effect.logWarning(message, { cause })),
    );

  const update = (
    projectId: string,
    change: (record: CoordinatorLeaseRecord) => CoordinatorLeaseRecord,
  ) =>
    quiet(
      store.modify(projectId, (current) => (current === undefined ? undefined : change(current))),
      "Could not write the coordinator lease record",
    );

  /**
   * Reserves the next sequence: above every one sent before, and above the
   * wall clock so a lost file never repeats one. A lease or pause to the
   * current target also marks, in the same write, that it may reach the
   * standby: a call still in flight, or cut off by a restart, leaves the mark.
   */
  const nextSeq = (projectId: string, markFor: CoordinatorLeaseTarget | null) =>
    Effect.gen(function* () {
      const nowMs = yield* now;
      const marks: { mark: DeliveryMark | null } = { mark: null };
      const record = yield* store.modify(projectId, (current) => {
        if (current === undefined) return undefined;
        const seq = Math.max(current.seq + 1, nowMs);
        const mark: DeliveryMark | null =
          markFor !== null && sameTarget(current.target, markFor)
            ? { value: isoAt(seq), prior: current.maybeDeliveredAt ?? null }
            : null;
        marks.mark = mark;
        return {
          ...current,
          seq,
          ...(mark === null ? {} : { maybeDeliveredAt: mark.value }),
          updatedAt: isoAt(nowMs),
        };
      });
      return record === undefined ? undefined : { seq: record.seq, mark: marks.mark };
    });

  const selfMemberOf = (project: Project) =>
    project.workspaceSettings?.logicalProject?.members.find(
      (member) =>
        member.environmentId === deps.selfEnvironmentId && member.projectId === project.id,
    );

  /** Brings each record's target in line with its binding; a standby no longer leased to is owed a release. */
  const sync = Effect.gen(function* () {
    const nowMs = yield* now;
    const at = isoAt(nowMs);
    const projects = yield* deps.listProjects;
    const known = new Set((yield* store.list).map((record) => record.projectId));
    const byId = new Map(projects.map((project) => [project.id as string, project]));
    for (const projectId of new Set([...known, ...projects.map((project) => project.id)])) {
      const project = byId.get(projectId);
      const desired = project === undefined ? null : desiredLeaseTarget(project);
      yield* store.modify(projectId, (current) => {
        if (current === undefined && desired === null) return undefined;
        const base =
          current ??
          emptyLeaseRecord(projectId, project!.workspaceSettings!.logicalProject!.id, at);
        const coordinatorThreadId =
          project?.workspaceSettings?.coordinatorThreadId ?? base.coordinatorThreadId ?? null;
        // A release owed to the standby leased to now would disarm it; it is no longer owed.
        const stillOwed = base.pendingReleases.filter((entry) => !isTarget(entry, desired));
        if (sameTarget(base.target, desired)) {
          if (
            (desired === null ||
              base.target === null ||
              (base.target.afterMinutes === desired.afterMinutes &&
                base.target.enabledAt === desired.enabledAt)) &&
            (base.coordinatorThreadId ?? null) === coordinatorThreadId &&
            stillOwed.length === base.pendingReleases.length
          )
            return current === undefined ? base : undefined;
          return {
            ...base,
            coordinatorThreadId,
            target: desired,
            pendingReleases: stillOwed,
            updatedAt: at,
          };
        }
        const owed: CoordinatorPendingRelease[] =
          base.target === null ||
          stillOwed.some(
            (entry) =>
              sameMember(entry.standby, base.target!.standby) && entry.epoch === base.target!.epoch,
          )
            ? stillOwed
            : [
                ...stillOwed,
                {
                  standby: base.target.standby,
                  epoch: base.target.epoch,
                  logicalProjectId: base.logicalProjectId,
                  since: at,
                },
              ];
        const next: CoordinatorLeaseRecord = {
          ...base,
          coordinatorThreadId,
          logicalProjectId:
            desired !== null
              ? (project?.workspaceSettings?.logicalProject?.id ?? base.logicalProjectId)
              : base.logicalProjectId,
          target: desired,
          pendingReleases: owed,
          lastSuccessfulLeaseAt: null,
          lastPausedAnswerAt: null,
          standbyMissingAt: null,
          maybeDeliveredAt: null,
          lastError: null,
          fencedSince: null,
          gaveWay: desired === null ? base.gaveWay : null,
          updatedAt: at,
        };
        return next.target === null && next.pendingReleases.length === 0 && next.gaveWay === null
          ? null
          : next;
      });
    }
  });

  /** Sends one lease-path request to `standby`; the sequence is persisted before it leaves. */
  const send = (
    record: CoordinatorLeaseRecord,
    standby: LogicalProjectMember,
    body: Omit<
      CoordinatorLeaseRequest,
      "protocolVersion" | "seq" | "contentDigest" | "runningThreads" | "workers"
    >,
    project: Project | undefined,
    /** The target a lease or pause goes to, marked as maybe reached before it leaves. */
    markFor: CoordinatorLeaseTarget | null = null,
  ) =>
    Effect.gen(function* () {
      const contentDigest =
        project === undefined
          ? ""
          : yield* link.digest({ projectId: project.id }).pipe(
              Effect.map((digest) => digest.digest),
              Effect.orElseSucceed(() => ""),
            );
      const routines =
        project === undefined || body.kind === "release" || deps.routines === undefined
          ? null
          : yield* deps.routines(project);
      const reserved = yield* nextSeq(record.projectId, markFor);
      if (reserved === undefined) return { kind: "skipped" } as SendOutcome;
      const { seq, mark } = reserved;
      const running =
        project === undefined || body.kind === "release" ? [] : yield* deps.runningThreads(project);
      const workers =
        project === undefined || body.kind === "release" ? [] : yield* deps.workers(project);
      const exit = yield* peers
        .coordinatorLease(standby.environmentId as EnvironmentId, {
          ...body,
          protocolVersion: COORDINATOR_LEASE_PROTOCOL_VERSION,
          seq,
          contentDigest,
          ...(routines === null ? {} : { routinesDigest: routines.digest }),
          runningThreads: running.slice(0, LEASES_MAX).map(({ threadId, title }) => ({
            threadId: threadId as never,
            title: title.slice(0, 500),
          })),
          workers: workers.slice(0, LEASES_MAX),
        })
        .pipe(Effect.exit);
      if (Exit.isSuccess(exit))
        return { kind: "answered", answer: exit.value, mark } as SendOutcome;
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
      if (failure !== undefined)
        return { kind: "refused", error: failure.error, mark } as SendOutcome;
      return yield* Effect.failCause(exit.cause);
    }).pipe(Effect.orDie);

  /** The standby took over: verify it, then stop here and give way, all under the project lock. */
  const giveWay = (
    projectId: ProjectId,
    sentTo: LogicalProjectMember,
    answer: CoordinatorLeaseResponse,
    sentAtMs: number,
    answeredAtMs: number,
    reason = "Another machine took over this project's coordinator while this one was quiet.",
  ) =>
    admission
      .withLock(
        projectId,
        Effect.gen(function* () {
          const takenOver = answer.takenOver!;
          const project = yield* deps.loadProject(projectId);
          const self = project === undefined ? undefined : selfMemberOf(project);
          const identity = project?.workspaceSettings?.logicalProject;
          const own = project?.workspaceSettings?.coordinatorBinding ?? {
            epoch: 0,
            state: "active" as const,
          };
          // A retry after giving way already: the binding names that successor.
          if (
            own.state === "transferred" &&
            own.operationId === takenOver.coordinatorBinding.operationId
          )
            return;
          const alsoFrom =
            deps.awayTargets === undefined
              ? []
              : yield* deps.awayTargets.pipe(Effect.orElseSucceed(() => []));
          const refusal =
            project === undefined || self === undefined || identity === undefined
              ? "this copy is no longer linked"
              : verifyTakenOver({
                  own,
                  self,
                  sentTo,
                  answer: takenOver,
                  alsoFrom,
                  members: identity.members,
                });
          if (refusal !== null || project === undefined || identity === undefined) {
            yield* Effect.logWarning("Coordinator ignored a takeover it could not verify", {
              projectId,
              reason: refusal,
            });
            yield* update(projectId, (record) => ({
              ...record,
              lastError: `The standby said it took over, but ${refusal}. Nothing changed here.`,
            }));
            return;
          }
          const record = yield* store.get(projectId).pipe(Effect.orElseSucceed(() => undefined));
          const reviewFromMs = reviewBoundary({
            takenOverAt: takenOver.coordinatorBinding.takenOverAt!,
            standbyReceivedAt: answer.receivedAt,
            sentAtMs,
            answeredAtMs,
            lastSuccessfulLeaseAt: record?.lastSuccessfulLeaseAt ?? null,
          });
          yield* deps.stopCoordinator(project, reason);
          const superseded = yield* link.supersede({
            projectId,
            logicalProjectId: identity.id,
            successor: takenOver.successor,
            // Turns are reviewed from the boundary in this machine's clock.
            coordinatorBinding: {
              ...takenOver.coordinatorBinding,
              takenOverAt: isoAt(reviewFromMs),
            },
          });
          yield* deps.stopCoordinatorWorkers(project, reason);
          const at = isoAt(yield* now);
          yield* update(projectId, (current) => ({
            ...current,
            target: null,
            fencedSince: null,
            lastError: null,
            gaveWay: {
              at,
              successor: takenOver.successor,
              epoch: takenOver.coordinatorBinding.epoch,
              reviewFrom: isoAt(reviewFromMs),
              ranWhileAway: superseded.ranWhileDisconnected.length,
            },
            updatedAt: at,
          }));
          yield* Effect.logWarning("Coordinator gave way to the standby that took over", {
            projectId,
            successor: takenOver.successor.environmentId,
          });
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Coordinator could not give way", { cause }),
        ),
      );

  /** Sends one lease (or pause) to the record's target and records how it went. */
  const lease = (record: CoordinatorLeaseRecord, pause?: PauseInput) =>
    Effect.gen(function* () {
      const target = record.target;
      if (target === null) return false;
      const project = yield* deps.loadProject(record.projectId as ProjectId);
      if (project === undefined) return false;
      const sentAtMs = yield* now;
      const plannedUntil = pause === undefined ? yield* deps.plannedPauseUntil : null;
      const pausedUntil =
        pause?.pausedUntil ??
        (plannedUntil === null
          ? undefined
          : isoAt(Math.min(plannedUntil, sentAtMs + PLANNED_PAUSE_MAX_MS)));
      const outcome = yield* send(
        record,
        target.standby,
        {
          kind: pause !== undefined || pausedUntil !== undefined ? "pause" : "lease",
          logicalProjectId: record.logicalProjectId,
          epoch: target.epoch,
          afterMinutes: target.afterMinutes,
          ...(pausedUntil === undefined ? {} : { pausedUntil }),
          ...(pause?.sleeping === true ? { sleeping: true } : {}),
        },
        project,
        target,
      );
      const answeredAtMs = yield* now;
      const at = isoAt(answeredAtMs);
      if (outcome.kind === "skipped") return false;
      if (outcome.kind === "refused") {
        const { error } = outcome;
        const fromStandby = error.local !== true;
        yield* update(record.projectId, (current) => ({
          ...current,
          lastError: error.message.slice(0, 500),
          // No answer: the lease may have reached the standby and started its clock.
          ...(error.uncertain === true && sameTarget(current.target, target)
            ? { maybeDeliveredAt: at }
            : // A definite failure: nothing reached it, so its own mark goes, unless another lease marked since.
              error.uncertain !== true &&
                outcome.mark !== null &&
                current.maybeDeliveredAt === outcome.mark.value
              ? { maybeDeliveredAt: outcome.mark.prior }
              : {}),
          ...(fromStandby && error.code === "busy" ? { lastPausedAnswerAt: at } : {}),
          // The standby does not stand by for this copy, so it cannot take over: nothing to fence for.
          ...(fromStandby && error.code === "not_found"
            ? { standbyMissingAt: at, fencedSince: null }
            : {}),
          updatedAt: at,
        }));
        return false;
      }
      const { answer } = outcome;
      if (answer.takenOver !== null) {
        yield* giveWay(project.id, target.standby, answer, sentAtMs, answeredAtMs);
        return false;
      }
      yield* update(record.projectId, (current) =>
        current.target === null || !sameTarget(current.target, target)
          ? current
          : {
              ...current,
              lastSuccessfulLeaseAt: isoAt(sentAtMs),
              maybeDeliveredAt: at,
              lastPausedAnswerAt: answer.standbySleeping ? at : current.lastPausedAnswerAt,
              standbyMissingAt: null,
              lastError: null,
              fencedSince: null,
              updatedAt: at,
            },
      );
      if (answer.wantsContent) yield* replicate(record, target, project);
      return true;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Coordinator lease failed", { projectId: record.projectId, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const replicate = (
    record: CoordinatorLeaseRecord,
    target: CoordinatorLeaseTarget,
    project: Project,
  ) =>
    quiet(
      Effect.gen(function* () {
        const preview = yield* link.preview({ projectId: project.id });
        const routines = deps.routines === undefined ? null : yield* deps.routines(project);
        const content = {
          goal: preview.goal,
          instructions: preview.instructions,
          notes: preview.notes,
          notesTruncated: preview.notesTruncated,
        };
        yield* peers.coordinatorReplica(target.standby.environmentId as EnvironmentId, {
          protocolVersion: COORDINATOR_LEASE_PROTOCOL_VERSION,
          logicalProjectId: record.logicalProjectId,
          epoch: target.epoch,
          digest: coordinatorContentDigest(content),
          ...content,
          ...(routines === null
            ? {}
            : { routines: routines.routines, routinesDigest: routines.digest }),
        });
      }),
      "Coordinator could not send its content to the standby",
    );

  /** Releases one standby; true once it answered (or said it no longer stands by). */
  const release = (record: CoordinatorLeaseRecord, entry: CoordinatorPendingRelease) =>
    Effect.gen(function* () {
      const project = yield* deps.loadProject(record.projectId as ProjectId);
      const sentAtMs = yield* now;
      const outcome = yield* send(
        record,
        entry.standby,
        {
          kind: "release",
          logicalProjectId: entry.logicalProjectId,
          epoch: entry.epoch,
          afterMinutes: record.target?.afterMinutes ?? 15,
        },
        project,
      );
      if (outcome.kind === "skipped") return false;
      if (outcome.kind === "refused") return releaseSettledBy(outcome.error);
      if (outcome.answer.takenOver !== null && project !== undefined) {
        yield* giveWay(project.id, entry.standby, outcome.answer, sentAtMs, yield* now);
        return true;
      }
      return true;
    });

  /** Drops a release no longer owed: settled meanwhile, or naming the standby leased to now. */
  const dropRelease = (projectId: string, entry: CoordinatorPendingRelease) =>
    store
      .modify(projectId, (current) => {
        if (current === undefined) return undefined;
        const pendingReleases = current.pendingReleases.filter(
          (kept) => !(sameMember(kept.standby, entry.standby) && kept.epoch === entry.epoch),
        );
        return current.target === null && pendingReleases.length === 0 && current.gaveWay === null
          ? null
          : { ...current, pendingReleases };
      })
      .pipe(Effect.orDie);

  const settleReleases = (record: CoordinatorLeaseRecord) =>
    Effect.gen(function* () {
      for (const entry of record.pendingReleases) {
        // A change since this round's sync (the owner set this standby again) must not be undone.
        const current = yield* store.get(record.projectId).pipe(Effect.orDie);
        if (
          current === undefined ||
          !current.pendingReleases.some(
            (kept) => sameMember(kept.standby, entry.standby) && kept.epoch === entry.epoch,
          )
        )
          continue;
        const project = yield* deps.loadProject(record.projectId as ProjectId);
        const desired = project === undefined ? null : desiredLeaseTarget(project);
        if (isTarget(entry, desired) || isTarget(entry, current.target)) {
          yield* dropRelease(record.projectId, entry);
          continue;
        }
        if (!(yield* release(current, entry))) continue;
        yield* Effect.logInfo("Coordinator standby released", {
          projectId: record.projectId,
          standby: entry.standby.environmentId,
        });
        yield* dropRelease(record.projectId, entry);
      }
    });

  const records = store.list.pipe(
    Effect.orElseSucceed((): ReadonlyArray<CoordinatorLeaseRecord> => []),
  );

  const tick: CoordinatorLeaseShape["tick"] = Effect.gen(function* () {
    yield* sync;
    for (const record of yield* records) {
      yield* settleReleases(record);
      const current = yield* store.get(record.projectId);
      if (current?.target != null) yield* lease(current);
    }
    if (deps.afterTick !== undefined) yield* deps.afterTick(yield* records);
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Coordinator lease round failed", { cause })),
  );

  const pause: CoordinatorLeaseShape["pause"] = (input) =>
    Effect.gen(function* () {
      let answered = 0;
      for (const record of yield* records)
        if (record.target !== null && (yield* lease(record, input))) answered += 1;
      return answered;
    });

  const releaseBefore: CoordinatorLeaseShape["releaseBefore"] = (input: ReleaseBeforeChangeInput) =>
    Effect.gen(function* () {
      const record = yield* store
        .get(input.projectId)
        .pipe(Effect.mapError(() => new ProjectLinkError({ code: "storage_failed" })));
      const target = record?.target ?? null;
      if (record === undefined || target === null) return;
      if (input.unless !== undefined && sameMember(input.unless, target.standby)) return;
      if (input.onlyFor !== undefined && !sameMember(input.onlyFor, target.standby)) return;
      const entry: CoordinatorPendingRelease = {
        standby: target.standby,
        epoch: target.epoch,
        logicalProjectId: record.logicalProjectId,
        since: isoAt(yield* now),
      };
      const project = yield* deps.loadProject(input.projectId);
      const outcome = yield* send(
        record,
        target.standby,
        {
          kind: "release",
          logicalProjectId: entry.logicalProjectId,
          epoch: entry.epoch,
          afterMinutes: target.afterMinutes,
        },
        project,
      );
      if (outcome.kind === "answered" && outcome.answer.takenOver !== null)
        return yield* new ProjectLinkError({
          code: "superseded_conflict",
          detail: "The standby already took over the coordinator.",
        });
      const answered =
        outcome.kind === "answered" ||
        (outcome.kind === "refused" &&
          outcome.error.local !== true &&
          outcome.error.code === "not_found");
      if (!answered && !input.changeAnyway)
        return yield* new ProjectLinkError({ code: "standby_unreachable" });
      yield* store
        .modify(input.projectId, (current) =>
          current === undefined
            ? undefined
            : {
                ...current,
                target: null,
                fencedSince: null,
                maybeDeliveredAt: null,
                pendingReleases: answered
                  ? current.pendingReleases
                  : [...current.pendingReleases, entry],
                updatedAt: entry.since,
              },
        )
        .pipe(Effect.mapError(() => new ProjectLinkError({ code: "storage_failed" })));
      yield* Effect.logInfo(
        answered ? "Coordinator standby released" : "Coordinator standby changed anyway",
        { projectId: input.projectId, reason: input.reason, standby: target.standby.environmentId },
      );
    });

  const acceptAwayTakeover: CoordinatorLeaseShape["acceptAwayTakeover"] = (input) =>
    Effect.gen(function* () {
      yield* giveWay(
        input.projectId,
        input.takenOver.successor,
        {
          takenOver: input.takenOver,
          wantsContent: false,
          standbySleeping: false,
          receivedAt: input.receivedAt,
        },
        input.sentAtMs,
        input.answeredAtMs,
        "Another machine took over this project's coordinator while this one slept.",
      );
      const project = yield* deps.loadProject(input.projectId);
      return project?.workspaceSettings?.coordinatorBinding?.state === "transferred";
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Coordinator could not give way to the away target", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const stopCoordinatorOf: CoordinatorLeaseShape["stopCoordinatorOf"] = (projectId, reason) =>
    Effect.gen(function* () {
      const project = yield* deps.loadProject(projectId);
      if (project !== undefined) yield* deps.stopCoordinator(project, reason);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not stop a coordinator held after Away", { cause }),
      ),
    );

  return { tick, pause, releaseBefore, records, acceptAwayTakeover, stopCoordinatorOf };
};

const TERMINAL_WORKER_STATES = new Set(["stopped", "disposed"]);

/** Wires the loop to this server's projects, threads, peers and worker rows. */
const makeLive = Effect.gen(function* () {
  const store = yield* CoordinatorLeaseStore;
  const peers = yield* HandoffPeers;
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const link = yield* ProjectLink;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const workerRows = yield* RemoteWorkerStore;
  const hold = yield* Effect.serviceOption(ServiceUpdateHold.ServiceUpdateHold);
  const selfEnvironmentId = yield* environment.getEnvironmentId;
  const awayHold = yield* makeFileWakeHoldStore;

  const shells = projections.getShellSnapshot({ maxAgeMs: 5_000 }).pipe(
    Effect.map((snapshot) => snapshot.threads),
    Effect.orElseSucceed(() => []),
  );

  const interrupt = (threadId: string, runId: string, reason: string) =>
    orchestrator
      .dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`coordinator-standby-interrupt:${runId}`),
        threadId: threadId as never,
        runId: runId as never,
        reason,
        cause: "agent",
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not interrupt a coordinator turn", { threadId, cause }),
        ),
      );

  const loadProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const stopCoordinator = (project: Project, reason: string) =>
    Effect.gen(function* () {
      const threads = yield* shells;
      const coordinators = new Set(
        threads
          .filter(
            (thread) =>
              thread.projectId === project.id && isProjectCoordinatorThreadId(thread.id, project),
          )
          .map((thread) => thread.id as string),
      );
      for (const thread of threads)
        if (
          thread.activeRunId !== null &&
          (coordinators.has(thread.id) ||
            (thread.lineage.parentThreadId !== null &&
              coordinators.has(thread.lineage.parentThreadId)))
        )
          yield* interrupt(thread.id, thread.activeRunId, reason);
    });

  const routineCopies = Option.getOrUndefined(yield* Effect.serviceOption(RoutineCopies));

  return makeCoordinatorLease({
    store,
    peers,
    admission,
    link,
    selfEnvironmentId,
    listProjects: projects.snapshot.pipe(
      Effect.map((snapshot) => snapshot.projects.filter((project) => project.deletedAt === null)),
      Effect.orElseSucceed(() => []),
    ),
    loadProject,
    routines:
      routineCopies === undefined
        ? undefined
        : (project) => {
            const logicalProjectId = project.workspaceSettings?.logicalProject?.id;
            if (logicalProjectId === undefined) return Effect.succeed(null);
            return routineCopies.snapshot({ projectId: project.id, logicalProjectId }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not read the routines to send the standby", {
                  projectId: project.id,
                  cause,
                }).pipe(Effect.as(null)),
              ),
            );
          },
    runningThreads: (project) =>
      Effect.map(shells, (threads) =>
        threads
          .filter((thread) => thread.projectId === project.id && thread.activeRunId !== null)
          .map((thread) => ({ threadId: thread.id, title: thread.title })),
      ),
    workers: (project) =>
      workerRows.list.pipe(
        Effect.map((rows) =>
          rows
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
              deliveredRunIds: row.deliveredRunIds.slice(-50),
            })),
        ),
        Effect.orElseSucceed(() => []),
      ),
    stopCoordinator,
    stopCoordinatorWorkers: (project, reason) =>
      Effect.gen(function* () {
        let stopped = 0;
        const at = isoAt(yield* Clock.currentTimeMillis);
        for (const row of yield* workerRows.list)
          if (
            row.projectId === project.id &&
            isProjectCoordinatorThreadId(row.callerThreadId, project) &&
            !TERMINAL_WORKER_STATES.has(row.state)
          ) {
            yield* workerRows.modify(row.id, (current) =>
              current === undefined
                ? undefined
                : { ...current, state: "stopped", lastError: reason, updatedAt: at },
            );
            stopped += 1;
          }
        return stopped;
      }).pipe(Effect.orElseSucceed(() => 0)),
    afterTick: makeFenceSweep({ store, loadProject, stopCoordinator }),
    awayTargets: awayHold.read.pipe(
      Effect.map((hold) => (hold === null ? [] : [hold.targetEnvironmentId])),
    ),
    plannedPauseUntil: Option.match(hold, {
      onNone: () => Effect.succeed(null),
      onSome: (service) =>
        service.current.pipe(
          Effect.map((state) => (Option.isSome(state) ? state.value.expiresAtMs : null)),
        ),
    }),
  });
});

const layerLease = Layer.effect(CoordinatorLease, makeLive).pipe(
  Layer.provide(Layer.merge(ProjectAdmission.layer, CoordinatorLeaseStoreLayer)),
);

/** The loop, and the release guard ProjectLink's handlers call before a change. */
export const layer = Layer.merge(
  layerLease,
  Layer.effect(
    CoordinatorReleaseGuard,
    Effect.gen(function* () {
      const lease = yield* CoordinatorLease;
      return CoordinatorReleaseGuard.of({ releaseBefore: lease.releaseBefore });
    }),
  ).pipe(Layer.provide(layerLease)),
);

/** Runs `tick` every 30 seconds for as long as the server runs. */
export const runLoop = Effect.gen(function* () {
  const lease = yield* CoordinatorLease;
  yield* lease.tick.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(STANDBY_TICK_MS))),
    Effect.asVoid,
  );
});
