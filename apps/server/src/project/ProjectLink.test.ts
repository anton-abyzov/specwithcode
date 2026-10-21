// @effect-diagnostics nodeBuiltinImport:off - real folders give each copy its repository fingerprint.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  EventId,
  LogicalProject,
  type LogicalProjectMember,
  type Project,
  type ProjectCoordinatorReplica,
  ProjectId,
  ProjectLinkError,
  ThreadId,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  isLogicalProjectBinding,
  logicalProjectBindingMatch,
} from "../fleet/remoteWorkerMatching.ts";
import { planProjectCommand } from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ProjectRow } from "../orchestration-v2/ProjectStore.ts";
import * as CoordinatorReplicas from "./CoordinatorReplicas.ts";
import * as ProjectLink from "./ProjectLink.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});
/** A folder whose root `.git` names `origin`; enough for the read-only fingerprint scan. */
const checkout = (origin: string) => {
  const folder = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "link-")));
  folders.push(folder);
  NodeFS.mkdirSync(NodePath.join(folder, ".git"));
  NodeFS.writeFileSync(
    NodePath.join(folder, ".git/config"),
    `[remote "origin"]\n\turl = ${origin}\n`,
  );
  return folder;
};

const operationId = "11111111-1111-4111-8111-111111111111";
const unlinkId = "22222222-2222-4222-8222-222222222222";

/**
 * One machine: its projects, notes and coordinator activity, with project writes
 * planned by the real command rules so every ownership mode is enforced.
 */
function machine(environment: string) {
  const environmentId = EnvironmentId.make(environment);
  const projects = new Map<string, Project>();
  const notes = new Map<string, Map<string, { content: string; revision: number }>>();
  const receipts = new Map<string, Result.Result<Project, ProjectService.ProjectOperationError>>();
  const busy = new Set<string>();
  const ownershipModes: string[] = [];
  /** Coordinator runs by thread: when each was requested and what it asked. */
  const runs = new Map<string, Array<{ id: string; requestedAt: string; text: string }>>();
  const replicas = new Map<string, ProjectCoordinatorReplica>();
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
  const layer = ProjectLink.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(environmentId),
          getDescriptor: Effect.die("unused"),
        }),
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
    busy,
    ownershipModes,
    runs,
    replicas,
    run,
    fails,
    add,
    member,
  };
}

/** Both copies of EasyChamp from before shared identities, as on the M4 and the M3. */
const legacyPair = () => {
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
const withoutRoot = (member: LogicalProjectMember): LogicalProjectMember => ({
  environmentId: member.environmentId,
  projectId: member.projectId,
  coordinatorThreadId: member.coordinatorThreadId,
});

const link = async (pair: ReturnType<typeof legacyPair>) => {
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

describe("ProjectLink", () => {
  it("adopts an identity for a legacy kept copy, then links both ways so remote workers bind", async () => {
    const pair = legacyPair();
    const { prepared, accepted, committed } = await link(pair);
    expect(prepared.adopted).toBe(true);
    expect(prepared.logicalProject.id).toMatch(/^logical:[0-9a-f-]{36}$/);
    expect(prepared.logicalProject.members).toEqual([pair.kept]);
    expect(prepared.coordinatorBinding).toEqual({ epoch: 0, state: "active" });
    const kept = pair.m4.projects.get(pair.kept.projectId)!;
    const joined = pair.m3.projects.get(pair.joining.projectId)!;
    // The kept binding never changes; the joined copy relinquished beside it at the same epoch.
    expect(kept.workspaceSettings?.coordinatorBinding).toEqual({ epoch: 0, state: "active" });
    expect(joined.workspaceSettings?.coordinatorBinding).toEqual({
      epoch: 0,
      state: "transferred",
      operationId,
      successor: pair.kept,
    });
    expect(committed.logicalProject.members).toEqual([pair.kept, pair.joining]);
    expect(accepted.logicalProject.members).toEqual([pair.kept, pair.joining]);
    // The kept copy records which folder on which machine each member maps to.
    expect(
      kept.workspaceSettings!.logicalProject!.members.map((member) => [
        member.environmentId,
        member.workspaceRoot,
      ]),
    ).toEqual([
      ["m4", kept.workspaceRoot],
      ["m3", joined.workspaceRoot],
    ]);
    expect(pair.m4.ownershipModes).toEqual(["adopt-identity", "link-member"]);
    expect(pair.m3.ownershipModes).toEqual(["join-as-member"]);
    // Project ids never change; the remote worker path now admits the M3 copy from the M4.
    const logical = kept.workspaceSettings!.logicalProject!;
    const selected = logicalProjectBindingMatch({ logical, environmentId: pair.m3.environmentId });
    expect(selected).toMatchObject({ match: "configured", projectId: pair.joining.projectId });
    expect(isLogicalProjectBinding(joined, logical, pair.joining)).toBe(true);
    expect(
      isLogicalProjectBinding(kept, joined.workspaceSettings!.logicalProject!, pair.kept),
    ).toBe(true);
  });

  it("keeps an existing identity and epoch, and replays every step of a retried link", async () => {
    const pair = legacyPair();
    const identity = {
      id: "logical:existing",
      title: "EasyChamp",
      coordinatorId: "coordinator:logical:existing",
      members: [pair.kept],
    };
    pair.m4.projects.set(pair.kept.projectId, {
      ...pair.m4.projects.get(pair.kept.projectId)!,
      workspaceSettings: {
        ...pair.m4.projects.get(pair.kept.projectId)!.workspaceSettings!,
        logicalProject: identity,
        coordinatorBinding: { epoch: 3, state: "active", operationId: "old-handoff" },
      },
    });
    const first = await link(pair);
    expect(first.prepared.adopted).toBe(false);
    expect(first.prepared.logicalProject.id).toBe("logical:existing");
    const again = await link(pair);
    expect(again.accepted.replayed).toBe(true);
    expect(again.committed.replayed).toBe(true);
    expect(
      pair.m3.projects.get(pair.joining.projectId)!.workspaceSettings!.coordinatorBinding,
    ).toMatchObject({
      epoch: 3,
      state: "transferred",
    });
    expect(pair.m4.ownershipModes).toEqual(["link-member"]);
    expect(pair.m3.ownershipModes).toEqual(["join-as-member"]);
  });

  it("leaves no state that blocks sending when the kept machine drops before commit", async () => {
    const pair = legacyPair();
    const prepared = await pair.m4.run((service) =>
      service.prepare({ operationId, projectId: pair.kept.projectId, joining: pair.joining }),
    );
    await pair.m3.run((service) =>
      service.accept({
        operationId,
        projectId: pair.joining.projectId,
        kept: prepared.kept,
        logicalProject: prepared.logicalProject,
        coordinatorBinding: prepared.coordinatorBinding,
        keptFingerprint: prepared.fingerprint,
      }),
    );
    // Half linked: the kept copy still coordinates alone and the joined copy defers to it.
    const kept = pair.m4.projects.get(pair.kept.projectId)!;
    expect(kept.workspaceSettings?.coordinatorBinding?.state).toBe("active");
    expect(
      logicalProjectBindingMatch({
        logical: kept.workspaceSettings!.logicalProject!,
        environmentId: pair.m3.environmentId,
      }).match,
    ).toBe("none");
    // Recovery is the same commit, later.
    const finished = await pair.m4.run((service) =>
      service.commit({
        operationId,
        projectId: pair.kept.projectId,
        joining: pair.joining,
        notes: [],
      }),
    );
    expect(finished.logicalProject.members).toHaveLength(2);
  });

  it("refuses with the fix named: shared copies, handoffs, busy coordinators, other repositories", async () => {
    const pair = legacyPair();
    const prepared = await pair.m4.run((service) =>
      service.prepare({ operationId, projectId: pair.kept.projectId, joining: pair.joining }),
    );
    const accept = (
      target: ReturnType<typeof machine>,
      projectId: ProjectId,
      fingerprint = prepared.fingerprint,
    ) =>
      target.run((service) =>
        service.accept({
          operationId,
          projectId,
          kept: prepared.kept,
          logicalProject: prepared.logicalProject,
          coordinatorBinding: prepared.coordinatorBinding,
          keptFingerprint: fingerprint,
        }),
      );
    const other = pair.m3.member("other-copy");
    pair.m3.add("shared", checkout("git@github.com:anton/sw-easychamp.git"), {
      logicalProject: {
        id: "logical:elsewhere",
        title: "EasyChamp",
        coordinatorId: "coordinator:logical:elsewhere",
        members: [pair.m3.member("shared"), other],
      },
      coordinatorBinding: { epoch: 0, state: "active" },
    });
    expect((await pair.m3.fails(accept(pair.m3, ProjectId.make("shared")))).code).toBe(
      "already_shared",
    );
    pair.m3.add("handing-off", checkout("git@github.com:anton/sw-easychamp.git"), {
      coordinatorBinding: { epoch: 0, state: "transferring", operationId: "handoff" },
    });
    expect((await pair.m3.fails(accept(pair.m3, ProjectId.make("handing-off")))).code).toBe(
      "handoff_in_progress",
    );
    pair.m3.busy.add("project-coordinator:easychamp-m3");
    expect((await pair.m3.fails(accept(pair.m3, pair.joining.projectId))).code).toBe(
      "coordinator_busy",
    );
    pair.m3.busy.clear();
    pair.m3.add("olysense", checkout("git@github.com:anton/olysense.git"));
    const mismatch = await pair.m3.fails(accept(pair.m3, ProjectId.make("olysense")));
    expect(mismatch.code).toBe("repository_mismatch");
    expect(mismatch.message).toContain("github.com/anton/olysense");
    expect(mismatch.message).toContain("github.com/anton/sw-easychamp");
    // Nothing above changed a project.
    expect(pair.m3.ownershipModes).toEqual([]);
    // Two copies on one machine are not a cross-machine link.
    expect(
      (
        await pair.m4.fails(
          pair.m4.run((service) =>
            service.prepare({
              operationId,
              projectId: pair.kept.projectId,
              joining: pair.m4.member("x"),
            }),
          ),
        )
      ).code,
    ).toBe("same_machine");
    // A relinquished copy cannot be the one that keeps its coordinator.
    await accept(pair.m3, pair.joining.projectId);
    expect(
      (
        await pair.m3.fails(
          pair.m3.run((service) =>
            service.prepare({ operationId, projectId: pair.joining.projectId, joining: pair.kept }),
          ),
        )
      ).code,
    ).toBe("not_coordinator");
  });

  it("never previews or links a personal assistant, and returns none of its notes", async () => {
    const pair = legacyPair();
    const household = pair.m3.add(
      "example-household",
      checkout("https://github.com/example/example-household.git"),
      { kind: "personal" },
    );
    pair.m3.notes(household.id).set("groceries.md", { content: "Private list", revision: 1 });
    const refused = await pair.m3.fails(
      pair.m3.run((service) => service.preview({ projectId: household.id })),
    );
    expect(refused.code).toBe("not_code_project");
    expect(JSON.stringify(refused)).not.toContain("Private list");
    // Neither side of a link takes it.
    const asKept = await pair.m3.fails(
      pair.m3.run((service) =>
        service.prepare({ operationId, projectId: household.id, joining: pair.kept }),
      ),
    );
    expect(asKept.code).toBe("not_code_project");
    const prepared = await pair.m4.run((service) =>
      service.prepare({ operationId, projectId: pair.kept.projectId, joining: pair.joining }),
    );
    const asJoining = await pair.m3.fails(
      pair.m3.run((service) =>
        service.accept({
          operationId,
          projectId: household.id,
          kept: prepared.kept,
          logicalProject: prepared.logicalProject,
          coordinatorBinding: prepared.coordinatorBinding,
          keptFingerprint: prepared.fingerprint,
        }),
      ),
    );
    expect(asJoining.code).toBe("not_code_project");
    expect(pair.m3.projects.get(household.id)?.workspaceSettings?.logicalProject).toBeFalsy();
  });

  it("previews notes and roles, and writes only chosen notes after checking their revisions", async () => {
    const pair = legacyPair();
    pair.m4.notes(pair.kept.projectId).set("decisions.md", { content: "M4 decision", revision: 2 });
    pair.m3
      .notes(pair.joining.projectId)
      .set("decisions.md", { content: "M3 decision", revision: 1 });
    pair.m3.notes(pair.joining.projectId).set("only-m3.md", { content: "M3 only", revision: 1 });
    const preview = await pair.m3.run((service) =>
      service.preview({ projectId: pair.joining.projectId }),
    );
    expect(preview).toMatchObject({
      member: pair.joining,
      keepRefusal: null,
      joinRefusal: null,
      lastCoordinatorActivityAt: "2026-10-18T09:00:00.000Z",
      notesTruncated: false,
    });
    expect(preview.notes.map((note) => note.name).sort()).toEqual(["decisions.md", "only-m3.md"]);
    expect(preview.fingerprint.repositories[0]?.originKey).toBe("github.com/anton/sw-easychamp");
    const { prepared } = await link(pair);
    const commit = (notes: Parameters<ProjectLink.ProjectLink["Service"]["commit"]>[0]["notes"]) =>
      pair.m4.run((service) =>
        service.commit({
          operationId,
          projectId: prepared.kept.projectId,
          joining: pair.joining,
          notes,
        }),
      );
    // A preview taken before another edit is refused, and nothing is written.
    expect(
      (
        await pair.m4.fails(
          commit([
            { name: "only-m3.md", content: "M3 only", expectedRevision: null },
            { name: "decisions.md", content: "M3 decision", expectedRevision: 1 },
          ]),
        )
      ).code,
    ).toBe("notes_changed");
    expect(pair.m4.notes(pair.kept.projectId).has("only-m3.md")).toBe(false);
    const written = await commit([
      { name: "only-m3.md", content: "M3 only", expectedRevision: null },
      { name: "decisions-macbook-pro-m3.md", content: "M3 decision", expectedRevision: null },
    ]);
    expect(written.notesWritten).toBe(2);
    expect(pair.m4.notes(pair.kept.projectId).get("decisions.md")?.content).toBe("M4 decision");
    // The member keeps its own notes as they were.
    expect(pair.m3.notes(pair.joining.projectId).get("decisions.md")?.content).toBe("M3 decision");
    // A retry writes nothing twice.
    expect(
      (
        await commit([
          { name: "only-m3.md", content: "M3 only", expectedRevision: null },
          { name: "decisions-macbook-pro-m3.md", content: "M3 decision", expectedRevision: null },
        ])
      ).notesWritten,
    ).toBe(0);
  });

  it("unlinks a member to a fresh active coordinator and drops it from the kept copy", async () => {
    const pair = legacyPair();
    pair.m3.notes(pair.joining.projectId).set("decisions.md", { content: "M3", revision: 1 });
    const { prepared } = await link(pair);
    const unlinked = await pair.m3.run((service) =>
      service.unlink({
        side: "member",
        operationId: unlinkId,
        projectId: pair.joining.projectId,
        notes: [
          { name: "kept-notes.md", content: "From M4", expectedRevision: null },
          { name: "decisions-macbook-m4max.md", content: "M4", expectedRevision: null },
        ],
      }),
    );
    expect(unlinked.logicalProject.id).not.toBe(prepared.logicalProject.id);
    expect(unlinked.logicalProject.members).toEqual([pair.joining]);
    expect(unlinked.coordinatorBinding).toEqual({
      epoch: 0,
      state: "active",
      operationId: unlinkId,
    });
    expect(unlinked.notesWritten).toBe(2);
    expect(pair.m3.notes(pair.joining.projectId).get("decisions.md")?.content).toBe("M3");
    const replay = await pair.m3.run((service) =>
      service.unlink({
        side: "member",
        operationId: unlinkId,
        projectId: pair.joining.projectId,
        notes: [],
      }),
    );
    expect(replay.replayed).toBe(true);
    const removed = await pair.m4.run((service) =>
      service.unlink({
        side: "coordinator",
        operationId: unlinkId,
        projectId: pair.kept.projectId,
        member: pair.joining,
      }),
    );
    expect(removed.logicalProject.members).toEqual([pair.kept]);
    expect(removed.coordinatorBinding).toEqual({ epoch: 0, state: "active" });
    expect(
      (
        await pair.m4.run((service) =>
          service.unlink({
            side: "coordinator",
            operationId: unlinkId,
            projectId: pair.kept.projectId,
            member: pair.joining,
          }),
        )
      ).replayed,
    ).toBe(true);
    expect(pair.m3.ownershipModes).toEqual(["join-as-member", "unlink"]);
    expect(pair.m4.ownershipModes).toEqual(["adopt-identity", "link-member", "remove-member"]);
    // The kept coordinator cannot unlink itself, and an unlinked copy cannot unlink again.
    expect(
      (
        await pair.m4.fails(
          pair.m4.run((service) =>
            service.unlink({
              side: "member",
              operationId,
              projectId: pair.kept.projectId,
              notes: [],
            }),
          ),
        )
      ).code,
    ).toBe("not_linked");
  });

  it("matches, backfills and unlinks members recorded before folders, keyed by machine and project", async () => {
    const pair = legacyPair();
    const m2: LogicalProjectMember = {
      environmentId: EnvironmentId.make("m2"),
      projectId: ProjectId.make("easychamp-m2"),
      coordinatorThreadId: ThreadId.make("project-coordinator:easychamp-m2"),
    };
    // Stored by an older server: no member records its folder.
    const identity = Schema.decodeUnknownSync(LogicalProject)({
      id: "logical:legacy",
      title: "EasyChamp",
      coordinatorId: "coordinator:logical:legacy",
      members: [withoutRoot(pair.kept), m2],
    });
    expect(identity.members.some((member) => "workspaceRoot" in member)).toBe(false);
    const project = pair.m4.projects.get(pair.kept.projectId)!;
    pair.m4.projects.set(pair.kept.projectId, {
      ...project,
      workspaceSettings: { ...project.workspaceSettings!, logicalProject: identity },
    });
    const { prepared, accepted, committed } = await link(pair);
    // The kept server fills its own folder in; the joining server fills in its own.
    expect(prepared.kept).toEqual(pair.kept);
    expect(prepared.logicalProject.members).toEqual([pair.kept, m2]);
    expect(accepted.member).toEqual(pair.joining);
    expect(accepted.logicalProject.members).toEqual([pair.kept, m2, pair.joining]);
    expect(committed.logicalProject.members).toEqual([pair.kept, m2, pair.joining]);
    const stored = () =>
      pair.m4.projects.get(pair.kept.projectId)!.workspaceSettings!.logicalProject!.members;
    expect(stored()).toEqual([pair.kept, m2, pair.joining]);
    // Retries that carry no folders still match the rooted entries.
    const retried = await pair.m3.run((service) =>
      service.accept({
        operationId,
        projectId: pair.joining.projectId,
        kept: withoutRoot(pair.kept),
        logicalProject: identity,
        coordinatorBinding: prepared.coordinatorBinding,
        keptFingerprint: prepared.fingerprint,
      }),
    );
    expect(retried.replayed).toBe(true);
    const recommitted = await pair.m4.run((service) =>
      service.commit({
        operationId,
        projectId: pair.kept.projectId,
        joining: withoutRoot(pair.joining),
        notes: [],
      }),
    );
    expect(recommitted.replayed).toBe(true);
    expect(stored()).toEqual([pair.kept, m2, pair.joining]);
    // Unlinking matches by machine and project whether or not either side has a folder.
    const removed = await pair.m4.run((service) =>
      service.unlink({
        side: "coordinator",
        operationId: unlinkId,
        projectId: pair.kept.projectId,
        member: withoutRoot(pair.joining),
      }),
    );
    expect(removed.logicalProject.members).toEqual([pair.kept, m2]);
    const removedLegacy = await pair.m4.run((service) =>
      service.unlink({
        side: "coordinator",
        operationId: "33333333-3333-4333-8333-333333333333",
        projectId: pair.kept.projectId,
        member: { ...m2, workspaceRoot: "/Users/anton/elsewhere" },
      }),
    );
    expect(removedLegacy.logicalProject.members).toEqual([pair.kept]);
    expect(stored()).toEqual([pair.kept]);
    expect(pair.m4.ownershipModes).toEqual(["link-member", "remove-member", "remove-member"]);
  });

  it("fingerprints a project or a folder, never both", async () => {
    const pair = legacyPair();
    const root = pair.m4.projects.get(pair.kept.projectId)!.workspaceRoot;
    const byProject = await pair.m4.run((service) =>
      service.fingerprint({ projectId: pair.kept.projectId }),
    );
    const byFolder = await pair.m4.run((service) => service.fingerprint({ workspaceRoot: root }));
    expect(byFolder).toEqual(byProject);
    expect(
      (
        await pair.m4.fails(
          pair.m4.run((service) =>
            service.fingerprint({ projectId: pair.kept.projectId, workspaceRoot: root }),
          ),
        )
      ).code,
    ).toBe("invalid");
    expect(
      (
        await pair.m4.fails(
          pair.m4.run((service) => service.fingerprint({ workspaceRoot: "relative" })),
        )
      ).code,
    ).toBe("invalid");
  });

  describe("coordinator takeover", () => {
    const takeoverId = "33333333-3333-4333-8333-333333333333";
    /** M4 coordinates; the M3 copy runs workers and holds a replica of M4's notes. */
    const linkedWithReplica = async () => {
      const pair = legacyPair();
      const { prepared } = await link(pair);
      pair.m4.notes(pair.kept.projectId).set("decisions.md", { content: "Ship 2.0", revision: 3 });
      const kept = pair.m4.projects.get(pair.kept.projectId)!;
      pair.m4.projects.set(pair.kept.projectId, {
        ...kept,
        workspaceSettings: { ...kept.workspaceSettings!, goal: "Launch EasyChamp 2.0" },
      });
      const owner = await pair.m4.run((service) =>
        service.preview({ projectId: pair.kept.projectId }),
      );
      const ownerDigest = await pair.m4.run((service) =>
        service.digest({ projectId: pair.kept.projectId }),
      );
      const replica = {
        from: pair.kept,
        logicalProjectId: prepared.logicalProject.id,
        digest: ownerDigest.digest,
        replicatedAt: "2026-10-19T12:00:00.000Z",
        goal: owner.goal,
        instructions: owner.instructions,
        notes: owner.notes,
        notesTruncated: owner.notesTruncated,
      };
      return { pair, replica, ownerDigest };
    };

    it("keeps a replica of the coordinator's notes and starts a takeover from it", async () => {
      const { pair, replica, ownerDigest } = await linkedWithReplica();
      const first = await pair.m3.run((service) =>
        service.replicate({ projectId: pair.joining.projectId, replica }),
      );
      expect(first.replayed).toBe(false);
      const again = await pair.m3.run((service) =>
        service.replicate({ projectId: pair.joining.projectId, replica }),
      );
      expect(again.replayed).toBe(true);
      const held = await pair.m3.run((service) =>
        service.digest({ projectId: pair.joining.projectId }),
      );
      expect(held.replica).toMatchObject({ from: pair.kept, digest: ownerDigest.digest });
      // The member's own older note is kept beside the coordinator's version.
      pair.m3
        .notes(pair.joining.projectId)
        .set("decisions.md", { content: "Old plan", revision: 1 });
      const taken = await pair.m3.run((service) =>
        service.takeover({ operationId: takeoverId, projectId: pair.joining.projectId }),
      );
      expect(taken.replayed).toBe(false);
      expect(taken.notesWritten).toBe(2);
      expect(taken.replicaFrom).toBe(first.replicatedAt);
      expect(taken.coordinatorBinding).toMatchObject({
        epoch: 1,
        state: "active",
        operationId: takeoverId,
        predecessor: pair.kept,
      });
      expect(taken.coordinatorBinding.takenOverAt).toBeDefined();
      const notes = pair.m3.notes(pair.joining.projectId);
      expect(notes.get("decisions.md")?.content).toBe("Ship 2.0");
      expect(notes.get("decisions-before-takeover.md")?.content).toBe("Old plan");
      const joined = pair.m3.projects.get(pair.joining.projectId)!.workspaceSettings!;
      expect(joined.goal).toBe("Launch EasyChamp 2.0");
      expect(joined.logicalProject?.members).toEqual([pair.kept, pair.joining]);
      expect(pair.m3.ownershipModes).toEqual(["join-as-member", "takeover"]);
      const retried = await pair.m3.run((service) =>
        service.takeover({ operationId: takeoverId, projectId: pair.joining.projectId }),
      );
      expect(retried.replayed).toBe(true);
    });

    it("demotes the returning coordinator and lists the turns it ran while disconnected", async () => {
      const { pair } = await linkedWithReplica();
      const taken = await pair.m3.run((service) =>
        service.takeover({
          operationId: takeoverId,
          projectId: pair.joining.projectId,
          knownEpoch: 4,
        }),
      );
      expect(taken.coordinatorBinding.epoch).toBe(5);
      pair.m4.runs.set(pair.kept.coordinatorThreadId, [
        { id: "run-before", requestedAt: "2020-01-01T00:00:00.000Z", text: "Before the takeover" },
        { id: "run-after", requestedAt: "2099-01-01T00:00:00.000Z", text: "Plan the release" },
      ]);
      const supersede = () =>
        pair.m4.run((service) =>
          service.supersede({
            projectId: pair.kept.projectId,
            logicalProjectId: taken.logicalProject.id,
            successor: pair.joining,
            coordinatorBinding: taken.coordinatorBinding,
          }),
        );
      const demoted = await supersede();
      expect(demoted.replayed).toBe(false);
      expect(demoted.coordinatorBinding).toEqual({
        epoch: 5,
        state: "transferred",
        operationId: takeoverId,
        successor: pair.joining,
        takenOverAt: taken.coordinatorBinding.takenOverAt,
      });
      expect(demoted.ranWhileDisconnected).toEqual([
        {
          threadId: pair.kept.coordinatorThreadId,
          runId: "run-after",
          requestedAt: "2099-01-01T00:00:00.000Z",
          request: "Plan the release",
        },
      ]);
      expect((await supersede()).replayed).toBe(true);
      expect(pair.m4.ownershipModes).toEqual(["adopt-identity", "link-member", "superseded"]);
      const preview = await pair.m4.run((service) =>
        service.preview({ projectId: pair.kept.projectId }),
      );
      expect(preview.ranWhileDisconnected).toHaveLength(1);
      expect(preview.keepRefusal).toBe("not_coordinator");
    });

    it("refuses takeovers and demotions that do not follow from the link", async () => {
      const { pair, replica } = await linkedWithReplica();
      expect(
        (
          await pair.m4.fails(
            pair.m4.run((service) =>
              service.takeover({ operationId: takeoverId, projectId: pair.kept.projectId }),
            ),
          )
        ).code,
      ).toBe("not_member");
      expect(
        (
          await pair.m4.fails(
            pair.m4.run((service) =>
              service.replicate({ projectId: pair.kept.projectId, replica }),
            ),
          )
        ).code,
      ).toBe("not_member");
      expect(
        (
          await pair.m3.fails(
            pair.m3.run((service) =>
              service.replicate({
                projectId: pair.joining.projectId,
                replica: { ...replica, goal: "Tampered" },
              }),
            ),
          )
        ).code,
      ).toBe("invalid");
      const taken = await pair.m3.run((service) =>
        service.takeover({ operationId: takeoverId, projectId: pair.joining.projectId }),
      );
      const supersede = (coordinatorBinding: typeof taken.coordinatorBinding) =>
        pair.m4.fails(
          pair.m4.run((service) =>
            service.supersede({
              projectId: pair.kept.projectId,
              logicalProjectId: taken.logicalProject.id,
              successor: pair.joining,
              coordinatorBinding,
            }),
          ),
        );
      // It names another coordinator as the one it replaced.
      expect(
        (await supersede({ ...taken.coordinatorBinding, predecessor: pair.joining })).code,
      ).toBe("invalid");
      // Not above the coordinator's own epoch.
      expect((await supersede({ ...taken.coordinatorBinding, epoch: 0 })).code).toBe(
        "superseded_conflict",
      );
      expect(
        pair.m4.projects.get(pair.kept.projectId)!.workspaceSettings!.coordinatorBinding,
      ).toEqual({ epoch: 0, state: "active" });
    });
  });

  describe("a coordinator on each machine", () => {
    const startId = "44444444-4444-4444-8444-444444444444";
    it("starts the member's own coordinator beside the active one, replacing nothing", async () => {
      const pair = legacyPair();
      const { prepared } = await link(pair);
      pair.m4.notes(pair.kept.projectId).set("decisions.md", { content: "Ship 2.0", revision: 3 });
      pair.m4
        .notes(pair.kept.projectId)
        .set("MEMORY.md", { content: "- decisions.md", revision: 1 });
      const owner = await pair.m4.run((service) =>
        service.preview({ projectId: pair.kept.projectId }),
      );
      const ownerDigest = await pair.m4.run((service) =>
        service.digest({ projectId: pair.kept.projectId }),
      );
      await pair.m3.run((service) =>
        service.replicate({
          projectId: pair.joining.projectId,
          replica: {
            from: pair.kept,
            logicalProjectId: prepared.logicalProject.id,
            digest: ownerDigest.digest,
            replicatedAt: "2026-10-19T12:00:00.000Z",
            goal: owner.goal,
            instructions: owner.instructions,
            notes: owner.notes,
            notesTruncated: owner.notesTruncated,
          },
        }),
      );
      // The member's own note stays as it is; memory replication reconciles it.
      pair.m3
        .notes(pair.joining.projectId)
        .set("decisions.md", { content: "Minis plan", revision: 1 });
      const started = await pair.m3.run((service) =>
        service.startCoordinator({
          operationId: startId,
          projectId: pair.joining.projectId,
          knownEpoch: 2,
        }),
      );
      expect(started.replayed).toBe(false);
      expect(started.notesWritten).toBe(1);
      expect(started.coordinatorBinding).toEqual({
        epoch: 3,
        state: "active",
        operationId: startId,
      });
      const notes = pair.m3.notes(pair.joining.projectId);
      expect(notes.get("decisions.md")?.content).toBe("Minis plan");
      expect(notes.get("MEMORY.md")?.content).toBe("- decisions.md");
      expect(notes.has("decisions-before-takeover.md")).toBe(false);
      const joined = pair.m3.projects.get(pair.joining.projectId)!.workspaceSettings!;
      expect(joined.logicalProject?.members).toEqual([pair.kept, pair.joining]);
      expect(pair.m3.ownershipModes).toEqual(["join-as-member", "start-coordinator"]);
      // Both machines now run a coordinator; M4's binding was never touched.
      expect(
        pair.m4.projects.get(pair.kept.projectId)!.workspaceSettings!.coordinatorBinding,
      ).toEqual({ epoch: 0, state: "active" });
      const retried = await pair.m3.run((service) =>
        service.startCoordinator({ operationId: startId, projectId: pair.joining.projectId }),
      );
      expect(retried.replayed).toBe(true);
      expect(retried.coordinatorBinding).toEqual(started.coordinatorBinding);
      // A started coordinator names no predecessor, so M4 is never asked to give way.
      expect(
        (
          await pair.m4.fails(
            pair.m4.run((service) =>
              service.supersede({
                projectId: pair.kept.projectId,
                logicalProjectId: started.logicalProject.id,
                successor: pair.joining,
                coordinatorBinding: started.coordinatorBinding,
              }),
            ),
          )
        ).code,
      ).toBe("invalid");
    });

    it("is a no-op on an active coordinator and refuses copies that are not linked members", async () => {
      const pair = legacyPair();
      await link(pair);
      const kept = await pair.m4.run((service) =>
        service.startCoordinator({ operationId: startId, projectId: pair.kept.projectId }),
      );
      expect(kept).toMatchObject({ replayed: true, coordinatorBinding: { state: "active" } });
      expect(pair.m4.ownershipModes).toEqual(["adopt-identity", "link-member"]);
      pair.m3.add("standalone", checkout("https://github.com/anton/other.git"));
      expect(
        (
          await pair.m3.fails(
            pair.m3.run((service) =>
              service.startCoordinator({
                operationId: startId,
                projectId: ProjectId.make("standalone"),
              }),
            ),
          )
        ).code,
      ).toBe("not_member");
      const joined = pair.m3.projects.get(pair.joining.projectId)!;
      pair.m3.projects.set(pair.joining.projectId, {
        ...joined,
        workspaceSettings: {
          ...joined.workspaceSettings!,
          coordinatorBinding: { epoch: 0, state: "transferring", operationId: startId },
        },
      });
      expect(
        (
          await pair.m3.fails(
            pair.m3.run((service) =>
              service.startCoordinator({ operationId: startId, projectId: pair.joining.projectId }),
            ),
          )
        ).code,
      ).toBe("handoff_in_progress");
    });
  });
});
