import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, type Project } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { projectMutationOperation } from "./ProjectMutation.ts";
import { ProjectFolderChangeError, type ProjectService } from "./ProjectService.ts";

const projectId = ProjectId.make("project:mutation-mapping");
const project = {
  id: projectId,
  title: "Mapping",
  workspaceRoot: "/work/mapping",
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  deletedAt: null,
} satisfies Project;

it.effect("preserves every project mutation field", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const projects: Pick<ProjectService["Service"], "create" | "delete" | "update" | "getById"> = {
      getById: () => Effect.succeedSome(project),
      create: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      update: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      delete: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
    };

    yield* projectMutationOperation(projects, {
      type: "project.create",
      commandId: CommandId.make("command:create"),
      projectId,
      title: "Created",
      workspaceRoot: "/work/created",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: null,
      scripts: [],
    });
    yield* projectMutationOperation(projects, {
      type: "project.update",
      commandId: CommandId.make("command:update"),
      projectId,
      title: "Updated",
      workspaceRoot: "/work/mapping/",
      defaultModelSelection: null,
      autoPull: false,
      projectIcon: null,
      faviconPath: null,
      defaultThreadEnvMode: null,
      scripts: [],
    });
    yield* projectMutationOperation(projects, {
      type: "project.delete",
      commandId: CommandId.make("command:delete"),
      projectId,
      force: true,
    });

    assert.deepEqual(yield* Ref.get(calls), [
      {
        commandId: "command:create",
        projectId,
        title: "Created",
        workspaceRoot: "/work/created",
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        commandId: "command:update",
        projectId,
        title: "Updated",
        defaultModelSelection: null,
        autoPull: false,
        projectIcon: null,
        faviconPath: null,
        defaultThreadEnvMode: null,
        scripts: [],
      },
      { commandId: "command:delete", projectId, force: true },
    ]);
  }),
);

it.effect("keeps a temporary agent token from changing the person's list or alerts", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const projects: Pick<ProjectService["Service"], "create" | "delete" | "update" | "getById"> = {
      getById: () => Effect.succeed(Option.some(project)),
      create: () => Effect.succeed(project),
      update: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      delete: () => Effect.succeed(project),
    };
    const mutation = {
      type: "project.update",
      commandId: CommandId.make("command:update"),
      projectId,
      workspaceSettings: {
        expectedRevision: 3,
        origin: "user",
        notifications: "none",
        goal: "Ship it",
      },
    } as const;

    yield* projectMutationOperation(projects, mutation, "temporary-session");
    yield* projectMutationOperation(projects, mutation);

    assert.deepEqual(yield* Ref.get(calls), [
      {
        commandId: "command:update",
        projectId,
        workspaceSettings: { expectedRevision: 3, goal: "Ship it" },
      },
      {
        commandId: "command:update",
        projectId,
        workspaceSettings: {
          expectedRevision: 3,
          origin: "user",
          notifications: "none",
          goal: "Ship it",
        },
      },
    ]);
  }),
);

const recordingProjects = (calls: Ref.Ref<ReadonlyArray<unknown>>, known = true) =>
  ({
    getById: () => Effect.succeed(known ? Option.some(project) : Option.none()),
    create: (input) => Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
    update: (input) => Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
    delete: (input) => Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
  }) satisfies Pick<ProjectService["Service"], "create" | "delete" | "update" | "getById">;

it.effect("refuses a project.update that would move the folder", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const failure = yield* projectMutationOperation(recordingProjects(calls), {
      type: "project.update",
      commandId: CommandId.make("command:move-by-update"),
      projectId,
      title: "Renamed too",
      workspaceRoot: "/work/elsewhere",
    }).pipe(Effect.flip);

    assert.instanceOf(failure, ProjectFolderChangeError);
    assert.strictEqual(failure.reason, "use_folder_change");
    assert.include(failure.detail, "Nothing changed");
    assert.include(failure.detail, "Project settings > General > Project folder");
    assert.include(failure.detail, "`project move`");
    // Nothing else in the same update is applied either.
    assert.deepEqual(yield* Ref.get(calls), []);
  }),
);

it.effect("lets the same folder through as a no-op and leaves unknown projects to update", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    yield* projectMutationOperation(recordingProjects(calls), {
      type: "project.update",
      commandId: CommandId.make("command:same-root"),
      projectId,
      workspaceRoot: " /work/mapping ",
      autoPull: true,
    });
    yield* projectMutationOperation(recordingProjects(calls, false), {
      type: "project.update",
      commandId: CommandId.make("command:unknown"),
      projectId,
      workspaceRoot: "/work/elsewhere",
    });

    assert.deepEqual(yield* Ref.get(calls), [
      { commandId: "command:same-root", projectId, autoPull: true },
      { commandId: "command:unknown", projectId },
    ]);
  }),
);
