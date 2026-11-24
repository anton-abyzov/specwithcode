// @effect-diagnostics anyUnknownInErrorContext:off -- the restore points and database copy are loosely typed fakes.
/**
 * The joining seat's local-only files on the real project and memory stores
 * (1448 D-15): a file the owner keeps on this machine while the join saves its
 * copies stays out of the merge, under its own name, and is never shared.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type Project,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import { memoryContentHash } from "./LinkedMemoryHistory.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import { joinLink, sharedMemoryOf } from "./personalShareLink.ts";

const laptop = EnvironmentId.make("env-laptop");
const desktop = EnvironmentId.make("env-desktop");
const PERCY = ProjectId.make("percy-laptop");

const environment = {
  getEnvironmentId: Effect.succeed(laptop),
  getDescriptor: Effect.succeed({
    environmentId: laptop,
    label: "Laptop",
    platform: { os: "darwin", arch: "arm64" },
  }),
} as unknown as ServerEnvironment.ServerEnvironment["Service"];

const stores = Layer.mergeAll(
  RuntimeLayer.layerProjectService,
  Workspace.layer.pipe(Layer.provide(ProjectStore.layer)),
).pipe(
  Layer.provideMerge(LinkedMemoryHistory.layerMemory),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(
    Layer.succeed(WorkspacePaths.WorkspacePaths, {
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot.replace(/\/$/, "")),
      resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
        Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
    }),
  ),
  Layer.provideMerge(
    Layer.merge(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "percy-share-link-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const DESKTOP_INDEX = "# Memory\n\n- [Notes](notes.md): desktop notes\n";
const LAPTOP_NOTES = "Laptop notes.\n";

/** The starter's content as the share path carries it: names, hashes and its index. */
const starter = {
  self: {
    environmentId: desktop,
    projectId: ProjectId.make("percy-desktop"),
    coordinatorThreadId: ThreadId.make("project-coordinator:percy-desktop"),
  },
  link: null,
  settings: {
    updatedAt: "2026-11-24T08:00:00.000Z",
    title: "Percy",
    instructions: "Answer from the desktop.",
    icon: null,
    repositoryUrls: [],
  },
  memory: {
    files: [
      { name: "MEMORY.md", sha256: memoryContentHash(DESKTOP_INDEX) },
      { name: "notes.md", sha256: memoryContentHash("Desktop notes.\n") },
    ],
    index: DESKTOP_INDEX,
  },
};

const write = (name: string, content: string) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.ProjectWorkspaceService;
    yield* workspace.writeMemory({ projectId: PERCY, name, content, expectedRevision: null });
  });

/** "Keep on this machine" as the memory panel saves it: a workspace settings update. */
const keepOnThisMachine = (name: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const project = Option.getOrThrow(yield* projects.getById(PERCY));
    const settings = project.workspaceSettings!;
    yield* projects.update({
      commandId: CommandId.make(`keep-local:${name}:${settings.revision}`),
      projectId: PERCY,
      workspaceSettings: {
        expectedRevision: settings.revision,
        localOnlyMemoryFiles: [...(settings.localOnlyMemoryFiles ?? []), name],
      },
    });
  });

it.effect(
  "a clashing file kept on this machine while the copies are saved is neither renamed nor shared",
  () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      yield* projects.create({
        commandId: CommandId.make("assistant:laptop"),
        projectId: PERCY,
        title: "Percy",
        kind: "personal",
        workspaceRoot: "/fixtures/example-household/laptop",
      });
      yield* write("MEMORY.md", "# Memory\n\n- [Notes](notes.md): laptop notes\n");
      yield* write("notes.md", LAPTOP_NOTES);
      const workspace = yield* Workspace.ProjectWorkspaceService;
      const context = yield* Effect.context<
        ProjectService.ProjectService | Workspace.ProjectWorkspaceService
      >();
      // The project as the join read it, before the owner marked notes.md.
      const read: Project = Option.getOrThrow(yield* projects.getById(PERCY));

      yield* joinLink(
        {
          workspace,
          histories: yield* LinkedMemoryHistory.LinkedMemoryHistory,
          projects,
          restorePoints: {
            list: () => Effect.succeed([]),
            capture: () =>
              Effect.succeed({
                id: "point-1",
                savedAt: "2026-11-24T09:30:00.000Z",
                reason: "before-link",
                memoryFileCount: 2,
                path: "/scratch/points/point-1.json",
              } as never),
          },
          // The owner keeps notes.md on this machine while the database copy is saved.
          snapshot: {
            snapshot: (operationId) =>
              keepOnThisMachine("notes.md").pipe(
                Effect.provide(context),
                Effect.orDie,
                Effect.as(`/scratch/backups/${operationId}.sqlite`),
              ),
          },
        },
        {
          project: read,
          selfEnvironmentId: laptop,
          machineLabel: "Laptop",
          linkId: "logical:percy:test",
          title: "Percy",
          peer: starter,
          nowIso: "2026-11-24T10:00:00.000Z",
          switchOn: Effect.succeed(true),
        },
      );

      const project = Option.getOrThrow(yield* projects.getById(PERCY));
      const files = yield* workspace.readMemoryFiles({ projectId: PERCY });
      const byName = Object.fromEntries(files.map((file) => [file.name, file.content]));
      // Out of the merge: still under its own name, and no copy of it under another.
      assert.strictEqual(byName["notes.md"], LAPTOP_NOTES);
      assert.deepStrictEqual(
        files.filter((file) => file.content === LAPTOP_NOTES).map((file) => file.name),
        ["notes.md"],
      );
      // What this seat exports once linked holds none of it.
      const shared = sharedMemoryOf(project, files);
      assert.notInclude(
        shared.files.map((file) => file.sha256),
        memoryContentHash(LAPTOP_NOTES),
      );
    }).pipe(Effect.provide(stores), Effect.scoped),
  60_000,
);

it.effect(
  "a file kept on this machine never moves to a name that is not kept, so it never syncs",
  () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      yield* projects.create({
        commandId: CommandId.make("assistant:laptop-rename"),
        projectId: PERCY,
        title: "Percy",
        kind: "personal",
        workspaceRoot: "/fixtures/example-household/laptop",
      });
      yield* write("notes.md", LAPTOP_NOTES);
      yield* keepOnThisMachine("notes.md");
      const workspace = yield* Workspace.ProjectWorkspaceService;
      const notes = yield* workspace.readMemory({ projectId: PERCY, name: "notes.md" });
      const refused = yield* Effect.flip(
        workspace.renameMemory({
          projectId: PERCY,
          from: "notes.md",
          to: "notes.from-laptop.md",
          expectedRevision: notes.revision,
        }),
      );
      assert.strictEqual(refused.code, "conflict");
      assert.deepStrictEqual(
        (yield* workspace.readMemoryFiles({ projectId: PERCY })).map((file) => file.name),
        ["notes.md"],
      );
      // Kept under the new name first, as the migration does: the move goes ahead.
      yield* keepOnThisMachine("notes.from-laptop.md");
      const moved = yield* workspace.renameMemory({
        projectId: PERCY,
        from: "notes.md",
        to: "notes.from-laptop.md",
        expectedRevision: notes.revision,
      });
      assert.strictEqual(moved.content, LAPTOP_NOTES);
    }).pipe(Effect.provide(stores), Effect.scoped),
  60_000,
);
