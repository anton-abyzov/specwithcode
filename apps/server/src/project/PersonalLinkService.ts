import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { renamedMemoryName } from "@specweave-studio/shared/personalAssistantMigration";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  logicalProjectMemberKey,
  PERSONAL_LINK_PROTOCOL_VERSION,
  PersonalLinkError,
  type LogicalProject,
  type LogicalProjectMember,
  type PersonalLinkJoinInput,
  type PersonalLinkJoinResult,
  type PersonalLinkLeaveInput,
  type PersonalLinkLeaveResult,
  type PersonalLinkPreview,
  type PersonalLinkPreviewInput,
  type PersonalLinkSetRoutineOwnerInput,
  type PersonalLinkSetRoutineOwnerResult,
  type Project,
  type ProjectCoordinatorBinding,
  type ProjectId,
  ThreadId,
  WS_METHODS,
  WsPersonalLinkRpcGroup,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import type { ProjectOwnershipUpdate } from "../orchestration-v2/ProjectCommands.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";
import {
  type PersonalLinkSnapshotter,
  PersonalLinkSnapshot,
  personalMemoryDigest,
  memoryDigestBeforeRenames,
} from "./personalLinkSnapshot.ts";
import { localOnlyMemorySet } from "./memorySecretScan.ts";
import { sha256 } from "../nodeCrypto.ts";

export interface PersonalLinkServiceShape {
  readonly preview: (
    input: PersonalLinkPreviewInput,
  ) => Effect.Effect<PersonalLinkPreview, PersonalLinkError>;
  readonly join: (
    input: PersonalLinkJoinInput,
  ) => Effect.Effect<PersonalLinkJoinResult, PersonalLinkError>;
  readonly leave: (
    input: PersonalLinkLeaveInput,
  ) => Effect.Effect<PersonalLinkLeaveResult, PersonalLinkError>;
  readonly setRoutineOwner: (
    input: PersonalLinkSetRoutineOwnerInput,
  ) => Effect.Effect<PersonalLinkSetRoutineOwnerResult, PersonalLinkError>;
}

export class PersonalLinkService extends Context.Service<
  PersonalLinkService,
  PersonalLinkServiceShape
>()("specweave-studio/project/PersonalLinkService") {}

const fail = (code: PersonalLinkError["code"], message: string, detail?: string) =>
  Effect.fail(
    new PersonalLinkError({
      code,
      message,
      ...(detail === undefined ? {} : { detail }),
    }),
  );

const dedupeMembers = (
  members: ReadonlyArray<LogicalProjectMember>,
): Array<LogicalProjectMember> => {
  const byKey = new Map<string, LogicalProjectMember>();
  for (const member of members) {
    byKey.set(logicalProjectMemberKey(member), member);
  }
  return [...byKey.values()];
};

const FORMER_LINKS_LIMIT = 8;

/**
 * The binding a seat keeps once it leaves `identity` (1448 C1): the old link id
 * and its members, so a seat still on it is told this one left. Newest last.
 */
const formerLinksAfterLeaving = (
  binding: ProjectCoordinatorBinding | undefined,
  identity: LogicalProject,
  leftAt: string,
): NonNullable<ProjectCoordinatorBinding["formerLinks"]> =>
  [
    ...(binding?.formerLinks ?? []).filter((entry) => entry.logicalProjectId !== identity.id),
    { logicalProjectId: identity.id, members: identity.members.slice(0, 64), leftAt },
  ].slice(-FORMER_LINKS_LIMIT);

/**
 * `binding` once `members` are linked (again) at `linkedAt` (1448 C1): they
 * leave `removedMembers`, and `relinkedMembers` notes when they were linked, so
 * an older removal of one of them no longer removes it anywhere.
 */
const bindingRelinking = (
  binding: ProjectCoordinatorBinding,
  members: ReadonlyArray<LogicalProjectMember>,
  linkedAt: string,
): ProjectCoordinatorBinding => {
  const keys = new Set(members.map(logicalProjectMemberKey));
  if (keys.size === 0) return binding;
  const { removedMembers, relinkedMembers, ...rest } = binding;
  const keptRemoved = (removedMembers ?? []).filter(
    (entry) => !keys.has(logicalProjectMemberKey(entry)),
  );
  const relinked = [
    ...(relinkedMembers ?? []).filter((entry) => !keys.has(logicalProjectMemberKey(entry))),
    ...members.map((member) => ({
      environmentId: member.environmentId,
      projectId: member.projectId,
      linkedAt,
    })),
  ].slice(-256);
  return {
    ...rest,
    ...(keptRemoved.length > 0 ? { removedMembers: keptRemoved } : {}),
    relinkedMembers: relinked,
  };
};

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const workspace = yield* ProjectWorkspaceService.ProjectWorkspaceService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const snapshotter: PersonalLinkSnapshotter = yield* PersonalLinkSnapshot;

  const storageFailed = (message: string) => (error: unknown) =>
    new PersonalLinkError({
      code: "storage_failed",
      message,
      detail: String(error).slice(0, 500),
    });

  /** Every memory file of the seat with its content hash, in name order. */
  const memoryHashes = (projectId: ProjectId) =>
    workspace.readMemoryFiles({ projectId }).pipe(
      Effect.mapError(storageFailed("Could not read personal assistant memory.")),
      Effect.map((files) =>
        files.map((file) => ({
          name: file.name,
          sha256: sha256([file.content], "hex"),
          updatedAt: file.updatedAt,
          byteLength: file.byteLength,
          content: file.content,
          revision: file.revision,
        })),
      ),
    );

  const loadPersonal = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(
        () => new PersonalLinkError({ code: "storage_failed", message: "Could not read project." }),
      ),
      Effect.flatMap((found) =>
        Option.isSome(found) && found.value.deletedAt === null
          ? isPersonalAssistantProject(found.value)
            ? Effect.succeed(found.value)
            : fail(
                "not_personal_assistant",
                "Only a personal assistant can be linked with personalLink.",
              )
          : fail("not_found", "Personal assistant not found."),
      ),
    );

  const selfMemberOf = (project: Project) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const existing = project.workspaceSettings?.logicalProject?.members.find(
        (member) => member.environmentId === environmentId && member.projectId === project.id,
      );
      return (
        existing ?? {
          environmentId,
          projectId: project.id,
          coordinatorThreadId:
            project.workspaceSettings?.coordinatorThreadId ??
            ThreadId.make(`project-coordinator:${project.id}`),
        }
      );
    });

  const writeOwnership = (
    project: Project,
    commandPrefix: string,
    operationId: string,
    ownership: Omit<ProjectOwnershipUpdate, "expectedRevision">,
    extras?: {
      readonly title?: string;
      readonly projectIcon?: Project["projectIcon"];
    },
  ) => {
    const revision = project.workspaceSettings?.revision ?? 0;
    return projects
      .update({
        projectId: project.id,
        commandId: CommandId.make(`${commandPrefix}:${operationId}:${revision}`),
        ownership: { ...ownership, expectedRevision: revision },
        ...(extras?.title !== undefined ? { title: extras.title } : {}),
        ...(extras?.projectIcon !== undefined ? { projectIcon: extras.projectIcon } : {}),
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ProjectNotFoundError"
            ? new PersonalLinkError({ code: "not_found", message: "Personal assistant not found." })
            : new PersonalLinkError({
                code: "storage_failed",
                message: "Could not update personal assistant link state.",
                detail: error.message.slice(0, 900),
              }),
        ),
      );
  };

  const preview: PersonalLinkServiceShape["preview"] = (input) =>
    Effect.gen(function* () {
      const project = yield* loadPersonal(input.projectId);
      const descriptor = yield* environment.getDescriptor;
      const loaded = yield* workspace.readWorkspace({ projectId: project.id }).pipe(
        Effect.mapError(
          (error) =>
            new PersonalLinkError({
              code: "storage_failed",
              message: "Could not read personal assistant memory.",
              detail: String(error).slice(0, 500),
            }),
        ),
      );
      const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
      const syncableNames = loaded.memory.files
        .filter((file) => !file.localOnly && !file.secretDetected)
        .map((file) => file.name)
        .toSorted();
      const hashes = yield* memoryHashes(project.id);
      const syncable = new Set(syncableNames);
      const self = yield* selfMemberOf(project);

      return {
        protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
        projectId: project.id,
        assistantName: project.title,
        icon: project.projectIcon ?? null,
        memoryFileCount: syncableNames.length,
        machineLabel: descriptor.label,
        memoryFileNames: syncableNames,
        logicalProjectId: settings.logicalProject?.id ?? null,
        members: settings.logicalProject?.members ?? [],
        routineOwner: settings.coordinatorBinding?.routineOwner ?? true,
        self,
        createdAt: project.createdAt,
        memoryFiles: hashes
          .filter((file) => syncable.has(file.name))
          .map(({ name, sha256: hash, updatedAt, byteLength }) => ({
            name,
            sha256: hash,
            updatedAt,
            byteLength,
          })),
        settingsRevision: settings.revision,
        memoryDigest: personalMemoryDigest(hashes),
      };
    });

  /**
   * Before a seat's first link (1448 AC-13): the owner's approval must match the
   * seat as previewed, then this machine saves a database copy (fail closed),
   * then each clashing file is renamed as the owner chose. Nothing is deleted:
   * a renamed copy keeps its content under its new name. A retry with the same
   * operation reuses the copy and skips renames already made.
   */
  const prepareFirstLink = (project: Project, input: PersonalLinkJoinInput, operationId: string) =>
    Effect.gen(function* () {
      const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
      if (input.approval === undefined)
        return yield* fail(
          "approval_required",
          "Review and approve the merge before linking this personal assistant.",
        );
      const descriptor = yield* environment.getDescriptor;
      const renames = (input.memoryResolutions ?? []).filter(
        (resolution) => resolution.action !== "keep",
      );
      const hashes = yield* memoryHashes(project.id);
      const digestNow = personalMemoryDigest(hashes);
      const renamedFor = (name: string) =>
        renamedMemoryName(name, descriptor.label, descriptor.environmentId);
      const matchesApproval =
        digestNow === input.approval.memoryDigest ||
        memoryDigestBeforeRenames(
          hashes,
          renames.map((resolution) => ({ from: resolution.name, to: renamedFor(resolution.name) })),
        ) === input.approval.memoryDigest;
      // A retry after renames moved the revision on: accept when only our renames happened.
      const revisionOk =
        settings.revision === input.approval.expectedSettingsRevision ||
        (digestNow !== input.approval.memoryDigest && matchesApproval);
      if (!matchesApproval || !revisionOk)
        return yield* fail(
          "stale_plan",
          "This personal assistant changed after the review. Review the merge again.",
        );

      // One copy per approved plan: a retry of this plan reuses it, while a later
      // join that reuses the link's operation id (a new machine, a relink) saves its own.
      const snapshotKey = `${operationId}@r${input.approval.expectedSettingsRevision}-${input.approval.memoryDigest.slice(0, 16)}`;
      const snapshotPath = yield* snapshotter.snapshot(snapshotKey).pipe(
        Effect.mapError(
          (error) =>
            new PersonalLinkError({
              code: "snapshot_failed",
              message: `Could not save a copy of the database on ${descriptor.label}; nothing was linked.`,
              detail: String(error).slice(0, 500),
            }),
        ),
      );

      const byName = new Map(hashes.map((file) => [file.name, file]));
      const keepLocal: string[] = [];
      const moves: Array<{
        readonly from: string;
        readonly to: string;
        readonly revision: number;
      }> = [];
      // Every target is checked before anything is written, so a refusal changes nothing.
      for (const resolution of renames) {
        const target = renamedFor(resolution.name);
        if (resolution.action === "rename-local") keepLocal.push(target);
        const source = byName.get(resolution.name);
        if (source === undefined) continue; // renamed on an earlier attempt, or gone
        const existing = byName.get(target);
        // The same content under the target is an earlier rename that stopped halfway.
        if (existing !== undefined && existing.sha256 !== source.sha256)
          return yield* fail(
            "invalid",
            `Memory file ${target} already exists; rename it before linking.`,
          );
        moves.push({ from: resolution.name, to: target, revision: source.revision });
      }
      for (const move of moves) {
        // One transaction per file, and no tombstone for the original name (1448 C3).
        yield* workspace
          .renameMemory({
            projectId: project.id,
            from: move.from,
            to: move.to,
            expectedRevision: move.revision,
          })
          .pipe(Effect.mapError(storageFailed(`Could not rename memory file ${move.from}.`)));
      }
      const localOnly = localOnlyMemorySet(settings);
      const addLocal = keepLocal.filter((name) => !localOnly.has(name));
      if (addLocal.length > 0) {
        yield* projects
          .update({
            projectId: project.id,
            commandId: CommandId.make(
              `personal-link-keep-local:${operationId}:${settings.revision}`,
            ),
            workspaceSettings: {
              expectedRevision: settings.revision,
              localOnlyMemoryFiles: [...localOnly, ...addLocal],
            },
          })
          .pipe(Effect.mapError(storageFailed("Could not keep renamed memory on this machine.")));
      }
      return snapshotPath;
    });

  const join: PersonalLinkServiceShape["join"] = (input) =>
    Effect.gen(function* () {
      if (
        input.peerProtocolVersion === undefined ||
        input.peerProtocolVersion < PERSONAL_LINK_PROTOCOL_VERSION
      ) {
        const machine = input.peerMachineLabel?.trim() || "the other machine";
        const detail =
          input.peerProtocolVersion === undefined
            ? `Missing peer protocol version (requires >= ${PERSONAL_LINK_PROTOCOL_VERSION}).`
            : `Peer protocol ${input.peerProtocolVersion} is older than ${PERSONAL_LINK_PROTOCOL_VERSION}.`;
        return yield* fail("version_skew", `Update ${machine} to link Percy.`, detail);
      }

      const project = yield* loadPersonal(input.projectId);
      const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
      if (settings.paused) {
        return yield* fail("paused", "Resume this personal assistant before linking it.");
      }
      if (!input.logicalProjectId.startsWith("logical:")) {
        return yield* fail("invalid", "Shared identity must start with logical:.");
      }

      const self = yield* selfMemberOf(project);
      const mergedMembers = dedupeMembers([
        ...input.members.map((member) =>
          member.environmentId === self.environmentId && member.projectId === self.projectId
            ? self
            : member,
        ),
        self,
      ]);

      if (mergedMembers.length < 2) {
        return yield* fail("invalid", "Linking requires at least two machines.");
      }
      if (
        mergedMembers.some(
          (member) =>
            member.environmentId === self.environmentId && member.projectId !== self.projectId,
        )
      ) {
        return yield* fail(
          "invalid",
          "Cannot list two personal assistant rows from the same machine.",
        );
      }

      const currentIdentity = settings.logicalProject;
      const currentBinding = settings.coordinatorBinding;
      const operationId = input.operationId ?? `personal-link:${yield* randomUuidV4}`;
      const title = input.canonicalName ?? project.title;

      // A seat's own one-member identity is not a link to extend.
      if (
        currentIdentity &&
        currentIdentity.id === input.logicalProjectId &&
        currentIdentity.members.length <= 1
      ) {
        return yield* fail(
          "invalid",
          "This id is this machine's own identity, not a link. Use a new link id.",
        );
      }

      // Already linked to this exact logicalProject?
      if (currentIdentity && currentIdentity.id === input.logicalProjectId) {
        const currentKeys = new Set(currentIdentity.members.map(logicalProjectMemberKey));
        const hasNewMembers = mergedMembers.some(
          (member) => !currentKeys.has(logicalProjectMemberKey(member)),
        );
        const currentRoutineOwner = currentBinding?.routineOwner ?? true;
        if (!hasNewMembers && currentRoutineOwner === input.routineOwner) {
          return {
            projectId: project.id,
            logicalProject: currentIdentity,
            routineOwner: currentRoutineOwner,
            replayed: true,
          };
        }
        // Extending a link keeps its name: a differing canonicalName is ignored (1448 C2).
        const nextIdentity: LogicalProject = {
          id: currentIdentity.id,
          title: currentIdentity.title,
          coordinatorId: currentIdentity.coordinatorId,
          members: dedupeMembers([...currentIdentity.members, ...mergedMembers]),
        };
        if (hasNewMembers) {
          // New machines bring memory: the same approval, copy and renames as a first link.
          const snapshotPath = yield* prepareFirstLink(project, input, operationId);
          const prepared = yield* loadPersonal(project.id);
          const preparedBinding = prepared.workspaceSettings?.coordinatorBinding;
          const added = mergedMembers.filter(
            (member) => !currentKeys.has(logicalProjectMemberKey(member)),
          );
          const nextBinding: ProjectCoordinatorBinding = bindingRelinking(
            {
              ...(preparedBinding ?? { epoch: 0, state: "active" as const }),
              state: "active",
            },
            added,
            DateTime.formatIso(yield* DateTime.now),
          );
          yield* writeOwnership(
            prepared,
            "personal-link-member",
            operationId,
            {
              mode: "link-member",
              logicalProject: nextIdentity,
              coordinatorBinding: nextBinding,
            },
            input.icon !== undefined ? { projectIcon: input.icon } : undefined,
          );
          if ((nextBinding.routineOwner ?? true) !== input.routineOwner) {
            const refreshed = yield* loadPersonal(project.id);
            yield* writeOwnership(refreshed, "personal-link-routine-owner", operationId, {
              mode: "set-routine-owner",
              logicalProject: nextIdentity,
              coordinatorBinding: { ...nextBinding, routineOwner: input.routineOwner },
            });
          }
          return {
            projectId: project.id,
            logicalProject: nextIdentity,
            routineOwner: input.routineOwner,
            replayed: false,
            snapshotPath,
          };
        } else {
          const nextBinding: ProjectCoordinatorBinding = {
            ...(currentBinding ?? { epoch: 0, state: "active" as const }),
            state: "active",
            routineOwner: input.routineOwner,
          };
          yield* writeOwnership(
            project,
            "personal-link-routine-owner",
            operationId,
            {
              mode: "set-routine-owner",
              logicalProject: nextIdentity,
              coordinatorBinding: nextBinding,
            },
            input.icon !== undefined ? { projectIcon: input.icon } : undefined,
          );
        }
        return {
          projectId: project.id,
          logicalProject: nextIdentity,
          routineOwner: input.routineOwner,
          replayed: false,
        };
      }

      // Already linked to a DIFFERENT multi-machine identity?
      if (currentIdentity && currentIdentity.members.length > 1) {
        return yield* fail(
          "already_linked",
          "This personal assistant is already linked to another identity. Unlink it first.",
        );
      }

      const snapshotPath = yield* prepareFirstLink(project, input, operationId);
      // The renames moved the settings revision on: write ownership against the current one.
      const prepared = yield* loadPersonal(project.id);

      const nextIdentity: LogicalProject = {
        id: input.logicalProjectId,
        title,
        coordinatorId: self.coordinatorThreadId,
        members: mergedMembers,
      };
      // Joining a link this seat once left drops it from formerLinks; every listed
      // member, this seat too, is noted as linked now so older removals stop counting.
      const formerLinks = (currentBinding?.formerLinks ?? []).filter(
        (entry) => entry.logicalProjectId !== input.logicalProjectId,
      );
      const nextBinding: ProjectCoordinatorBinding = bindingRelinking(
        {
          epoch: currentBinding?.epoch ?? 0,
          state: "active",
          operationId,
          routineOwner: input.routineOwner,
          ...(formerLinks.length > 0 ? { formerLinks } : {}),
        },
        mergedMembers,
        DateTime.formatIso(yield* DateTime.now),
      );

      yield* writeOwnership(
        prepared,
        "personal-link-join",
        operationId,
        {
          mode: "join-as-member",
          joinExpectedLogicalProjectId: currentIdentity?.id ?? null,
          logicalProject: nextIdentity,
          coordinatorBinding: nextBinding,
        },
        {
          ...(input.canonicalName !== undefined ? { title } : {}),
          ...(input.icon !== undefined ? { projectIcon: input.icon } : {}),
        },
      );

      return {
        projectId: project.id,
        logicalProject: nextIdentity,
        routineOwner: input.routineOwner,
        replayed: false,
        snapshotPath,
      };
    });

  const leave: PersonalLinkServiceShape["leave"] = (input) =>
    Effect.gen(function* () {
      const project = yield* loadPersonal(input.projectId);
      const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
      const currentIdentity = settings.logicalProject;
      if (!currentIdentity || currentIdentity.members.length <= 1) {
        return yield* fail("not_linked", "This personal assistant is not linked.");
      }

      const self = yield* selfMemberOf(project);
      const operationId = `personal-unlink:${yield* randomUuidV4}`;
      const removingSelf =
        input.removeEnvironmentId === undefined || input.removeEnvironmentId === self.environmentId;

      const leftAt = DateTime.formatIso(yield* DateTime.now);
      // The unlinked binding remembers the link it left (1448 C1), so the seats
      // still on it are told this one left instead of getting a mismatch.
      const unlinkedBinding: ProjectCoordinatorBinding = {
        epoch: 0,
        state: "active",
        routineOwner: true,
        formerLinks: formerLinksAfterLeaving(settings.coordinatorBinding, currentIdentity, leftAt),
      };

      if (removingSelf) {
        const freshIdentity: LogicalProject = {
          id: `logical:${yield* randomUuidV4}`,
          title: project.title,
          coordinatorId: self.coordinatorThreadId,
          members: [self],
        };
        const freshBinding = unlinkedBinding;
        yield* writeOwnership(project, "personal-unlink", operationId, {
          mode: "unlink",
          logicalProject: freshIdentity,
          coordinatorBinding: freshBinding,
        });
        return {
          projectId: project.id,
          unlinked: true,
          remainingMembers: [self],
        };
      }

      const remaining = currentIdentity.members.filter(
        (member) => member.environmentId !== input.removeEnvironmentId,
      );
      if (remaining.length === currentIdentity.members.length) {
        return yield* fail("not_found", "That machine is not a member of this link.");
      }

      if (remaining.length <= 1) {
        const freshIdentity: LogicalProject = {
          id: `logical:${yield* randomUuidV4}`,
          title: project.title,
          coordinatorId: self.coordinatorThreadId,
          members: [self],
        };
        const freshBinding = unlinkedBinding;
        yield* writeOwnership(project, "personal-unlink-last", operationId, {
          mode: "unlink",
          logicalProject: freshIdentity,
          coordinatorBinding: freshBinding,
        });
        return {
          projectId: project.id,
          unlinked: true,
          remainingMembers: [self],
        };
      }

      const removed = currentIdentity.members.filter(
        (member) => member.environmentId === input.removeEnvironmentId,
      );
      const currentBinding = settings.coordinatorBinding ?? { epoch: 0, state: "active" as const };
      const now = leftAt;
      const nextBinding: ProjectCoordinatorBinding = {
        ...currentBinding,
        removedMembers: [
          ...(currentBinding.removedMembers ?? []),
          ...removed.map((member) => ({
            environmentId: member.environmentId,
            projectId: member.projectId,
            removedAt: now,
          })),
        ],
      };
      const nextIdentity: LogicalProject = {
        ...currentIdentity,
        members: remaining,
      };
      yield* writeOwnership(project, "personal-remove-member", operationId, {
        mode: "remove-member",
        logicalProject: nextIdentity,
        coordinatorBinding: nextBinding,
      });
      return {
        projectId: project.id,
        unlinked: false,
        remainingMembers: remaining,
      };
    });

  const setRoutineOwner: PersonalLinkServiceShape["setRoutineOwner"] = (input) =>
    Effect.gen(function* () {
      const project = yield* loadPersonal(input.projectId);
      const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
      const currentIdentity = settings.logicalProject;
      if (!currentIdentity) {
        return yield* fail(
          "not_linked",
          "Link this personal assistant before changing routine ownership.",
        );
      }
      const currentBinding = settings.coordinatorBinding ?? { epoch: 0, state: "active" as const };
      if ((currentBinding.routineOwner ?? true) === input.routineOwner) {
        return { projectId: project.id, routineOwner: input.routineOwner };
      }
      const operationId = `personal-routine-owner:${yield* randomUuidV4}`;
      yield* writeOwnership(project, "personal-routine-owner", operationId, {
        mode: "set-routine-owner",
        logicalProject: currentIdentity,
        coordinatorBinding: {
          ...currentBinding,
          state: "active",
          routineOwner: input.routineOwner,
        },
      });
      return { projectId: project.id, routineOwner: input.routineOwner };
    });

  return PersonalLinkService.of({
    preview,
    join,
    leave,
    setRoutineOwner,
  });
});

export const layer = Layer.effect(PersonalLinkService, make);

export const layerRpcHandlers = WsPersonalLinkRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const service = yield* PersonalLinkService;
    return {
      [WS_METHODS.personalLinkPreview]: (input) => service.preview(input),
      [WS_METHODS.personalLinkJoin]: (input) => service.join(input),
      [WS_METHODS.personalLinkLeave]: (input) => service.leave(input),
      [WS_METHODS.personalLinkSetRoutineOwner]: (input) => service.setRoutineOwner(input),
    };
  }),
);
