// @effect-diagnostics anyUnknownInErrorContext:off -- the Connect, fleet and folder services are loosely typed fakes.
/**
 * Undo, on the real project and memory stores (1448 T-14, D-16): a joining
 * seat merges, its link write fails, the retry links it, and `percy undo`
 * puts its memory and settings back byte for byte. Only Connect, the fleet
 * list, the folder maker and the database copy are stand-ins; the restore
 * points are written to a private temporary home.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type PersonalAssistantShared,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { renamedMemoryName } from "@specweave-studio/shared/personalAssistantMigration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CloudLink from "../cloud/CloudLink.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetTargets from "../fleet/FleetTargets.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import { memoryContentHash } from "./LinkedMemoryHistory.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import { personalLinkIdForAccount } from "./personalLinkId.ts";
import { PersonalLinkSnapshot } from "./personalLinkSnapshot.ts";
import * as PersonalLinkService from "./PersonalLinkService.ts";
import * as PersonalRestorePoint from "./personalRestorePoint.ts";
import * as PersonalShare from "./PersonalShare.ts";
import { joinLink, PersonalShareLinkError } from "./personalShareLink.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const ACCOUNT = "user_owner_1";
const LINK = personalLinkIdForAccount(ACCOUNT);
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
  // A private temporary home: the restore points are written under it.
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "percy-undo-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const snapshot = Layer.succeed(PersonalLinkSnapshot, {
  snapshot: (operationId: string) => Effect.succeed(`/scratch/backups/${operationId}.sqlite`),
});

const share = PersonalShare.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      PersonalLinkService.layer,
      PersonalRestorePoint.layer,
      ServerSettings.layerTest({
        aideEnabled: true,
        personalAssistantShared: {
          enabled: true,
          machines: [desktop],
          enabledAt: "2026-11-24T09:00:00.000Z",
        } satisfies PersonalAssistantShared,
      }),
      Layer.succeed(CloudLink.CloudLink, {
        linkState: () => Effect.succeed({ linked: true, cloudUserId: ACCOUNT }),
      } as never),
      Layer.succeed(FleetTargets.FleetTargets, { load: Effect.succeed(null) } as never),
      Layer.succeed(ManagedProjectFolders.ManagedProjectFolders, {
        createNamedProject: () => Effect.die("this machine already has its assistant"),
      } as never),
      Layer.succeed(PersonalShare.PersonalSharePeers, { states: Effect.succeed(new Map()) }),
    ).pipe(Layer.provideMerge(snapshot)),
  ),
  Layer.provideMerge(stores),
);

const memoryOf = Effect.gen(function* () {
  const workspace = yield* Workspace.ProjectWorkspaceService;
  const files: Record<string, string> = {};
  for (const file of yield* workspace.readMemoryFiles({ projectId: PERCY }))
    files[file.name] = file.content;
  return files;
});

const write = (name: string, content: string) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.ProjectWorkspaceService;
    const current = yield* workspace.readMemory({ projectId: PERCY, name }).pipe(Effect.option);
    yield* workspace.writeMemory({
      projectId: PERCY,
      name,
      content,
      expectedRevision: Option.isSome(current) ? current.value.revision : null,
    });
  });

const DESKTOP_INDEX = "# Memory\n\n- [Notes](notes.md): desktop notes\n";

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

it.effect(
  "a join that merged, failed its link write and was retried is undone byte for byte",
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
      const created = Option.getOrThrow(yield* projects.getById(PERCY));
      yield* projects.update({
        commandId: CommandId.make("assistant:instructions"),
        projectId: PERCY,
        workspaceSettings: {
          expectedRevision: created.workspaceSettings!.revision,
          instructions: "Answer briefly.",
        },
      });
      yield* write("MEMORY.md", "# Memory\n\n- [Notes](notes.md): laptop notes\n");
      yield* write("notes.md", "Laptop notes.\n");
      const original = yield* memoryOf;
      const before = Option.getOrThrow(yield* projects.getById(PERCY));

      const services = {
        workspace: yield* Workspace.ProjectWorkspaceService,
        histories: yield* LinkedMemoryHistory.LinkedMemoryHistory,
        restorePoints: yield* PersonalRestorePoint.PersonalRestorePoint,
        snapshot: yield* PersonalLinkSnapshot,
      };
      let failLinkWrite = true;
      const flaky = {
        getById: projects.getById,
        update: (input: Parameters<typeof projects.update>[0]) =>
          input.ownership?.mode === "join-as-member" && failLinkWrite
            ? Effect.fail({ _tag: "ProjectSettingsRevisionConflictError" } as never)
            : projects.update(input),
      };
      const join = Effect.gen(function* () {
        const project = Option.getOrThrow(yield* projects.getById(PERCY));
        return yield* joinLink(
          { ...services, projects: flaky },
          {
            project,
            selfEnvironmentId: laptop,
            machineLabel: "Laptop",
            linkId: LINK,
            title: "Percy",
            peer: starter,
            nowIso: "2026-11-24T10:00:00.000Z",
          },
        );
      });

      const failed = yield* join.pipe(Effect.flip);
      assert.instanceOf(failed, PersonalShareLinkError);
      assert.strictEqual(failed.stage, "write");
      // The merge ran and the copies were saved; the link was not written.
      const laptopNotes = renamedMemoryName("notes.md", "Laptop", laptop);
      assert.strictEqual((yield* memoryOf)[laptopNotes], "Laptop notes.\n");
      assert.isUndefined(
        Option.getOrThrow(yield* projects.getById(PERCY)).workspaceSettings?.logicalProject
          ?.members[1],
      );

      failLinkWrite = false;
      yield* join;
      const linked = Option.getOrThrow(yield* projects.getById(PERCY));
      assert.strictEqual(linked.workspaceSettings?.logicalProject?.id, LINK);
      assert.deepStrictEqual(
        linked.workspaceSettings?.logicalProject?.members.map((member) => member.environmentId),
        [desktop, laptop],
      );
      assert.strictEqual(linked.workspaceSettings?.instructions, "Answer from the desktop.");
      const points = yield* services.restorePoints.list(PERCY);
      assert.deepStrictEqual(
        points.map((point) => point.reason),
        ["before-link"],
      );

      const status = yield* (yield* PersonalShare.PersonalShare).undo({});
      assert.strictEqual(status.enabled, false);
      assert.strictEqual(status.linked, false);
      assert.deepStrictEqual(yield* memoryOf, original);
      const after = Option.getOrThrow(yield* projects.getById(PERCY));
      assert.strictEqual(after.title, before.title);
      assert.strictEqual(after.workspaceSettings?.instructions, "Answer briefly.");
      assert.notStrictEqual(after.workspaceSettings?.logicalProject?.id, LINK);
      // The state just before the undo was saved too, so the undo can itself be undone.
      assert.deepStrictEqual(
        status.restorePoints.map((point) => point.reason),
        ["before-undo", "before-link"],
      );
    }).pipe(Effect.provide(share), Effect.scoped),
  60_000,
);
