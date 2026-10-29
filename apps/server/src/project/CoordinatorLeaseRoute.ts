import type { HandoffPreflightCheck, Project, ProjectId } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { projectInGrant } from "../fleet/workGrantPolicy.ts";
import { HandoffRefusal, type ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import {
  COORDINATOR_LEASE_PROTOCOL_VERSION,
  type CoordinatorLeaseRequest,
  type CoordinatorLeaseResponse,
  type CoordinatorReplicaRequest,
  type CoordinatorReplicaResponse,
} from "../handoff/handoffWire.ts";
import {
  type CoordinatorStandbyRecord,
  CoordinatorStandbyStore,
} from "./CoordinatorStandbyStore.ts";
import { applyLease } from "./CoordinatorStandbyWatch.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import { ProjectLink } from "./ProjectLink.ts";
import * as ProjectService from "./ProjectService.ts";

/**
 * The standby's side of the `coordinator-lease` and `coordinator-replica`
 * peer paths. Each request runs under the project lock that automatic
 * takeover also takes, so a lease and a takeover never interleave. A lease
 * counts only from the coordinator the owner registered here, through a grant
 * that covers this copy, at the registered epoch and a higher sequence than
 * any before; anything else is ignored and logged. Once this copy took over,
 * every lease from the old coordinator is answered with the new binding.
 */
export class CoordinatorLeaseReceiver extends Context.Service<
  CoordinatorLeaseReceiver,
  {
    readonly lease: (
      caller: ReceiverCaller,
      request: CoordinatorLeaseRequest,
    ) => Effect.Effect<CoordinatorLeaseResponse, HandoffRefusal>;
    readonly replica: (
      caller: ReceiverCaller,
      request: CoordinatorReplicaRequest,
    ) => Effect.Effect<CoordinatorReplicaResponse, HandoffRefusal>;
    /**
     * The grant of `coordinatorEnvironmentId` was refused here (revoked): this
     * machine stops standing by for it, so it never takes over on its behalf.
     */
    readonly grantRefused: (coordinatorEnvironmentId: string) => Effect.Effect<void>;
  }
>()("specweave-studio/project/CoordinatorLeaseRoute/CoordinatorLeaseReceiver") {}

const refuse = (
  status: number,
  code: HandoffRefusal["code"],
  message: string,
  check?: HandoffPreflightCheck,
) => new HandoffRefusal({ status, code, message, ...(check === undefined ? {} : { check }) });

const notArmed = () =>
  refuse(404, "not_found", "This machine does not stand by for that project's coordinator.");
const storeFailed = () => refuse(500, "failed", "This machine could not read its standby records.");

export const make = Effect.gen(function* () {
  const store = yield* CoordinatorStandbyStore;
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const projects = yield* ProjectService.ProjectService;
  const link = yield* ProjectLink;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const checkVersion = (protocolVersion: number) =>
    protocolVersion === COORDINATOR_LEASE_PROTOCOL_VERSION
      ? Effect.void
      : Effect.fail(
          refuse(
            409,
            "invalid",
            "The two machines run different versions of automatic takeover. Update both.",
            "version",
          ),
        );

  const disarm = (logicalProjectId: string, reason: string) =>
    store
      .modify(logicalProjectId, () => null)
      .pipe(
        Effect.tap(() =>
          Effect.logWarning("Coordinator standby disarmed", { logicalProjectId, reason }),
        ),
        Effect.asVoid,
        Effect.mapError(storeFailed),
      );

  /** Records why a lease was ignored, for the status line, and logs it. */
  const ignore = (record: CoordinatorStandbyRecord, reason: string, nowMs: number) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
      yield* store
        .modify(record.logicalProjectId, (current) =>
          current ? { ...current, lastRefusal: { at, reason }, updatedAt: at } : undefined,
        )
        .pipe(Effect.mapError(storeFailed));
      yield* Effect.logWarning("Coordinator lease ignored", {
        logicalProjectId: record.logicalProjectId,
        reason,
      });
      return yield* refuse(409, "invalid", `This machine ignored the lease (${reason}).`);
    });

  /**
   * Runs `use` under the lock of this machine's copy, with the standby record
   * re-read inside it and the caller's grant checked against that copy. A
   * refused grant from the registered coordinator disarms the standby.
   */
  const withRecord = <A>(
    caller: ReceiverCaller,
    logicalProjectId: string,
    use: (record: CoordinatorStandbyRecord, project: Project) => Effect.Effect<A, HandoffRefusal>,
  ) =>
    Effect.gen(function* () {
      const found = yield* store.get(logicalProjectId).pipe(Effect.mapError(storeFailed));
      if (found === undefined) return yield* notArmed();
      return yield* admission.withLock(
        found.projectId as ProjectId,
        Effect.gen(function* () {
          const record = yield* store.get(logicalProjectId).pipe(Effect.mapError(storeFailed));
          if (record === undefined) return yield* notArmed();
          const project = yield* projects
            .getById(record.projectId as ProjectId)
            .pipe(Effect.mapError(storeFailed));
          if (Option.isNone(project) || project.value.deletedAt !== null) {
            yield* disarm(logicalProjectId, "project-removed");
            return yield* notArmed();
          }
          const fromCoordinator = caller.sourceEnvironmentId === record.coordinator.environmentId;
          if (
            caller.grant !== null &&
            !projectInGrant(caller.grant.projects, caller.sourceEnvironmentId, project.value)
          ) {
            if (fromCoordinator) yield* disarm(logicalProjectId, "grant-scope");
            return yield* refuse(
              403,
              "needs_grant",
              "This machine's work grant for that machine does not cover this project.",
              "grant",
            );
          }
          return yield* use(record, project.value);
        }),
      );
    });

  const lease: CoordinatorLeaseReceiver["Service"]["lease"] = (caller, request) =>
    Effect.gen(function* () {
      yield* checkVersion(request.protocolVersion);
      if (
        request.kind === "pause" &&
        request.pausedUntil === undefined &&
        request.sleeping !== true
      )
        return yield* refuse(400, "invalid", "A pause names when it ends or that it sleeps.");
      return yield* withRecord(caller, request.logicalProjectId, (record, project) =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const receivedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
          const fromCoordinator = caller.sourceEnvironmentId === record.coordinator.environmentId;
          const binding = project.workspaceSettings?.coordinatorBinding;
          if (binding === undefined || binding.state === "active") {
            // This copy coordinates now. The coordinator it replaced learns of it here.
            const ownEnvironment = yield* environment.getEnvironmentId;
            const successor = project.workspaceSettings?.logicalProject?.members.find(
              (member) =>
                member.environmentId === ownEnvironment && member.projectId === project.id,
            );
            if (
              binding?.state === "active" &&
              fromCoordinator &&
              binding.predecessor?.environmentId === caller.sourceEnvironmentId &&
              successor !== undefined
            )
              return {
                takenOver: { coordinatorBinding: binding, successor },
                wantsContent: false,
                standbySleeping: false,
                receivedAt,
              };
            return yield* ignore(record, "standby-coordinates", nowMs);
          }
          if (!fromCoordinator) return yield* ignore(record, "not-registered-coordinator", nowMs);
          if (request.kind === "release") {
            if (request.epoch !== record.epoch) return yield* ignore(record, "wrong-epoch", nowMs);
            yield* disarm(record.logicalProjectId, "released");
            return { takenOver: null, wantsContent: false, standbySleeping: false, receivedAt };
          }
          const verdict = applyLease(
            record,
            {
              callerEnvironmentId: caller.sourceEnvironmentId,
              epoch: request.epoch,
              seq: request.seq,
              runningThreads: request.runningThreads,
              workers: request.workers,
              pausedUntil: request.pausedUntil,
              sleeping: request.sleeping,
            },
            nowMs,
          );
          if (!verdict.accepted) return yield* ignore(record, verdict.reason, nowMs);
          yield* store
            .modify(record.logicalProjectId, () => verdict.record)
            .pipe(Effect.mapError(storeFailed));
          const held = yield* link.digest({ projectId: project.id }).pipe(
            Effect.map((digest) => digest.replica),
            Effect.orElseSucceed(() => null),
          );
          return {
            takenOver: null,
            wantsContent:
              held === null ||
              held.digest !== request.contentDigest ||
              held.from.environmentId !== record.coordinator.environmentId,
            standbySleeping: verdict.record.standbySleeping,
            receivedAt,
          };
        }),
      );
    });

  const replica: CoordinatorLeaseReceiver["Service"]["replica"] = (caller, request) =>
    Effect.gen(function* () {
      yield* checkVersion(request.protocolVersion);
      return yield* withRecord(caller, request.logicalProjectId, () =>
        link
          .replicateFromPeer({
            logicalProjectId: request.logicalProjectId,
            callerEnvironmentId: caller.sourceEnvironmentId,
            epoch: request.epoch,
            content: {
              digest: request.digest,
              goal: request.goal,
              instructions: request.instructions,
              notes: request.notes,
              notesTruncated: request.notesTruncated,
            },
          })
          .pipe(
            Effect.mapError((error) =>
              error.code === "invalid"
                ? refuse(400, "invalid", "The content does not match its digest.")
                : error.code === "storage_failed"
                  ? refuse(500, "failed", "This machine could not keep the copy.")
                  : refuse(409, "invalid", "This machine does not take copies from that machine."),
            ),
          ),
      );
    });

  const grantRefused: CoordinatorLeaseReceiver["Service"]["grantRefused"] = (
    coordinatorEnvironmentId,
  ) =>
    Effect.gen(function* () {
      const records = yield* store.list;
      for (const record of records)
        if (record.coordinator.environmentId === coordinatorEnvironmentId)
          yield* admission.withLock(
            record.projectId as ProjectId,
            store.modify(record.logicalProjectId, (current) =>
              current?.coordinator.environmentId === coordinatorEnvironmentId ? null : undefined,
            ),
          );
      if (records.some((record) => record.coordinator.environmentId === coordinatorEnvironmentId))
        yield* Effect.logWarning("Coordinator standby disarmed", {
          coordinatorEnvironmentId,
          reason: "grant-revoked",
        });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not disarm the coordinator standby", { cause }),
      ),
    );

  return CoordinatorLeaseReceiver.of({ lease, replica, grantRefused });
});

/** Needs `CoordinatorStandbyStore`, `ProjectLink`, `ProjectService` and `ServerEnvironment`. */
export const layer = Layer.effect(CoordinatorLeaseReceiver, make).pipe(
  Layer.provide(ProjectAdmission.layer),
);
