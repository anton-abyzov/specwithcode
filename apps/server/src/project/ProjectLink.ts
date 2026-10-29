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
  type ProjectLinkNoteWrite,
  type ProjectLinkPrepareInput,
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
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { sha256 } from "../nodeCrypto.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProjectOwnershipUpdate } from "../orchestration-v2/ProjectCommands.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as CoordinatorReplicas from "./CoordinatorReplicas.ts";
import { CoordinatorStandbyStore } from "./CoordinatorStandbyStore.ts";
import * as LinkedMemorySync from "./LinkedMemorySync.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import { fingerprintFolder } from "./projectFingerprint.ts";
import {
  CoordinatorReleaseGuard,
  makeProjectLinkStandby,
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
    readonly accept: (
      input: ProjectLinkAcceptInput,
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
    readonly startCoordinator: (
      input: ProjectStartCoordinatorInput,
    ) => Effect.Effect<ProjectStartCoordinatorResult, ProjectLinkError>;
  } & ProjectLinkStandbyMethods
>()("specweave-studio/project/ProjectLink") {}

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
      const notes: ProjectLinkNote[] = [];
      let bytes = 0;
      let notesTruncated = false;
      for (const file of read.memory.files) {
        if (bytes + file.byteLength > PROJECT_LINK_MAX_BYTES) {
          notesTruncated = true;
          continue;
        }
        const note = yield* workspace
          .readMemory({ projectId, name: file.name })
          .pipe(Effect.option);
        if (Option.isNone(note)) continue;
        bytes += file.byteLength;
        notes.push({
          name: note.value.name,
          revision: note.value.revision,
          content: note.value.content,
        });
      }
      return {
        goal: read.settings.goal,
        instructions: read.settings.instructions,
        notes,
        notesTruncated,
      };
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
        return {
          operationId: input.operationId,
          kept,
          // As commit will list it, so the joining copy records the kept copy's folder too.
          logicalProject: withOwnRoot(logicalProject, kept),
          coordinatorBinding: binding,
          fingerprint: yield* fingerprintOf(project.workspaceRoot),
          adopted,
        };
      }),
    );

  const accept: ProjectLink["Service"]["accept"] = (input) =>
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
        const own = yield* fingerprintOf(project.workspaceRoot);
        if (!compareFingerprints(own, input.keptFingerprint).rootMatches)
          return yield* fail("repository_mismatch", rootSummary(own, input.keptFingerprint));
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
          yield* writeOwnership(project, "project-unlink-member", input.operationId, {
            mode: "remove-member",
            logicalProject,
            coordinatorBinding: current,
          });
          return {
            operationId: input.operationId,
            logicalProject,
            coordinatorBinding: current,
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
        digest: coordinatorContentDigest(yield* readContent(projectId)),
        replica: Option.match(replica, {
          onNone: () => null,
          onSome: ({ from, digest, replicatedAt }) => ({ from, digest, replicatedAt }),
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
        const replicatedAt = DateTime.formatIso(yield* DateTime.now);
        // Only this machine records that a peer pushed a copy; the app never claims it.
        const { peer: _peer, ...written } = replica;
        yield* replicas
          .write(projectId, { ...written, replicatedAt })
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

  const standby = makeProjectLinkStandby({
    admission,
    environment,
    replicas,
    store: standbyStore,
    fail,
    load,
    refusePersonal,
    selfMember,
    readReplica,
    coordinatorContentDigest,
    writeOwnership: (project, commandPrefix, operationId, ownership) =>
      writeOwnership(project, commandPrefix, operationId, ownership),
    takeoverLocked,
  });

  return ProjectLink.of({
    ...standby,
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

/** Needs `CoordinatorReplicas` and `CoordinatorStandbyStore`; the runtime provides their file stores. */
export const layer = Layer.effect(ProjectLink, make).pipe(Layer.provide(ProjectAdmission.layer));

/** The `projectLink.*` and `projects.fingerprint` handlers (see `WsProjectLinkRpcGroup`). */
export const layerRpcHandlers = WsProjectLinkRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const link = yield* ProjectLink;
    const memory = yield* LinkedMemorySync.LinkedMemorySync;
    const guard = yield* CoordinatorReleaseGuard;
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
    return {
      [WS_METHODS.projectsFingerprint]: link.fingerprint,
      [WS_METHODS.projectLinkPreview]: link.preview,
      [WS_METHODS.projectLinkPrepare]: link.prepare,
      [WS_METHODS.projectLinkAccept]: link.accept,
      [WS_METHODS.projectLinkCommit]: link.commit,
      [WS_METHODS.projectUnlink]: released(
        (input: ProjectUnlinkInput) =>
          input.side === "coordinator"
            ? { projectId: input.projectId, onlyFor: input.member, reason: "unlink-member" }
            : { projectId: input.projectId, reason: "unlink" },
        link.unlink,
      ),
      [WS_METHODS.projectLinkDigest]: link.digest,
      [WS_METHODS.projectLinkReplicate]: link.replicate,
      [WS_METHODS.projectLinkMemoryExport]: memory.memoryExport,
      [WS_METHODS.projectLinkMemoryMerge]: memory.memoryMerge,
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
