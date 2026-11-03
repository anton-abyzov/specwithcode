/**
 * The answering side of server-driven sync of linked copies: the `linked-*`
 * and `plan-*` peer paths (`linkedSyncWire.ts`). The driving server of a pair
 * calls these with its work grant here; `LinkedPeerSync` is that driver.
 *
 * Every call names a copy on this machine and the logical project it belongs
 * to. It is answered only for a linked copy of that project whose members list
 * the caller's machine, never for a call from this machine itself, and only
 * when the caller's grant covers the copy; a caller may push only its own
 * content, plan or takeover, and a takeover only one its copy confirms.
 *
 * @module LinkedPeerRoute
 */
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import {
  type EnvironmentId,
  logicalProjectMemberKey,
  type LogicalProjectMember,
  type Project,
  type ProjectId,
  type ProjectLinkError,
  type ProjectPlanError,
  type ProjectPlanLinkExport,
  type ProjectPlanLinkMergeResult,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { projectInGrant } from "../fleet/workGrantPolicy.ts";
import { HandoffPeers } from "../handoff/handoffPeers.ts";
import { HandoffRefusal, type ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import {
  LINKED_SYNC_PROTOCOL_VERSION,
  type LinkedContentRequest,
  type LinkedContentResponse,
  type LinkedDigestRequest,
  type LinkedDigestResponse,
  type LinkedPlanExportRequest,
  type LinkedPlanMergeRequest,
  type LinkedReplicaRequest,
  type LinkedReplicaResponse,
  type LinkedSupersedeRequest,
  type LinkedSupersedeResponse,
} from "../handoff/linkedSyncWire.ts";
import { stringifyJson } from "../json.ts";
import { sha256 } from "../nodeCrypto.ts";
import { LinkedMemorySync } from "./LinkedMemorySync.ts";
import { LinkedPeerSyncState } from "./LinkedPeerSyncState.ts";
import { coordinatorContentDigest, ProjectLink } from "./ProjectLink.ts";
import { CoordinatorReleaseGuard } from "./ProjectLinkStandby.ts";
import { ProjectPlanService } from "./ProjectPlanService.ts";
import * as ProjectService from "./ProjectService.ts";

export class LinkedPeerReceiver extends Context.Service<
  LinkedPeerReceiver,
  {
    readonly digest: (
      caller: ReceiverCaller,
      request: LinkedDigestRequest,
    ) => Effect.Effect<LinkedDigestResponse, HandoffRefusal>;
    readonly content: (
      caller: ReceiverCaller,
      request: LinkedContentRequest,
    ) => Effect.Effect<LinkedContentResponse, HandoffRefusal>;
    readonly replica: (
      caller: ReceiverCaller,
      request: LinkedReplicaRequest,
    ) => Effect.Effect<LinkedReplicaResponse, HandoffRefusal>;
    readonly supersede: (
      caller: ReceiverCaller,
      request: LinkedSupersedeRequest,
    ) => Effect.Effect<LinkedSupersedeResponse, HandoffRefusal>;
    readonly planExport: (
      caller: ReceiverCaller,
      request: LinkedPlanExportRequest,
    ) => Effect.Effect<ProjectPlanLinkExport, HandoffRefusal>;
    readonly planMerge: (
      caller: ReceiverCaller,
      request: LinkedPlanMergeRequest,
    ) => Effect.Effect<ProjectPlanLinkMergeResult, HandoffRefusal>;
  }
>()("specweave-studio/project/LinkedPeerRoute/LinkedPeerReceiver") {}

const refuse = (status: number, code: HandoffRefusal["code"], message: string) =>
  new HandoffRefusal({ status, code, message });

/** A link refusal as the peer route words it. */
export const fromLinkError = (error: ProjectLinkError) =>
  error.code === "not_found"
    ? refuse(404, "not_found", "That project is not on this machine.")
    : error.code === "too_large"
      ? refuse(413, "too_large", "The content is too large.")
      : error.code === "handoff_in_progress"
        ? refuse(409, "busy", "This copy is moving to another machine; try again after.")
        : error.code === "storage_failed"
          ? refuse(500, "failed", "This machine could not read or write the copy.")
          : refuse(409, "invalid", error.detail ?? `This copy refused it (${error.code}).`);

const fromPlanError = (error: ProjectPlanError) =>
  error.code === "not_found"
    ? refuse(404, "not_found", "That plan is not on this machine.")
    : error.code === "conflict" || error.code === "paused"
      ? refuse(409, "busy", `This copy's plan is busy (${error.code}); try again later.`)
      : refuse(409, "invalid", `This copy refused the plan (${error.code}).`);

/**
 * The copy `projectId` on this machine, when `caller` may sync it: a linked,
 * live copy of `logicalProjectId` (when named) that lists the caller's
 * machine, the caller is another machine, and its grant covers the copy.
 */
export const linkedCopyFor = (
  projects: ProjectService.ProjectService["Service"],
  selfEnvironmentId: EnvironmentId,
  caller: ReceiverCaller,
  projectId: ProjectId,
  logicalProjectId?: string,
) =>
  Effect.gen(function* () {
    if (caller.sourceEnvironmentId === selfEnvironmentId)
      return yield* refuse(403, "needs_grant", "A machine does not sync with itself.");
    const found = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(() => refuse(500, "failed", "This machine could not read projects.")));
    if (Option.isNone(found) || found.value.deletedAt !== null)
      return yield* refuse(404, "not_found", "That project is not on this machine.");
    const project = found.value;
    const identity = project.workspaceSettings?.logicalProject;
    if (isPersonalAssistantProject(project) || identity === undefined)
      return yield* refuse(403, "needs_grant", "Only a linked copy of this project may sync it.");
    // Membership first: a machine outside the project learns nothing about it.
    if (!identity.members.some((member) => member.environmentId === caller.sourceEnvironmentId))
      return yield* refuse(403, "needs_grant", "Only a linked copy of this project may sync it.");
    if (logicalProjectId !== undefined && identity.id !== logicalProjectId)
      return yield* refuse(409, "invalid", "That copy belongs to another shared project.");
    if (
      caller.grant !== null &&
      !projectInGrant(caller.grant.projects, caller.sourceEnvironmentId, project)
    )
      return yield* refuse(403, "needs_grant", "This machine's work grant does not cover it.");
    return project;
  });

/** Of the plan a copy exports: equal plans give equal digests on every machine. */
export const planDigest = (exported: ProjectPlanLinkExport) =>
  sha256([stringifyJson(exported.plan)]).toString("hex");

/** This machine's member entry for `project`, as its identity lists it. */
export const selfMemberOf = (
  project: Project,
  selfEnvironmentId: EnvironmentId,
): LogicalProjectMember | undefined =>
  project.workspaceSettings?.logicalProject?.members.find(
    (member) => member.environmentId === selfEnvironmentId && member.projectId === project.id,
  );

/**
 * What a pass compares about a copy on this machine, before it moves
 * anything. Memory and plan digests are null when they cannot be read now.
 */
export const describeCopy = (
  services: {
    readonly link: Pick<ProjectLink["Service"], "digest">;
    readonly memory: Pick<LinkedMemorySync["Service"], "memoryExport">;
    readonly plans: Pick<ProjectPlanService["Service"], "exportLinked">;
  },
  project: Project,
  member: LogicalProjectMember,
) =>
  Effect.gen(function* () {
    const digest = yield* services.link.digest({ projectId: project.id });
    const memoryDigest = yield* services.memory
      .memoryExport({ projectId: project.id, digestOnly: true })
      .pipe(
        Effect.map((exported) => exported.digest ?? null),
        Effect.orElseSucceed(() => null),
      );
    const plan = yield* services.plans.exportLinked({ projectId: project.id }).pipe(
      Effect.map(planDigest),
      Effect.orElseSucceed(() => null),
    );
    return {
      protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
      member,
      binding: project.workspaceSettings?.coordinatorBinding ?? null,
      coordinatorDigest: digest.digest,
      replica:
        digest.replica === null
          ? null
          : {
              from: digest.replica.from,
              digest: digest.replica.digest,
              ...(digest.replica.fromEpoch === undefined
                ? {}
                : { fromEpoch: digest.replica.fromEpoch }),
            },
      memoryDigest,
      planDigest: plan,
    } satisfies LinkedDigestResponse;
  });

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const link = yield* ProjectLink;
  const memory = yield* LinkedMemorySync;
  const plans = yield* ProjectPlanService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const selfEnvironmentId = yield* environment.getEnvironmentId;
  const guard = yield* Effect.serviceOption(CoordinatorReleaseGuard);
  const state = yield* Effect.serviceOption(LinkedPeerSyncState);
  const peers = yield* Effect.serviceOption(HandoffPeers);

  /**
   * The copy the request names, after its version and the caller are checked;
   * the caller reached this machine, so its pairs here stop backing off.
   */
  const copyFor = (
    caller: ReceiverCaller,
    request: { readonly protocolVersion: number; readonly logicalProjectId: string },
    projectId: ProjectId,
  ) =>
    Effect.gen(function* () {
      if (request.protocolVersion !== LINKED_SYNC_PROTOCOL_VERSION)
        return yield* new HandoffRefusal({
          status: 409,
          code: "invalid",
          message: "The two machines run different versions of linked sync. Update both.",
          check: "version",
        });
      const project = yield* linkedCopyFor(
        projects,
        selfEnvironmentId,
        caller,
        projectId,
        request.logicalProjectId,
      );
      if (Option.isSome(state)) yield* state.value.peerSeen(caller.sourceEnvironmentId);
      return project;
    });

  const ownMember = (project: Project) => {
    const member = selfMemberOf(project, selfEnvironmentId);
    return member === undefined
      ? Effect.fail(refuse(409, "invalid", "This copy is not listed in its shared project."))
      : Effect.succeed(member);
  };

  /** Only the caller's own copy may push to this one. */
  const fromCaller = (caller: ReceiverCaller, environmentId: EnvironmentId) =>
    environmentId === caller.sourceEnvironmentId
      ? Effect.void
      : Effect.fail(refuse(403, "needs_grant", "A machine may send only its own copy."));

  /**
   * A takeover is the caller's own word: before this copy gives way, the copy
   * that took over must confirm it over the peer route, with this machine's
   * grant there, holding that very binding with this copy as its predecessor.
   */
  const confirmTakeover = (project: Project, request: LinkedSupersedeRequest) =>
    Effect.gen(function* () {
      const self = yield* ownMember(project);
      if (Option.isNone(peers))
        return yield* refuse(409, "invalid", "This machine cannot confirm the takeover.");
      const answer = yield* peers.value
        .linkedDigest(request.successor.environmentId, {
          protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
          logicalProjectId: request.logicalProjectId,
          projectId: request.successor.projectId,
        })
        .pipe(
          Effect.mapError(() =>
            refuse(
              409,
              "busy",
              "This copy could not confirm the takeover with the copy that took over; try again later.",
            ),
          ),
        );
      const claimed = request.coordinatorBinding;
      const held = answer.binding;
      if (
        held === null ||
        held.state !== "active" ||
        held.operationId !== claimed.operationId ||
        held.epoch !== claimed.epoch ||
        held.takenOverAt !== claimed.takenOverAt ||
        held.predecessor === undefined ||
        logicalProjectMemberKey(held.predecessor) !== logicalProjectMemberKey(self) ||
        logicalProjectMemberKey(answer.member) !== logicalProjectMemberKey(request.successor)
      )
        return yield* refuse(409, "invalid", "The copy that took over does not confirm it.");
    });

  return LinkedPeerReceiver.of({
    digest: (caller, request) =>
      Effect.gen(function* () {
        const project = yield* copyFor(caller, request, request.projectId);
        const member = yield* ownMember(project);
        return yield* describeCopy({ link, memory, plans }, project, member).pipe(
          Effect.mapError(fromLinkError),
        );
      }),
    content: (caller, request) =>
      Effect.gen(function* () {
        const project = yield* copyFor(caller, request, request.projectId);
        const binding = project.workspaceSettings?.coordinatorBinding;
        if (binding?.state !== "active")
          return yield* refuse(409, "invalid", "This copy does not coordinate.");
        const preview = yield* link
          .preview({ projectId: project.id })
          .pipe(Effect.mapError(fromLinkError));
        return {
          member: preview.member,
          epoch: binding.epoch,
          digest: coordinatorContentDigest(preview),
          goal: preview.goal,
          instructions: preview.instructions,
          notes: preview.notes,
          notesTruncated: preview.notesTruncated,
        };
      }),
    replica: (caller, request) =>
      Effect.gen(function* () {
        const project = yield* copyFor(caller, request, request.projectId);
        yield* fromCaller(caller, request.from.environmentId);
        return yield* link
          .replicateFromMember({
            projectId: project.id,
            logicalProjectId: request.logicalProjectId,
            from: request.from,
            fromEpoch: request.fromEpoch,
            content: {
              digest: request.digest,
              goal: request.goal,
              instructions: request.instructions,
              notes: request.notes,
              notesTruncated: request.notesTruncated,
            },
          })
          .pipe(Effect.mapError(fromLinkError));
      }),
    supersede: (caller, request) =>
      Effect.gen(function* () {
        const project = yield* copyFor(caller, request, request.projectId);
        yield* fromCaller(caller, request.successor.environmentId);
        yield* confirmTakeover(project, request);
        // The standby this copy leases to is released, and answers, before it gives way.
        if (Option.isSome(guard))
          yield* guard.value
            .releaseBefore({
              projectId: project.id,
              unless: request.successor,
              changeAnyway: false,
              reason: "supersede",
            })
            .pipe(Effect.mapError(fromLinkError));
        const result = yield* link
          .supersede({
            projectId: project.id,
            logicalProjectId: request.logicalProjectId,
            successor: request.successor,
            coordinatorBinding: request.coordinatorBinding,
          })
          .pipe(Effect.mapError(fromLinkError));
        return { coordinatorBinding: result.coordinatorBinding, replayed: result.replayed };
      }),
    planExport: (caller, request) =>
      copyFor(caller, request, request.projectId).pipe(
        Effect.andThen(
          plans.exportLinked({ projectId: request.projectId }).pipe(Effect.mapError(fromPlanError)),
        ),
      ),
    planMerge: (caller, request) =>
      Effect.gen(function* () {
        yield* copyFor(caller, request, request.projectId);
        yield* fromCaller(caller, request.peer.environmentId);
        return yield* plans
          .mergeLinked({ projectId: request.projectId, peer: request.peer, export: request.export })
          .pipe(Effect.mapError(fromPlanError));
      }),
  });
});

/**
 * Needs `ProjectService`, `ProjectLink`, `LinkedMemorySync`, `ProjectPlanService`
 * and `ServerEnvironment`; uses `CoordinatorReleaseGuard` and
 * `LinkedPeerSyncState` when the server provides them, and `HandoffPeers` to
 * confirm a takeover (without it, no copy gives way over this route).
 */
export const layer = Layer.effect(LinkedPeerReceiver, make);
