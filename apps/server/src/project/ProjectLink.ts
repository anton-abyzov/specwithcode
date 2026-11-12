import {
  isPersonalAssistantProject,
  PERSONAL_ASSISTANT_PRIVATE_MESSAGE,
} from "@specweave-studio/shared/personalAssistant";
import {
  CommandId,
  compareFingerprints,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  noteNameCandidates,
  LOGICAL_PROJECT_MEMBER_ROOT_MAX_LENGTH,
  logicalProjectMemberKey,
  type LogicalProject,
  type LogicalProjectMember,
  type Project,
  type ProjectCoordinatorBinding,
  type ProjectCoordinatorReplica,
  type ProjectDisconnectedTurn,
  type ProjectFingerprintInput,
  type ProjectFingerprintResult,
  PROJECT_LINK_MAX_BYTES,
  type ProjectLinkAcceptInput,
  type ProjectLinkAcceptResult,
  type ProjectLinkCommitInput,
  type ProjectLinkCommitResult,
  type ProjectLinkDigest,
  type ProjectLinkDigestInput,
  ProjectLinkError,
  type ProjectLinkNote,
  ProjectFaviconPath,
  type ProjectLinkNoteWrite,
  type ProjectLinkSharedIcon,
  type ProjectLinkPrepareInput,
  type ProjectLinkSyncMembersInput,
  type ProjectLinkPrepareResult,
  type ProjectLinkPreview,
  type ProjectLinkPreviewInput,
  type ProjectLinkRefusal,
  type ProjectLinkReplicateInput,
  type ProjectLinkReplicateResult,
  type ProjectSetStandbyInput,
  type ProjectStartCoordinatorInput,
  type ProjectStartCoordinatorResult,
  type ProjectSupersedeInput,
  type ProjectSupersedeResult,
  type ProjectTakeoverInput,
  type ProjectTakeoverResult,
  type ProjectUnlinkInput,
  type ProjectUnlinkResult,
  ProjectId,
  type RepositoryFingerprint,
  ThreadId,
  WS_METHODS,
  WsProjectLinkRpcGroup,
} from "@specweave-studio/contracts";
import {
  hasSavedProjectIcon,
  isPortableProjectFaviconPath,
} from "@specweave-studio/shared/projectFavicon";
import { teamRulesMachineLinkRefusal } from "@specweave-studio/shared/teamRules";
import { currentTeamRules } from "../teamRules/TeamRules.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { sha256 } from "../nodeCrypto.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProjectOwnershipUpdate } from "../orchestration-v2/ProjectCommands.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as WorkerEpochStore from "../fleet/WorkerEpochStore.ts";
import * as CoordinatorReplicas from "./CoordinatorReplicas.ts";
import { CoordinatorRearmStore } from "./CoordinatorRearmStore.ts";
import * as CoordinatorRole from "./CoordinatorRole.ts";
import { CoordinatorStandbyStore } from "./CoordinatorStandbyStore.ts";
import * as LinkedMemorySync from "./LinkedMemorySync.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import {
  type AddPredecessorMembersInput,
  type AdoptMembersInput,
  type AdoptMembersResult,
  coordinatorClaimWindow,
  makeProjectLinkMembers,
} from "./ProjectLinkMembers.ts";
import { fingerprintFolder } from "./projectFingerprint.ts";
import { LinkedPeerSyncState } from "./LinkedPeerSyncState.ts";
import { RoutineCopies } from "../scheduledTasks/ScheduledTaskCopies.ts";
import {
  CoordinatorReleaseGuard,
  keptRoutinesDigest,
  makeProjectLinkStandby,
  type PeerReplicaContent,
  peerReplicaMark,
  type ProjectLinkStandbyMethods,
} from "./ProjectLinkStandby.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";

/**
 * Links a project with its copy on another machine, keeping one coordinator.
 * Each machine runs its own half; the caller (the app, or server code such as a
 * folder copy that ends in "link") carries results between them:
 *
 * 1. `prepare` on the kept copy: it gets a shared identity if it has none.
 * 2. `preview` on both copies: notes, goal, instructions and fingerprints to compare.
 * 3. `accept` on the joining copy: it adopts the identity and relinquishes its
 *    coordinator; its ordinary workers keep running.
 * 4. `commit` on the kept copy: it lists the joined copy and writes chosen notes.
 *
 * Between 3 and 4 the kept copy still coordinates and sending works; retrying the
 * same operation id finishes the link. `unlink` reverses it from either side.
 */
export class ProjectLink extends Context.Service<
  ProjectLink,
  {
    readonly fingerprint: (
      input: ProjectFingerprintInput,
    ) => Effect.Effect<ProjectFingerprintResult, ProjectLinkError>;
    readonly preview: (
      input: ProjectLinkPreviewInput,
    ) => Effect.Effect<ProjectLinkPreview, ProjectLinkError>;
    readonly prepare: (
      input: ProjectLinkPrepareInput,
    ) => Effect.Effect<ProjectLinkPrepareResult, ProjectLinkError>;
    /**
     * `copiedFromKept`: this machine verified the copy is a folder copy of the kept
     * project it just applied, so the fingerprint comparison (which a plain folder
     * with no repository never passes) is not needed.
     */
    readonly accept: (
      input: ProjectLinkAcceptInput,
      options?: { readonly copiedFromKept?: boolean },
    ) => Effect.Effect<ProjectLinkAcceptResult, ProjectLinkError>;
    readonly commit: (
      input: ProjectLinkCommitInput,
    ) => Effect.Effect<ProjectLinkCommitResult, ProjectLinkError>;
    readonly unlink: (
      input: ProjectUnlinkInput,
    ) => Effect.Effect<ProjectUnlinkResult, ProjectLinkError>;
    readonly digest: (
      input: ProjectLinkDigestInput,
    ) => Effect.Effect<ProjectLinkDigest, ProjectLinkError>;
    readonly replicate: (
      input: ProjectLinkReplicateInput,
    ) => Effect.Effect<ProjectLinkReplicateResult, ProjectLinkError>;
    readonly takeover: (
      input: ProjectTakeoverInput,
    ) => Effect.Effect<ProjectTakeoverResult, ProjectLinkError>;
    readonly supersede: (
      input: ProjectSupersedeInput,
    ) => Effect.Effect<ProjectSupersedeResult, ProjectLinkError>;
    /** Internal: a linked coordinator's content, carried by server-driven sync (`LinkedPeerSync`). */
    readonly replicateFromMember: (
      input: ReplicateFromMemberInput,
    ) => Effect.Effect<ProjectLinkReplicateResult, ProjectLinkError>;
    readonly startCoordinator: (
      input: ProjectStartCoordinatorInput,
    ) => Effect.Effect<ProjectStartCoordinatorResult, ProjectLinkError>;
    /** A transferred copy adopts its coordinator's member list (`ProjectLinkMembers`). */
    readonly adoptMembers: (
      input: AdoptMembersInput,
    ) => Effect.Effect<AdoptMembersResult, ProjectLinkError>;
    /** A copy that took over adds the members its predecessor lists. */
    readonly addPredecessorMembers: (
      input: AddPredecessorMembersInput,
    ) => Effect.Effect<{ readonly changed: boolean }, ProjectLinkError>;
    /**
     * Installs the server-driven half of member sync (`LinkedPeerSync`, which
     * holds the peer route): asking the coordinator for its list, and
     * starting a pass when this copy's list changes.
     */
    readonly registerMembersSync: (sync: LinkedMembersSync) => Effect.Effect<void>;
  } & ProjectLinkStandbyMethods
>()("specweave-studio/project/ProjectLink") {}

/** What `LinkedPeerSync` does for member sync; absent on a server without it. */
export interface LinkedMembersSync {
  /** Asks the copy this one gave way to for its member list and adopts it; never fails. */
  readonly refresh: (projectId: ProjectId) => Effect.Effect<void>;
  /** This copy's member list changed: its pairs sync now. */
  readonly expedite: (projectId: ProjectId) => Effect.Effect<void>;
}

/** The content of a coordinator copy on another machine, for this member's replica. */
export interface ReplicateFromMemberInput {
  readonly projectId: ProjectId;
  readonly logicalProjectId: string;
  /** The coordinator copy it is from: a listed member on another machine. */
  readonly from: Pick<LogicalProjectMember, "environmentId" | "projectId">;
  /** That copy's epoch; a lower one never replaces a newer coordinator's copy. */
  readonly fromEpoch: number;
  readonly content: PeerReplicaContent;
}

const fail = (code: ProjectLinkError["code"], detail?: string) =>
  Effect.fail(new ProjectLinkError({ code, ...(detail ? { detail } : {}) }));

/** A personal assistant is never linked, taken over, started or superseded from another machine. */
const refusePersonal = (project: Pick<Project, "workspaceSettings">) =>
  isPersonalAssistantProject(project)
    ? fail("not_code_project", PERSONAL_ASSISTANT_PRIVATE_MESSAGE)
    : Effect.void;

/** The same listed copy; the folder a member records never decides a match. */
const sameMember = (a: LogicalProjectMember, b: LogicalProjectMember) =>
  a.environmentId === b.environmentId &&
  a.projectId === b.projectId &&
  a.coordinatorThreadId === b.coordinatorThreadId;

/** The identity with `self`'s entry recording its folder, when that entry predates folders. */
const withOwnRoot = (identity: LogicalProject, self: LogicalProjectMember): LogicalProject => ({
  ...identity,
  members: identity.members.map((member) =>
    member.workspaceRoot === undefined && sameMember(member, self) ? self : member,
  ),
});

/** An absolute icon path names a file on one machine, so it never crosses a link. */
const sharedIconOf = (
  project: Pick<Project, "projectIcon" | "faviconPath">,
): ProjectLinkSharedIcon | undefined => {
  const projectIcon = project.projectIcon ?? null;
  const faviconPath =
    project.faviconPath &&
    isPortableProjectFaviconPath(project.faviconPath) &&
    Schema.is(ProjectFaviconPath)(project.faviconPath)
      ? project.faviconPath
      : null;
  return projectIcon === null && faviconPath === null ? undefined : { projectIcon, faviconPath };
};

/** Members keyed by machine and project, newest entry kept. */
const mergeMembers = (...lists: ReadonlyArray<ReadonlyArray<LogicalProjectMember>>) => [
  ...new Map(lists.flat().map((member) => [logicalProjectMemberKey(member), member])).values(),
];

/**
 * Which version of a coordinator's notes, goal and instructions a copy holds:
 * equal content gives an equal digest on every machine.
 */
export function coordinatorContentDigest(content: {
  readonly goal: string;
  readonly instructions: string;
  readonly notes: ReadonlyArray<{ readonly name: string; readonly content: string }>;
}): string {
  const notes = content.notes
    .map((note) => [note.name, note.content] as const)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return sha256([JSON.stringify([content.goal, content.instructions, notes])]).toString("hex");
}

/** Changes whenever `coordinatorContentDigest` would, without reading any note's content. */
const contentSignature = (
  settings: { readonly goal: string; readonly instructions: string },
  files: ReadonlyArray<{
    readonly name: string;
    readonly revision: number;
    readonly byteLength: number;
  }>,
) =>
  JSON.stringify([
    settings.goal,
    settings.instructions,
    files.map((file) => [file.name, file.revision, file.byteLength]),
  ]);

/** Why a copy cannot keep its coordinator, or join another copy as a member. */
export function linkRefusals(
  project: Pick<Project, "id" | "workspaceSettings">,
  coordinatorBusy: boolean,
): { keep: ProjectLinkRefusal | null; join: ProjectLinkRefusal | null } {
  const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
  const common: ProjectLinkRefusal | null =
    settings.kind !== "code"
      ? "not_code_project"
      : settings.archived
        ? "archived"
        : settings.paused
          ? "paused"
          : settings.coordinatorBinding?.state === "transferring"
            ? "handoff_in_progress"
            : null;
  const shared =
    settings.coordinatorBinding?.state === "transferred" ||
    (settings.logicalProject?.members ?? []).some((member) => member.projectId !== project.id);
  return {
    keep:
      common ?? (settings.coordinatorBinding?.state === "transferred" ? "not_coordinator" : null),
    join: common ?? (shared ? "already_shared" : coordinatorBusy ? "coordinator_busy" : null),
  };
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const workspace = yield* ProjectWorkspaceService.ProjectWorkspaceService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const replicas = yield* CoordinatorReplicas.CoordinatorReplicas;
  const standbyStore = yield* CoordinatorStandbyStore;
  const rearmStore = yield* CoordinatorRearmStore;
  const publishRole = yield* CoordinatorRole.publisher;
  const routineCopies = Option.getOrUndefined(yield* Effect.serviceOption(RoutineCopies));
  let membersSync: LinkedMembersSync | undefined;
  const expedite = (projectId: ProjectId) =>
    Effect.suspend(() =>
      membersSync === undefined ? Effect.void : membersSync.expedite(projectId),
    );

  const load = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(() => new ProjectLinkError({ code: "storage_failed" })),
      Effect.flatMap((found) =>
        Option.isSome(found) && found.value.deletedAt === null
          ? Effect.succeed(found.value)
          : fail("not_found"),
      ),
    );

  /**
   * This copy as identities list it; an existing entry wins so reciprocity holds.
   * Its folder is always this project's own, never one a caller sent.
   */
  const selfMember = (project: Project) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const listed = project.workspaceSettings?.logicalProject?.members.find(
        (member) => member.environmentId === environmentId && member.projectId === project.id,
      );
      const member: LogicalProjectMember = listed ?? {
        environmentId,
        projectId: project.id,
        coordinatorThreadId:
          project.workspaceSettings?.coordinatorThreadId ??
          ThreadId.make(`project-coordinator:${project.id}`),
      };
      return project.workspaceRoot.length <= LOGICAL_PROJECT_MEMBER_ROOT_MAX_LENGTH
        ? { ...member, workspaceRoot: project.workspaceRoot }
        : member;
    });

  const coordinatorShell = (member: LogicalProjectMember) =>
    projections.getThreadShell(member.coordinatorThreadId).pipe(Effect.orElseSucceed(() => null));

  const writeOwnership = (
    project: Project,
    commandPrefix: string,
    operationId: string,
    ownership: Omit<ProjectOwnershipUpdate, "expectedRevision">,
    patch?: { readonly goal: string; readonly instructions: string },
  ) => {
    const revision = project.workspaceSettings?.revision ?? 0;
    return projects
      .update({
        projectId: project.id,
        // The revision keeps a retry after a concurrent edit from replaying a stale rejection.
        commandId: CommandId.make(`${commandPrefix}:${operationId}:${revision}`),
        ownership: { ...ownership, expectedRevision: revision },
        ...(patch ? { workspaceSettings: { ...patch, expectedRevision: revision } } : {}),
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ProjectNotFoundError"
            ? new ProjectLinkError({ code: "not_found" })
            : new ProjectLinkError({ code: "conflict", detail: error.message.slice(0, 900) }),
        ),
      );
  };

  /** Checks every note against its expected revision before writing any. */
  const writeNotes = (projectId: ProjectId, notes: ReadonlyArray<ProjectLinkNoteWrite>) =>
    Effect.gen(function* () {
      if (
        notes.reduce((sum, note) => sum + Buffer.byteLength(note.content), 0) >
        PROJECT_LINK_MAX_BYTES
      )
        return yield* fail("too_large");
      const pending: ProjectLinkNoteWrite[] = [];
      for (const note of notes) {
        const current = yield* workspace
          .readMemory({ projectId, name: note.name })
          .pipe(Effect.option);
        if (Option.isSome(current) && current.value.content === note.content) continue;
        // A kept-both copy never replaces a note that holds other text.
        if (note.createOnly && Option.isSome(current))
          return yield* fail("notes_changed", `"${note.name}" already holds another note.`);
        if ((Option.isSome(current) ? current.value.revision : null) !== note.expectedRevision)
          return yield* fail("notes_changed", `"${note.name}" changed.`);
        pending.push(note);
      }
      for (const { createOnly: _createOnly, ...note } of pending)
        yield* workspace
          .writeMemory({ projectId, ...note })
          .pipe(
            Effect.mapError((error) =>
              error.code === "conflict"
                ? new ProjectLinkError({ code: "notes_changed", detail: `"${note.name}" changed.` })
                : new ProjectLinkError({ code: "storage_failed" }),
            ),
          );
      return pending.length;
    });

  const fingerprintOf = (workspaceRoot: string) => fingerprintFolder(workspaceRoot);

  const fingerprint: ProjectLink["Service"]["fingerprint"] = (input) =>
    Effect.gen(function* () {
      if ((input.projectId === undefined) === (input.workspaceRoot === undefined))
        return yield* fail("invalid", "Give a project or a folder.");
      const workspaceRoot =
        input.projectId !== undefined
          ? (yield* load(input.projectId)).workspaceRoot
          : input.workspaceRoot!;
      return { workspaceRoot, fingerprint: yield* fingerprintOf(workspaceRoot) };
    });

  /** A copy's notes (as many as one request carries), goal and instructions. */
  const readContent = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const read = yield* workspace
        .readWorkspace({ projectId })
        .pipe(Effect.mapError(() => new ProjectLinkError({ code: "storage_failed" })));
      const files = yield* workspace
        .readMemoryFiles({ projectId })
        .pipe(Effect.mapError(() => new ProjectLinkError({ code: "storage_failed" })));
      const notes: ProjectLinkNote[] = [];
      let bytes = 0;
      let notesTruncated = false;
      for (const file of files) {
        if (bytes + file.byteLength > PROJECT_LINK_MAX_BYTES) {
          notesTruncated = true;
          continue;
        }
        bytes += file.byteLength;
        notes.push({ name: file.name, revision: file.revision, content: file.content });
      }
      return {
        goal: read.settings.goal,
        instructions: read.settings.instructions,
        notes,
        notesTruncated,
      };
    });

  // Every note write bumps its revision, so unchanged revisions mean an unchanged digest.
  const digests = new Map<ProjectId, { readonly signature: string; readonly digest: string }>();
  const contentDigest = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const read = yield* workspace
        .readWorkspace({ projectId })
        .pipe(Effect.mapError(() => new ProjectLinkError({ code: "storage_failed" })));
      const signature = contentSignature(read.settings, read.memory.files);
      const known = digests.get(projectId);
      if (known?.signature === signature) return known.digest;
      const digest = coordinatorContentDigest(yield* readContent(projectId));
      digests.set(projectId, { signature, digest });
      return digest;
    });

  const readReplica = (project: Project) =>
    replicas.read(project.id).pipe(
      Effect.mapError(() => new ProjectLinkError({ code: "storage_failed" })),
      // A replica of another identity (from before an unlink) is not this one's.
      Effect.map((found) =>
        Option.filter(
          found,
          (replica) => replica.logicalProjectId === project.workspaceSettings?.logicalProject?.id,
        ),
      ),
    );

  /** Coordinator turns `member` ran from `since`, newest last. */
  const turnsSince = (member: LogicalProjectMember, since: string | undefined) =>
    since === undefined
      ? Effect.succeed<ReadonlyArray<ProjectDisconnectedTurn>>([])
      : projections.getThreadProjection(member.coordinatorThreadId).pipe(
          Effect.map((projection) => {
            const from = Date.parse(since);
            return projection.runs
              .filter((run) => DateTime.toEpochMillis(run.requestedAt) >= from)
              .toSorted(
                (left, right) =>
                  DateTime.toEpochMillis(left.requestedAt) -
                  DateTime.toEpochMillis(right.requestedAt),
              )
              .slice(-200)
              .map((run): ProjectDisconnectedTurn => ({
                threadId: member.coordinatorThreadId,
                runId: run.id,
                requestedAt: DateTime.formatIso(run.requestedAt),
                request:
                  projection.messages
                    .find((message) => message.id === run.userMessageId)
                    ?.text.slice(0, 400) ?? null,
              }));
          }),
          Effect.orElseSucceed((): ReadonlyArray<ProjectDisconnectedTurn> => []),
        );

  const preview: ProjectLink["Service"]["preview"] = ({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* load(projectId);
      // Another machine never reads a personal assistant's goal, instructions or notes.
      yield* refusePersonal(project);
      const member = yield* selfMember(project);
      const { goal, instructions, notes, notesTruncated } = yield* readContent(projectId);
      const binding = project.workspaceSettings?.coordinatorBinding;
      const replica =
        binding?.state === "transferred" ? yield* readReplica(project) : Option.none();
      const shell = yield* coordinatorShell(member);
      const refusals = linkRefusals(project, shell?.activeRunId != null);
      const activity = shell?.latestRunRequestedAt ?? shell?.latestUserMessageAt ?? null;
      return {
        member,
        title: project.workspaceSettings?.logicalProject?.title ?? project.title,
        workspaceRoot: project.workspaceRoot,
        logicalProject: project.workspaceSettings?.logicalProject ?? null,
        coordinatorBinding: project.workspaceSettings?.coordinatorBinding ?? null,
        fingerprint: yield* fingerprintOf(project.workspaceRoot),
        goal,
        instructions,
        notes,
        notesTruncated,
        lastCoordinatorActivityAt: activity === null ? null : DateTime.formatIso(activity),
        keepRefusal: refusals.keep,
        joinRefusal: refusals.join,
        replica: Option.getOrNull(replica),
        ranWhileDisconnected:
          binding?.state === "transferred" ? yield* turnsSince(member, binding.takenOverAt) : [],
      };
    });

  const prepare: ProjectLink["Service"]["prepare"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        const kept = yield* selfMember(project);
        if (input.joining.environmentId === kept.environmentId) return yield* fail("same_machine");
        const refusal = linkRefusals(project, false).keep;
        if (refusal) return yield* fail(refusal);
        const binding: ProjectCoordinatorBinding = project.workspaceSettings
          ?.coordinatorBinding ?? {
          epoch: 0,
          state: "active",
        };
        let logicalProject = project.workspaceSettings?.logicalProject;
        const adopted = logicalProject === undefined;
        if (logicalProject === undefined) {
          const id = `logical:${yield* randomUuidV4}`;
          logicalProject = {
            id,
            title: project.title,
            coordinatorId: `coordinator:${id}`,
            members: [kept],
          };
          yield* writeOwnership(project, "project-link-adopt", input.operationId, {
            mode: "adopt-identity",
            logicalProject,
            coordinatorBinding: binding,
          });
        }
        const sharedIcon = sharedIconOf(project);
        return {
          operationId: input.operationId,
          kept,
          // As commit will list it, so the joining copy records the kept copy's folder too.
          logicalProject: withOwnRoot(logicalProject, kept),
          coordinatorBinding: binding,
          fingerprint: yield* fingerprintOf(project.workspaceRoot),
          adopted,
          ...(sharedIcon ? { sharedIcon } : {}),
        };
      }),
    );

  const accept: ProjectLink["Service"]["accept"] = (input, options) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        const self = yield* selfMember(project);
        if (input.kept.environmentId === self.environmentId) return yield* fail("same_machine");
        if (
          input.coordinatorBinding.state !== "active" ||
          !input.logicalProject.members.some((member) => sameMember(member, input.kept))
        )
          return yield* fail("invalid");
        const current = project.workspaceSettings?.logicalProject;
        const binding = project.workspaceSettings?.coordinatorBinding;
        if (current?.id === input.logicalProject.id) {
          // Already this identity's member: a retry, or the same link done before.
          if (
            binding?.state === "transferred" &&
            binding.successor !== undefined &&
            sameMember(binding.successor, input.kept)
          )
            return {
              operationId: input.operationId,
              member: self,
              logicalProject: current,
              coordinatorBinding: binding,
              replayed: true,
            };
          return yield* fail("conflict", "This copy already belongs to that project.");
        }
        const shell = yield* coordinatorShell(self);
        const refusal = linkRefusals(project, shell?.activeRunId != null).join;
        if (refusal) return yield* fail(refusal);
        if (options?.copiedFromKept !== true) {
          const own = yield* fingerprintOf(project.workspaceRoot);
          if (!compareFingerprints(own, input.keptFingerprint).rootMatches)
            return yield* fail("repository_mismatch", rootSummary(own, input.keptFingerprint));
        }
        const logicalProject: LogicalProject = {
          ...input.logicalProject,
          members: mergeMembers(input.logicalProject.members, [self]),
        };
        const relinquished: ProjectCoordinatorBinding = {
          // The kept epoch: one active owner at the highest epoch, this copy relinquished beside it.
          epoch: input.coordinatorBinding.epoch,
          state: "transferred",
          operationId: input.operationId,
          successor: input.kept,
        };
        yield* writeOwnership(project, "project-link-join", input.operationId, {
          mode: "join-as-member",
          joinExpectedLogicalProjectId: current?.id ?? null,
          logicalProject,
          coordinatorBinding: relinquished,
        });
        yield* publishRole({
          kind: "gave-way",
          projectId: project.id,
          logicalProjectId: logicalProject.id,
          epoch: relinquished.epoch,
          successor: input.kept,
        });
        // A project shares one icon. This never fails the link: the icon only decorates it.
        const sharedIcon = input.sharedIcon && sharedIconOf(input.sharedIcon);
        if (sharedIcon && !hasSavedProjectIcon(project)) {
          yield* projects
            .update({
              projectId: project.id,
              commandId: CommandId.make(`project-link-icon:${input.operationId}`),
              ...sharedIcon,
            })
            .pipe(Effect.ignore);
        }
        return {
          operationId: input.operationId,
          member: self,
          logicalProject,
          coordinatorBinding: relinquished,
          replayed: false,
        };
      }),
    );

  const commit: ProjectLink["Service"]["commit"] = (input) =>
    commitLocked(input).pipe(
      // The other copies learn the new member on their next pass, which starts now.
      Effect.tap((result) => (result.replayed ? Effect.void : expedite(input.projectId))),
    );

  const commitLocked = (input: ProjectLinkCommitInput) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        const kept = yield* selfMember(project);
        if (input.joining.environmentId === kept.environmentId) return yield* fail("same_machine");
        const identity = project.workspaceSettings?.logicalProject;
        if (!identity) return yield* fail("conflict", "Prepare the link on this copy first.");
        const refusal = linkRefusals(project, false).keep;
        if (refusal) return yield* fail(refusal);
        const listed = identity.members.some((member) => sameMember(member, input.joining));
        const notesWritten = yield* writeNotes(project.id, input.notes);
        if (listed)
          return {
            operationId: input.operationId,
            logicalProject: identity,
            notesWritten,
            replayed: true,
          };
        if (
          identity.members.some(
            (member) => logicalProjectMemberKey(member) === logicalProjectMemberKey(input.joining),
          )
        )
          return yield* fail("conflict", "That copy is listed with another coordinator thread.");
        // The joining entry keeps the folder its own machine recorded when it accepted.
        const own = withOwnRoot(identity, kept);
        const logicalProject = { ...own, members: [...own.members, input.joining] };
        // Reread: writing notes does not change settings, but stay exact about the revision.
        yield* writeOwnership(
          yield* load(input.projectId),
          "project-link-member",
          input.operationId,
          {
            mode: "link-member",
            logicalProject,
            coordinatorBinding: project.workspaceSettings?.coordinatorBinding ?? {
              epoch: 0,
              state: "active",
            },
          },
        );
        return { operationId: input.operationId, logicalProject, notesWritten, replayed: false };
      }),
    );

  const unlink: ProjectLink["Service"]["unlink"] = (input) =>
    unlinkLocked(input).pipe(
      Effect.tap((result) =>
        input.side === "coordinator" && !result.replayed ? expedite(input.projectId) : Effect.void,
      ),
    );

  /**
   * A coordinator that replaced a predecessor remembers whom it unlinked, so
   * the predecessor's older list (`addPredecessorMembers`) never brings them back.
   */
  const rememberRemoved = (
    binding: ProjectCoordinatorBinding,
    member: Pick<LogicalProjectMember, "environmentId" | "projectId">,
  ): ProjectCoordinatorBinding => {
    if (binding.predecessor === undefined) return binding;
    const key = logicalProjectMemberKey(member);
    const kept = (binding.removedMembers ?? []).filter(
      (removed) => logicalProjectMemberKey(removed) !== key,
    );
    return {
      ...binding,
      removedMembers: [
        ...kept,
        { environmentId: member.environmentId, projectId: member.projectId },
      ].slice(-256),
    };
  };

  const unlinkLocked = (input: ProjectUnlinkInput) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        const self = yield* selfMember(project);
        const identity = project.workspaceSettings?.logicalProject;
        const binding = project.workspaceSettings?.coordinatorBinding;
        if (input.side === "coordinator") {
          if (!identity || binding?.state === "transferred") return yield* fail("not_coordinator");
          if (binding?.state === "transferring") return yield* fail("handoff_in_progress");
          if (logicalProjectMemberKey(input.member) === logicalProjectMemberKey(self))
            return yield* fail("invalid");
          const remaining = identity.members.filter(
            (member) => logicalProjectMemberKey(member) !== logicalProjectMemberKey(input.member),
          );
          const current = binding ?? { epoch: 0, state: "active" as const };
          if (remaining.length === identity.members.length)
            return {
              operationId: input.operationId,
              logicalProject: identity,
              coordinatorBinding: current,
              notesWritten: 0,
              replayed: true,
            };
          const logicalProject = { ...identity, members: remaining };
          const coordinatorBinding = rememberRemoved(current, input.member);
          yield* writeOwnership(project, "project-unlink-member", input.operationId, {
            mode: "remove-member",
            logicalProject,
            coordinatorBinding,
          });
          return {
            operationId: input.operationId,
            logicalProject,
            coordinatorBinding,
            notesWritten: 0,
            replayed: false,
          };
        }
        if (
          identity &&
          binding?.state === "active" &&
          binding.operationId === input.operationId &&
          identity.members.length === 1
        )
          return {
            operationId: input.operationId,
            logicalProject: identity,
            coordinatorBinding: binding,
            notesWritten: yield* writeNotes(project.id, input.notes),
            replayed: true,
          };
        if (binding?.state === "transferring") return yield* fail("handoff_in_progress");
        if (binding?.state !== "transferred") return yield* fail("not_linked");
        // Refuse before leaving when a note would be overwritten; nothing changes then.
        for (const note of input.notes) {
          const current = yield* workspace
            .readMemory({ projectId: project.id, name: note.name })
            .pipe(Effect.option);
          if (
            !(Option.isSome(current) && current.value.content === note.content) &&
            (Option.isSome(current) ? current.value.revision : null) !== note.expectedRevision
          )
            return yield* fail("notes_changed", `"${note.name}" changed.`);
        }
        const id = `logical:${yield* randomUuidV4}`;
        const logicalProject: LogicalProject = {
          id,
          title: identity?.title ?? project.title,
          coordinatorId: `coordinator:${id}`,
          members: [self],
        };
        const active: ProjectCoordinatorBinding = {
          epoch: 0,
          state: "active",
          operationId: input.operationId,
        };
        yield* writeOwnership(project, "project-unlink", input.operationId, {
          mode: "unlink",
          logicalProject,
          coordinatorBinding: active,
        });
        // A copy that left is no longer in anyone's re-arm list.
        if (identity !== undefined)
          yield* rearmStore
            .modify(identity.id, (entry) => (entry?.projectId === project.id ? null : undefined))
            .pipe(Effect.ignore);
        // Leaving makes this copy the coordinator of its own, new project.
        yield* publishRole({
          kind: "took-over",
          projectId: project.id,
          logicalProjectId: logicalProject.id,
          epoch: 0,
          predecessor: null,
          takenOverBy: "person",
        });
        return {
          operationId: input.operationId,
          logicalProject,
          coordinatorBinding: active,
          notesWritten: yield* writeNotes(project.id, input.notes),
          replayed: false,
        };
      }),
    );

  const digest: ProjectLink["Service"]["digest"] = ({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* load(projectId);
      const replica = yield* readReplica(project);
      return {
        digest: yield* contentDigest(projectId),
        replica: Option.match(replica, {
          onNone: () => null,
          onSome: ({ from, digest, fromEpoch, replicatedAt, routinesDigest }) => ({
            from,
            digest,
            ...(fromEpoch === undefined ? {} : { fromEpoch }),
            replicatedAt,
            ...(routinesDigest === undefined ? {} : { routinesDigest }),
          }),
        }),
      };
    });

  const replicate: ProjectLink["Service"]["replicate"] = ({ projectId, replica }) =>
    admission.withLock(
      projectId,
      Effect.gen(function* () {
        const project = yield* load(projectId);
        const self = yield* selfMember(project);
        const identity = project.workspaceSettings?.logicalProject;
        if (!identity || project.workspaceSettings?.coordinatorBinding?.state !== "transferred")
          return yield* fail("not_member");
        if (
          replica.logicalProjectId !== identity.id ||
          replica.from.environmentId === self.environmentId ||
          coordinatorContentDigest(replica) !== replica.digest
        )
          return yield* fail("invalid");
        const held = yield* readReplica(project);
        // A copy the coordinator pushed itself is replaced, so the app's copy is the baseline again.
        if (
          Option.isSome(held) &&
          held.value.peer === undefined &&
          held.value.digest === replica.digest &&
          sameMember(held.value.from, replica.from)
        )
          return { replicatedAt: held.value.replicatedAt, replayed: true };
        // Another coordinator at a higher epoch wrote the held copy: a stale view never replaces it.
        if (
          Option.isSome(held) &&
          !sameMember(held.value.from, replica.from) &&
          (held.value.fromEpoch ?? -1) > (replica.fromEpoch ?? Number.MAX_SAFE_INTEGER)
        )
          return yield* fail("superseded_conflict");
        const replicatedAt = DateTime.formatIso(yield* DateTime.now);
        // Only this machine records that a peer pushed a copy; the app never claims it.
        const { peer: _peer, routinesDigest: _routines, ...written } = replica;
        yield* replicas
          .write(projectId, { ...written, replicatedAt, ...keptRoutinesDigest(held, replica.from) })
          .pipe(Effect.mapError(() => new ProjectLinkError({ code: "storage_failed" })));
        return { replicatedAt, replayed: false };
      }),
    );

  const replicateFromMember: ProjectLink["Service"]["replicateFromMember"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        yield* refusePersonal(project);
        const self = yield* selfMember(project);
        const identity = project.workspaceSettings?.logicalProject;
        const binding = project.workspaceSettings?.coordinatorBinding;
        if (identity?.id !== input.logicalProjectId || binding?.state !== "transferred")
          return yield* fail("not_member");
        const from = identity.members.find(
          (member) =>
            logicalProjectMemberKey(member) === logicalProjectMemberKey(input.from) &&
            member.environmentId !== self.environmentId,
        );
        if (from === undefined) return yield* fail("not_member");
        // The epoch is the sender's own word, so a claim never outranks what that member
        // could really do (`coordinatorClaimWindow`).
        const { lowest, highest } = coordinatorClaimWindow(binding, logicalProjectMemberKey(from));
        if (input.fromEpoch < lowest || input.fromEpoch > highest)
          return yield* fail(
            "not_coordinator",
            "That copy is not the coordinator this copy knows of.",
          );
        if (coordinatorContentDigest(input.content) !== input.content.digest)
          return yield* fail("invalid");
        const held = yield* readReplica(project);
        if (Option.isSome(held)) {
          const same = logicalProjectMemberKey(held.value.from) === logicalProjectMemberKey(from);
          if (
            same &&
            held.value.digest === input.content.digest &&
            held.value.fromEpoch === input.fromEpoch
          )
            return { replicatedAt: held.value.replicatedAt, replayed: true };
          // Another coordinator at a higher epoch wrote it: this one is behind.
          if (!same && (held.value.fromEpoch ?? -1) > input.fromEpoch)
            return yield* fail("superseded_conflict");
        }
        const replicatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* replicas
          .write(project.id, {
            from,
            logicalProjectId: identity.id,
            digest: input.content.digest,
            fromEpoch: input.fromEpoch,
            replicatedAt,
            goal: input.content.goal,
            instructions: input.content.instructions,
            notes: [...input.content.notes],
            notesTruncated: input.content.notesTruncated,
            ...keptRoutinesDigest(held, from),
            peer: peerReplicaMark(held, input.content, replicatedAt),
          })
          .pipe(Effect.mapError(() => new ProjectLinkError({ code: "storage_failed" })));
        return { replicatedAt, replayed: false };
      }),
    );

  /**
   * Writes the replica's notes; a local note with other text is kept beside it under
   * a new `-before-takeover` name. Earlier backups are never replaced, and replaying
   * a takeover finds its own backup instead of making another.
   */
  const applyReplicaNotes = (projectId: ProjectId, replica: ProjectCoordinatorReplica) =>
    Effect.gen(function* () {
      // The replica writes its own names; a backup never goes there.
      const replicaNames = new Set(replica.notes.map((note) => note.name));
      // Backup names chosen in this batch, with their text; others are read from disk.
      const taken = new Map<string, string>();
      const heldText = (name: string) =>
        taken.has(name)
          ? Effect.succeed(taken.get(name))
          : workspace.readMemory({ projectId, name }).pipe(
              Effect.option,
              Effect.map((held) => (Option.isSome(held) ? held.value.content : undefined)),
            );
      const replicaWrites: ProjectLinkNoteWrite[] = [];
      const replaced: Array<{ readonly name: string; readonly content: string }> = [];
      for (const note of replica.notes) {
        const current = yield* workspace
          .readMemory({ projectId, name: note.name })
          .pipe(Effect.option);
        if (Option.isSome(current) && current.value.content === note.content) continue;
        if (Option.isSome(current))
          replaced.push({ name: note.name, content: current.value.content });
        replicaWrites.push({
          name: note.name,
          content: note.content,
          expectedRevision: Option.isSome(current) ? current.value.revision : null,
        });
      }
      // Backups go first: a takeover stopped partway never loses a note it replaces.
      const writes: ProjectLinkNoteWrite[] = [];
      for (const note of replaced) {
        let name: string | undefined;
        for (const candidate of noteNameCandidates(note.name, "before takeover")) {
          if (replicaNames.has(candidate)) continue;
          const held = yield* heldText(candidate);
          if (held === undefined || held === note.content) {
            name = candidate;
            break;
          }
        }
        if (name === undefined)
          return yield* fail("too_large", `Too many earlier copies of "${note.name}".`);
        taken.set(name, note.content);
        if (!writes.some((write) => write.name === name))
          writes.push({ name, content: note.content, expectedRevision: null, createOnly: true });
      }
      writes.push(...replicaWrites);
      return yield* writeNotes(projectId, writes);
    });

  /**
   * Makes this member the coordinator after `predecessor`, starting from the
   * replica. The caller holds the project lock. `epoch` is given by an
   * automatic takeover, which names its operation by it; a person's takeover
   * goes one above every epoch known.
   */
  const takeoverLocked = (input: {
    readonly projectId: ProjectId;
    readonly operationId: string;
    readonly knownEpoch?: number | undefined;
    readonly predecessor?: LogicalProjectMember | undefined;
    readonly epoch?: number | undefined;
    readonly takenOverBy: "person" | "auto";
  }) =>
    Effect.gen(function* () {
      const project = yield* load(input.projectId);
      yield* refusePersonal(project);
      const identity = project.workspaceSettings?.logicalProject;
      const binding = project.workspaceSettings?.coordinatorBinding;
      const replica = yield* readReplica(project);
      const replicaFrom = Option.match(replica, {
        onNone: () => null,
        onSome: (value) => value.replicatedAt,
      });
      if (
        identity &&
        binding?.state === "active" &&
        binding.operationId === input.operationId &&
        binding.takenOverAt !== undefined
      )
        return {
          operationId: input.operationId,
          logicalProject: identity,
          coordinatorBinding: binding,
          notesWritten: 0,
          replicaFrom,
          replayed: true,
        };
      if (!identity || binding?.state !== "transferred" || binding.successor === undefined)
        return yield* fail(
          binding?.state === "transferring" ? "handoff_in_progress" : "not_member",
        );
      if (project.workspaceSettings?.archived) return yield* fail("archived");
      const self = yield* selfMember(project);
      const predecessor = input.predecessor ?? binding.successor;
      if (
        logicalProjectMemberKey(predecessor) === logicalProjectMemberKey(self) ||
        !identity.members.some((member) => sameMember(member, predecessor))
      )
        return yield* fail(
          "superseded_conflict",
          "The coordinator being replaced is not listed with this copy.",
        );
      const epoch = input.epoch ?? Math.max(binding.epoch, input.knownEpoch ?? 0) + 1;
      if (epoch <= binding.epoch) return yield* fail("invalid");
      const notesWritten = Option.isSome(replica)
        ? yield* applyReplicaNotes(project.id, replica.value)
        : 0;
      const active: ProjectCoordinatorBinding = {
        epoch,
        state: "active",
        operationId: input.operationId,
        predecessor,
        takenOverAt: DateTime.formatIso(yield* DateTime.now),
        takenOverBy: input.takenOverBy,
      };
      yield* writeOwnership(
        // Reread: notes do not change settings, but stay exact about the revision.
        yield* load(input.projectId),
        "project-takeover",
        input.operationId,
        { mode: "takeover", logicalProject: identity, coordinatorBinding: active },
        Option.isSome(replica)
          ? { goal: replica.value.goal, instructions: replica.value.instructions }
          : undefined,
      );
      yield* publishRole({
        kind: "took-over",
        projectId: project.id,
        logicalProjectId: identity.id,
        epoch,
        predecessor,
        takenOverBy: input.takenOverBy,
      });
      return {
        operationId: input.operationId,
        logicalProject: identity,
        coordinatorBinding: active,
        notesWritten,
        replicaFrom,
        replayed: false,
      };
    });

  const takeover: ProjectLink["Service"]["takeover"] = (input) =>
    admission.withLock(input.projectId, takeoverLocked({ ...input, takenOverBy: "person" }));

  const supersede: ProjectLink["Service"]["supersede"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        yield* refusePersonal(project);
        const self = yield* selfMember(project);
        const identity = project.workspaceSettings?.logicalProject;
        const binding: ProjectCoordinatorBinding = project.workspaceSettings
          ?.coordinatorBinding ?? { epoch: 0, state: "active" };
        const incoming = input.coordinatorBinding;
        if (!identity || identity.id !== input.logicalProjectId) return yield* fail("not_linked");
        if (
          incoming.state !== "active" ||
          incoming.predecessor === undefined ||
          !sameMember(incoming.predecessor, self) ||
          incoming.operationId === undefined ||
          incoming.takenOverAt === undefined ||
          logicalProjectMemberKey(input.successor) === logicalProjectMemberKey(self)
        )
          return yield* fail("invalid");
        if (
          binding.state === "transferred" &&
          binding.operationId === incoming.operationId &&
          binding.successor !== undefined &&
          sameMember(binding.successor, input.successor)
        )
          return {
            coordinatorBinding: binding,
            ranWhileDisconnected: yield* turnsSince(self, binding.takenOverAt),
            replayed: true,
          };
        if (
          binding.state !== "active" ||
          incoming.epoch <= binding.epoch ||
          !identity.members.some((member) => sameMember(member, input.successor))
        )
          return yield* fail("superseded_conflict");
        const relinquished: ProjectCoordinatorBinding = {
          epoch: incoming.epoch,
          state: "transferred",
          operationId: incoming.operationId,
          successor: input.successor,
          takenOverAt: incoming.takenOverAt,
        };
        yield* writeOwnership(project, "project-superseded", incoming.operationId, {
          mode: "superseded",
          logicalProject: identity,
          coordinatorBinding: relinquished,
        });
        yield* publishRole({
          kind: "gave-way",
          projectId: project.id,
          logicalProjectId: identity.id,
          epoch: incoming.epoch,
          successor: input.successor,
        });
        return {
          coordinatorBinding: relinquished,
          ranWhileDisconnected: yield* turnsSince(self, incoming.takenOverAt),
          replayed: false,
        };
      }),
    );

  /**
   * Runs this member's own coordinator next to the others. Nothing is replaced:
   * no predecessor is named, so no other copy gives way. Replica notes this copy
   * lacks are written; differing notes are left to memory replication.
   */
  const startCoordinator: ProjectLink["Service"]["startCoordinator"] = (input) =>
    admission.withLock(
      input.projectId,
      Effect.gen(function* () {
        const project = yield* load(input.projectId);
        yield* refusePersonal(project);
        const identity = project.workspaceSettings?.logicalProject;
        const binding = project.workspaceSettings?.coordinatorBinding;
        const replica = yield* readReplica(project);
        const replicaFrom = Option.match(replica, {
          onNone: () => null,
          onSome: (value) => value.replicatedAt,
        });
        if (identity && (binding === undefined || binding.state === "active"))
          return {
            operationId: input.operationId,
            logicalProject: identity,
            coordinatorBinding: binding ?? { epoch: 0, state: "active" as const },
            notesWritten: 0,
            replicaFrom,
            replayed: true,
          };
        if (!identity || binding?.state !== "transferred")
          return yield* fail(
            binding?.state === "transferring" ? "handoff_in_progress" : "not_member",
          );
        if (project.workspaceSettings?.archived) return yield* fail("archived");
        let notesWritten = 0;
        if (Option.isSome(replica)) {
          const missing: ProjectLinkNoteWrite[] = [];
          for (const note of replica.value.notes) {
            const current = yield* workspace
              .readMemory({ projectId: project.id, name: note.name })
              .pipe(Effect.option);
            if (Option.isNone(current))
              missing.push({ name: note.name, content: note.content, expectedRevision: null });
          }
          notesWritten = yield* writeNotes(project.id, missing);
        }
        const active: ProjectCoordinatorBinding = {
          epoch: Math.max(binding.epoch, input.knownEpoch ?? 0) + 1,
          state: "active",
          operationId: input.operationId,
        };
        const current = yield* load(input.projectId);
        const settings = current.workspaceSettings;
        const fill =
          Option.isSome(replica) && !settings?.goal?.trim() && !settings?.instructions?.trim()
            ? { goal: replica.value.goal, instructions: replica.value.instructions }
            : undefined;
        yield* writeOwnership(
          current,
          "project-start-coordinator",
          input.operationId,
          { mode: "start-coordinator", logicalProject: identity, coordinatorBinding: active },
          fill,
        );
        yield* publishRole({
          kind: "took-over",
          projectId: current.id,
          logicalProjectId: identity.id,
          epoch: active.epoch,
          predecessor: null,
          takenOverBy: "person",
        });
        return {
          operationId: input.operationId,
          logicalProject: identity,
          coordinatorBinding: active,
          notesWritten,
          replicaFrom,
          replayed: false,
        };
      }),
    );

  const writeOwnershipOnly = (
    project: Project,
    commandPrefix: string,
    operationId: string,
    ownership: Omit<ProjectOwnershipUpdate, "expectedRevision">,
  ) => writeOwnership(project, commandPrefix, operationId, ownership);

  const members = makeProjectLinkMembers({
    admission,
    fail,
    load,
    refusePersonal,
    selfMember,
    writeOwnership: writeOwnershipOnly,
  });

  const standby = makeProjectLinkStandby({
    admission,
    environment,
    replicas,
    store: standbyStore,
    rearmStore,
    // Read when a standby fires, from the runtime it fires in.
    claimedEpoch: (logicalProjectId) =>
      Effect.gen(function* () {
        const epochs = yield* WorkerEpochStore.WorkerEpochStore;
        return yield* epochs.get(logicalProjectId);
      }).pipe(Effect.orElseSucceed(() => undefined)),
    teamRulesRefusal: Effect.map(
      currentTeamRules,
      (rules) => teamRulesMachineLinkRefusal(rules)?.message ?? null,
    ),
    fail,
    load,
    refusePersonal,
    selfMember,
    readReplica,
    coordinatorContentDigest,
    keepRoutines:
      routineCopies === undefined
        ? undefined
        : (input) =>
            routineCopies
              .replace(input)
              .pipe(Effect.mapError(() => new ProjectLinkError({ code: "storage_failed" }))),
    publishRole,
    writeOwnership: writeOwnershipOnly,
    takeoverLocked,
    refreshMembers: (projectId) =>
      Effect.suspend(() =>
        membersSync === undefined ? Effect.void : membersSync.refresh(projectId),
      ),
  });

  return ProjectLink.of({
    ...standby,
    replicateFromMember,
    fingerprint,
    preview,
    prepare,
    accept,
    commit,
    unlink,
    digest,
    replicate,
    takeover,
    supersede,
    startCoordinator,
    adoptMembers: members.adoptMembers,
    addPredecessorMembers: members.addPredecessorMembers,
    registerMembersSync: (sync) =>
      Effect.sync(() => {
        membersSync = sync;
      }),
  });
});

function rootSummary(here: RepositoryFingerprint, there: RepositoryFingerprint): string {
  const root = (fingerprint: RepositoryFingerprint) =>
    fingerprint.root === "repository"
      ? (fingerprint.repositories.find((entry) => entry.path === "")?.originKey ??
        "a repository without an origin")
      : "a folder of repositories";
  return `This copy holds ${root(here)}; the other holds ${root(there)}.`;
}

/**
 * Needs `CoordinatorReplicas`, `CoordinatorStandbyStore` and
 * `CoordinatorRearmStore`; the runtime provides their file stores.
 */
export const layer = Layer.effect(ProjectLink, make).pipe(Layer.provide(ProjectAdmission.layer));

/** The `projectLink.*` and `projects.fingerprint` handlers (see `WsProjectLinkRpcGroup`). */
export const layerRpcHandlers = WsProjectLinkRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const link = yield* ProjectLink;
    const memory = yield* LinkedMemorySync.LinkedMemorySync;
    const guard = yield* CoordinatorReleaseGuard;
    const syncState = yield* Effect.serviceOption(LinkedPeerSyncState);
    // The standby this copy leases to is released, and answers, before the change is written.
    const released =
      <I, A>(
        before: (input: I) => Omit<Parameters<typeof guard.releaseBefore>[0], "changeAnyway">,
        write: (input: I) => Effect.Effect<A, ProjectLinkError>,
      ) =>
      (input: I & { readonly changeAnyway?: boolean | undefined }) =>
        guard
          .releaseBefore({ ...before(input), changeAnyway: input.changeAnyway === true })
          .pipe(Effect.andThen(write(input)));
    // Sharing a project across machines stops where the rules stop machines working together.
    const whereRulesAllow =
      <I, A, E, R>(run: (input: I) => Effect.Effect<A, E, R>) =>
      (input: I) =>
        Effect.gen(function* () {
          const refused = teamRulesMachineLinkRefusal(yield* currentTeamRules);
          if (refused !== null) {
            return yield* new ProjectLinkError({ code: "invalid", detail: refused.message });
          }
          return yield* run(input);
        });
    return {
      [WS_METHODS.projectsFingerprint]: link.fingerprint,
      [WS_METHODS.projectLinkPreview]: link.preview,
      [WS_METHODS.projectLinkPrepare]: whereRulesAllow(link.prepare),
      [WS_METHODS.projectLinkAccept]: whereRulesAllow(link.accept),
      [WS_METHODS.projectLinkCommit]: whereRulesAllow(link.commit),
      [WS_METHODS.projectUnlink]: released(
        (input: ProjectUnlinkInput) =>
          input.side === "coordinator"
            ? { projectId: input.projectId, onlyFor: input.member, reason: "unlink-member" }
            : { projectId: input.projectId, reason: "unlink" },
        link.unlink,
      ),
      [WS_METHODS.projectLinkDigest]: link.digest,
      [WS_METHODS.projectLinkSyncStatus]: ({ projectId }: { readonly projectId: ProjectId }) =>
        Effect.all({
          pairs: Option.match(syncState, {
            onNone: () => Effect.succeed([]),
            onSome: (state) => state.status(projectId),
          }),
          standbyRearm: link.rearmStatus(projectId),
        }).pipe(
          Effect.map(({ pairs, standbyRearm }) =>
            standbyRearm === undefined ? { pairs } : { pairs, standbyRearm },
          ),
        ),
      [WS_METHODS.projectLinkReplicate]: whereRulesAllow(link.replicate),
      [WS_METHODS.projectLinkSyncMembers]: whereRulesAllow((input: ProjectLinkSyncMembersInput) =>
        link.adoptMembers({ ...input, viaApp: true }),
      ),
      [WS_METHODS.projectLinkMemoryExport]: whereRulesAllow(memory.memoryExport),
      [WS_METHODS.projectLinkMemoryMerge]: whereRulesAllow(memory.memoryMerge),
      [WS_METHODS.projectTakeover]: link.takeover,
      [WS_METHODS.projectSupersede]: released(
        (input: ProjectSupersedeInput) => ({
          projectId: input.projectId,
          unless: input.successor,
          reason: "supersede",
        }),
        link.supersede,
      ),
      [WS_METHODS.projectStartCoordinator]: link.startCoordinator,
      [WS_METHODS.projectSetStandby]: released(
        (input: ProjectSetStandbyInput) => ({
          projectId: input.projectId,
          unless: input.standby?.member,
          reason: input.standby === null ? "standby-off" : "standby-changed",
        }),
        link.setStandby,
      ),
      [WS_METHODS.projectAcceptStandby]: link.acceptStandby,
    };
  }),
);
