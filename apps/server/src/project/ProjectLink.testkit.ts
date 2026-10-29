// @effect-diagnostics nodeBuiltinImport:off - real folders give each copy its repository fingerprint.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  EventId,
  type LogicalProjectMember,
  type Project,
  type ProjectCoordinatorReplica,
  ProjectId,
  ProjectLinkError,
  ThreadId,
} from "@specweave-studio/contracts";
import { expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { planProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProjectRow } from "../orchestration-v2/ProjectStore.ts";
import * as CoordinatorReplicas from "./CoordinatorReplicas.ts";
import {
  type CoordinatorStandbyRecord,
  CoordinatorStandbyStore,
} from "./CoordinatorStandbyStore.ts";
import * as ProjectLink from "./ProjectLink.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";

/**
 * Two machines' ProjectLink services over in-memory projects, notes, replicas
 * and standby records, for ProjectLink.test.ts.
 */
const folders: string[] = [];
/** Removes the folders `checkout` made; call after each test. */
export const removeCheckouts = () => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
};
/** A folder whose root `.git` names `origin`; enough for the read-only fingerprint scan. */
export const checkout = (origin: string) => {
  const folder = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "link-")));
  folders.push(folder);
  NodeFS.mkdirSync(NodePath.join(folder, ".git"));
  NodeFS.writeFileSync(
    NodePath.join(folder, ".git/config"),
    `[remote "origin"]\n\turl = ${origin}\n`,
  );
  return folder;
};

export const operationId = "11111111-1111-4111-8111-111111111111";
export const unlinkId = "22222222-2222-4222-8222-222222222222";

/**
 * One machine: its projects, notes and coordinator activity, with project writes
 * planned by the real command rules so every ownership mode is enforced.
 */
export function machine(environment: string) {
  const environmentId = EnvironmentId.make(environment);
  const projects = new Map<string, Project>();
  const notes = new Map<string, Map<string, { content: string; revision: number }>>();
  const receipts = new Map<string, Result.Result<Project, ProjectService.ProjectOperationError>>();
  const busy = new Set<string>();
  const ownershipModes: string[] = [];
  /** Note names whose next write fails, as a storage failure would. */
  const failingWrites = new Set<string>();
  /** Coordinator runs by thread: when each was requested and what it asked. */
  const runs = new Map<string, Array<{ id: string; requestedAt: string; text: string }>>();
  const replicas = new Map<string, ProjectCoordinatorReplica>();
  /** This machine's standby records, and whether it says it can stand by. */
  const standby = new Map<string, CoordinatorStandbyRecord>();
  const capabilities = { coordinatorStandby: true };
  const toRow = (project: Project): ProjectRow =>
    ({
      projectId: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      deletedAt: null,
      workspaceSettings: project.workspaceSettings,
    }) as ProjectRow;
  const update = (input: ProjectService.ProjectUpdateInput) =>
    Effect.suspend((): Effect.Effect<Project, ProjectService.ProjectServiceError> => {
      const replay = receipts.get(input.commandId);
      if (replay)
        return Result.isSuccess(replay)
          ? Effect.succeed(replay.success)
          : Effect.fail(replay.failure);
      const current = projects.get(input.projectId);
      if (!current)
        return Effect.fail(new ProjectService.ProjectNotFoundError({ projectId: input.projectId }));
      if (input.ownership) ownershipModes.push(input.ownership.mode);
      const planned = planProjectCommand({
        command: {
          type: "project.meta.update",
          commandId: input.commandId,
          projectId: input.projectId,
          ...(input.ownership ? { ownership: input.ownership } : {}),
          ...(input.workspaceSettings ? { workspaceSettings: input.workspaceSettings } : {}),
        },
        state: { project: toRow(current), workspaceOwner: undefined },
        eventId: EventId.make(`event:${input.commandId}`),
        now: DateTime.makeUnsafe("2026-10-19T12:00:00.000Z"),
      });
      if (Result.isFailure(planned)) {
        const failure = new ProjectService.ProjectOperationError({
          operation: "dispatch-project-command",
          projectId: input.projectId,
          cause: planned.failure,
        });
        receipts.set(input.commandId, Result.fail(failure));
        return Effect.fail(failure);
      }
      const payload = planned.success.payload as {
        workspaceSettings?: Project["workspaceSettings"];
      };
      const next = {
        ...current,
        workspaceSettings: payload.workspaceSettings ?? current.workspaceSettings,
      };
      projects.set(input.projectId, next);
      receipts.set(input.commandId, Result.succeed(next));
      return Effect.succeed(next);
    });
  const notesOf = (projectId: string) => {
    const existing = notes.get(projectId) ?? new Map();
    notes.set(projectId, existing);
    return existing;
  };
  /** ProjectLink with the services it was built on, for services layered over it. */
  const layer = ProjectLink.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(environmentId),
          getDescriptor: Effect.sync(() => ({ capabilities: { ...capabilities } })),
        } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
        Layer.succeed(
          CoordinatorStandbyStore,
          CoordinatorStandbyStore.of({
            list: Effect.sync(() => [...standby.values()]),
            get: (id) => Effect.sync(() => standby.get(id)),
            modify: (id, change) =>
              Effect.sync(() => {
                const next = change(standby.get(id));
                if (next === undefined) return standby.get(id);
                if (next === null) return void standby.delete(id);
                standby.set(id, next);
                return next;
              }),
          }),
        ),
        Layer.succeed(ProjectService.ProjectService, {
          getById: (projectId: ProjectId) =>
            Effect.succeed(Option.fromNullishOr(projects.get(projectId))),
          update,
        } as unknown as ProjectService.ProjectService["Service"]),
        Layer.succeed(ProjectWorkspaceService.ProjectWorkspaceService, {
          readWorkspace: ({ projectId }: { projectId: ProjectId }) =>
            Effect.succeed({
              settings: projects.get(projectId)!.workspaceSettings!,
              memory: {
                files: [...notesOf(projectId)].map(([name, note]) => ({
                  name,
                  revision: note.revision,
                  updatedAt: "2026-10-19T00:00:00.000Z",
                  byteLength: Buffer.byteLength(note.content),
                })),
                totalBytes: 0,
              },
            }),
          readMemory: ({ projectId, name }: { projectId: ProjectId; name: string }) => {
            const note = notesOf(projectId).get(name);
            return note
              ? Effect.succeed({
                  name,
                  ...note,
                  updatedAt: "2026-10-19T00:00:00.000Z",
                  byteLength: Buffer.byteLength(note.content),
                })
              : Effect.fail({ code: "not_found" });
          },
          writeMemory: (input: {
            projectId: ProjectId;
            name: string;
            content: string;
            expectedRevision: number | null;
          }) =>
            Effect.suspend(() => {
              if (failingWrites.delete(input.name)) return Effect.fail({ code: "storage_failed" });
              const existing = notesOf(input.projectId).get(input.name);
              if ((existing?.revision ?? null) !== input.expectedRevision)
                return Effect.fail({ code: "conflict" });
              const note = { content: input.content, revision: (existing?.revision ?? 0) + 1 };
              notesOf(input.projectId).set(input.name, note);
              return Effect.succeed({ name: input.name, ...note });
            }),
        } as unknown as ProjectWorkspaceService.ProjectWorkspaceService["Service"]),
        Layer.succeed(
          CoordinatorReplicas.CoordinatorReplicas,
          CoordinatorReplicas.CoordinatorReplicas.of({
            read: (projectId) => Effect.sync(() => Option.fromNullishOr(replicas.get(projectId))),
            write: (projectId, replica) => Effect.sync(() => void replicas.set(projectId, replica)),
            remove: (projectId) => Effect.sync(() => void replicas.delete(projectId)),
          }),
        ),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getThreadProjection: (threadId: ThreadId) =>
            Effect.succeed({
              runs: (runs.get(threadId) ?? []).map((run) => ({
                id: run.id,
                requestedAt: DateTime.makeUnsafe(run.requestedAt),
                userMessageId: `message:${run.id}`,
              })),
              messages: (runs.get(threadId) ?? []).map((run) => ({
                id: `message:${run.id}`,
                text: run.text,
              })),
            }),
          getThreadShell: (threadId: ThreadId) =>
            Effect.succeed({
              id: threadId,
              activeRunId: busy.has(threadId) ? "run" : null,
              latestRunRequestedAt: DateTime.makeUnsafe("2026-10-18T09:00:00.000Z"),
              latestUserMessageAt: null,
            }),
        } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      ),
    ),
  );
  const run = <A>(
    use: (link: ProjectLink.ProjectLink["Service"]) => Effect.Effect<A, ProjectLinkError>,
  ) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* use(yield* ProjectLink.ProjectLink);
      }).pipe(Effect.provide(layer)),
    ).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      throw Cause.squash(exit.cause);
    });
  const fails = async (effect: Promise<unknown>) => {
    const error = await effect.then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ProjectLinkError);
    return error as ProjectLinkError;
  };
  const add = (
    id: string,
    root: string,
    settings: Partial<NonNullable<Project["workspaceSettings"]>> = {},
  ) => {
    const project = {
      id: ProjectId.make(id),
      title: "EasyChamp",
      workspaceRoot: root,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
      workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, ...settings },
    } as Project;
    projects.set(id, project);
    return project;
  };
  const member = (id: string): LogicalProjectMember => ({
    environmentId,
    projectId: ProjectId.make(id),
    coordinatorThreadId: ThreadId.make(`project-coordinator:${id}`),
  });
  return {
    environmentId,
    projects,
    notes: notesOf,
    failingWrites,
    busy,
    ownershipModes,
    runs,
    replicas,
    standby,
    layer,
    capabilities,
    run,
    fails,
    add,
    member,
  };
}

/** Both copies of EasyChamp from before shared identities, as on the M4 and the M3. */
export const legacyPair = () => {
  const m4 = machine("m4");
  const m3 = machine("m3");
  const keptRoot = m4.add(
    "easychamp-m4",
    checkout("git@github.com:anton/sw-easychamp.git"),
  ).workspaceRoot;
  const joiningRoot = m3.add(
    "easychamp-m3",
    checkout("https://github.com/anton/sw-easychamp.git"),
  ).workspaceRoot;
  // Each server records its own copy's folder in the member it builds.
  return {
    m4,
    m3,
    kept: { ...m4.member("easychamp-m4"), workspaceRoot: keptRoot },
    joining: { ...m3.member("easychamp-m3"), workspaceRoot: joiningRoot },
  };
};

/** A member as servers listed it before members recorded their folder. */
export const withoutRoot = (member: LogicalProjectMember): LogicalProjectMember => ({
  environmentId: member.environmentId,
  projectId: member.projectId,
  coordinatorThreadId: member.coordinatorThreadId,
});

export const link = async (pair: ReturnType<typeof legacyPair>) => {
  const prepared = await pair.m4.run((service) =>
    service.prepare({ operationId, projectId: pair.kept.projectId, joining: pair.joining }),
  );
  const accepted = await pair.m3.run((service) =>
    service.accept({
      operationId,
      projectId: pair.joining.projectId,
      kept: prepared.kept,
      logicalProject: prepared.logicalProject,
      coordinatorBinding: prepared.coordinatorBinding,
      keptFingerprint: prepared.fingerprint,
    }),
  );
  const committed = await pair.m4.run((service) =>
    service.commit({
      operationId,
      projectId: pair.kept.projectId,
      joining: accepted.member,
      notes: [],
    }),
  );
  return { prepared, accepted, committed };
};
