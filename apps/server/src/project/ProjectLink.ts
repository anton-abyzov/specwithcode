import {
  CommandId,
  compareFingerprints,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  logicalProjectMemberKey,
  type LogicalProject,
  type LogicalProjectMember,
  type Project,
  type ProjectCoordinatorBinding,
  type ProjectFingerprintInput,
  type ProjectFingerprintResult,
  PROJECT_LINK_MAX_BYTES,
  type ProjectLinkAcceptInput,
  type ProjectLinkAcceptResult,
  type ProjectLinkCommitInput,
  type ProjectLinkCommitResult,
  ProjectLinkError,
  type ProjectLinkNote,
  type ProjectLinkNoteWrite,
  type ProjectLinkPrepareInput,
  type ProjectLinkPrepareResult,
  type ProjectLinkPreview,
  type ProjectLinkPreviewInput,
  type ProjectLinkRefusal,
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
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProjectOwnershipUpdate } from "../orchestration-v2/ProjectCommands.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import { fingerprintFolder } from "./projectFingerprint.ts";
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
  }
>()("specweave-studio/project/ProjectLink") {}

const fail = (code: ProjectLinkError["code"], detail?: string) =>
  Effect.fail(new ProjectLinkError({ code, ...(detail ? { detail } : {}) }));

const sameMember = (a: LogicalProjectMember, b: LogicalProjectMember) =>
  a.environmentId === b.environmentId &&
  a.projectId === b.projectId &&
  a.coordinatorThreadId === b.coordinatorThreadId;

/** Members keyed by machine and project, newest entry kept. */
const mergeMembers = (...lists: ReadonlyArray<ReadonlyArray<LogicalProjectMember>>) => [
  ...new Map(lists.flat().map((member) => [logicalProjectMemberKey(member), member])).values(),
];

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

  const load = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(() => new ProjectLinkError({ code: "storage_failed" })),
      Effect.flatMap((found) =>
        Option.isSome(found) && found.value.deletedAt === null
          ? Effect.succeed(found.value)
          : fail("not_found"),
      ),
    );

  /** This copy as identities list it; an existing entry wins so reciprocity holds. */
  const selfMember = (project: Project) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const listed = project.workspaceSettings?.logicalProject?.members.find(
        (member) => member.environmentId === environmentId && member.projectId === project.id,
      );
      return (
        listed ?? {
          environmentId,
          projectId: project.id,
          coordinatorThreadId:
            project.workspaceSettings?.coordinatorThreadId ??
            ThreadId.make(`project-coordinator:${project.id}`),
        }
      );
    });

  const coordinatorShell = (member: LogicalProjectMember) =>
    projections.getThreadShell(member.coordinatorThreadId).pipe(Effect.orElseSucceed(() => null));

  const writeOwnership = (
    project: Project,
    commandPrefix: string,
    operationId: string,
    ownership: Omit<ProjectOwnershipUpdate, "expectedRevision">,
  ) => {
    const revision = project.workspaceSettings?.revision ?? 0;
    return projects
      .update({
        projectId: project.id,
        // The revision keeps a retry after a concurrent edit from replaying a stale rejection.
        commandId: CommandId.make(`${commandPrefix}:${operationId}:${revision}`),
        ownership: { ...ownership, expectedRevision: revision },
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
        if ((Option.isSome(current) ? current.value.revision : null) !== note.expectedRevision)
          return yield* fail("notes_changed", `"${note.name}" changed.`);
        pending.push(note);
      }
      for (const note of pending)
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

  const preview: ProjectLink["Service"]["preview"] = ({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* load(projectId);
      const member = yield* selfMember(project);
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
        goal: read.settings.goal,
        instructions: read.settings.instructions,
        notes,
        notesTruncated,
        lastCoordinatorActivityAt: activity === null ? null : DateTime.formatIso(activity),
        keepRefusal: refusals.keep,
        joinRefusal: refusals.join,
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
          logicalProject,
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
        const logicalProject = { ...identity, members: [...identity.members, input.joining] };
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

  return ProjectLink.of({ fingerprint, preview, prepare, accept, commit, unlink });
});

function rootSummary(here: RepositoryFingerprint, there: RepositoryFingerprint): string {
  const root = (fingerprint: RepositoryFingerprint) =>
    fingerprint.root === "repository"
      ? (fingerprint.repositories.find((entry) => entry.path === "")?.originKey ??
        "a repository without an origin")
      : "a folder of repositories";
  return `This copy holds ${root(here)}; the other holds ${root(there)}.`;
}

export const layer = Layer.effect(ProjectLink, make).pipe(Layer.provide(ProjectAdmission.layer));

/** The `projectLink.*` and `projects.fingerprint` handlers (see `WsProjectLinkRpcGroup`). */
export const layerRpcHandlers = WsProjectLinkRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const link = yield* ProjectLink;
    return {
      [WS_METHODS.projectsFingerprint]: link.fingerprint,
      [WS_METHODS.projectLinkPreview]: link.preview,
      [WS_METHODS.projectLinkPrepare]: link.prepare,
      [WS_METHODS.projectLinkAccept]: link.accept,
      [WS_METHODS.projectLinkCommit]: link.commit,
      [WS_METHODS.projectUnlink]: link.unlink,
    };
  }),
);
