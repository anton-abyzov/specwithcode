import { assert, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  EventId,
  type LinkedMemoryExport,
  PROJECT_MEMORY_FILE_BYTES,
  ProjectId,
  type ProjectLinkError,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import * as LinkedMemorySync from "./LinkedMemorySync.ts";
import { projectFixture } from "./ProjectWorkspace.testkit.ts";
import * as ProjectService from "./ProjectService.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";

const LOGICAL_ID = "logical:memory";
const alpha = {
  environmentId: EnvironmentId.make("env-alpha"),
  projectId: ProjectId.make("alpha-copy"),
};
const beta = {
  environmentId: EnvironmentId.make("env-beta"),
  projectId: ProjectId.make("beta-copy"),
};
const members = [alpha, beta].map((member) => ({
  ...member,
  coordinatorThreadId: ThreadId.make(`coordinator:${member.projectId}`),
}));

/** One machine: its own database, memory, version history and sync service. */
const machine = (
  self: typeof alpha,
  label: string,
  logicalProject: { id: string; members: typeof members } | null = {
    id: LOGICAL_ID,
    members,
  },
) =>
  Effect.gen(function* () {
    const project = projectFixture(self.projectId, {
      workspaceSettings: {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        ...(logicalProject
          ? {
              logicalProject: {
                ...logicalProject,
                title: "Shared",
                coordinatorId: "coordinator",
              },
            }
          : {}),
      },
    });
    const storage = ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
    const workspace = Workspace.layer.pipe(
      Layer.provideMerge(Layer.merge(storage, LinkedMemoryHistory.layerMemory)),
    );
    const layer = LinkedMemorySync.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          workspace,
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(self.environmentId),
            getDescriptor: Effect.succeed({ label }),
          } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
          Layer.succeed(ProjectService.ProjectService, {
            getById: (projectId: ProjectId) =>
              Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
          } as unknown as ProjectService.ProjectService["Service"]),
        ),
      ),
    );
    const context = yield* Layer.buildWithMemoMap(
      layer,
      yield* Layer.makeMemoMap,
      yield* Effect.scope,
    );
    const run = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | LinkedMemorySync.LinkedMemorySync
        | Workspace.ProjectWorkspaceService
        | LinkedMemoryHistory.LinkedMemoryHistory
        | ProjectStore.ProjectStoreV2
      >,
    ) => Effect.provide(effect, context);
    yield* run(
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make(`event:${self.projectId}`),
          aggregateKind: "project",
          aggregateId: self.projectId,
          occurredAt: "2026-10-09T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId: self.projectId,
            title: "Shared",
            workspaceRoot: `/tmp/${self.projectId}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-09T00:00:00.000Z",
            updatedAt: "2026-10-09T00:00:00.000Z",
          },
        });
      }),
    );
    const write = (name: string, content: string) =>
      run(
        Effect.gen(function* () {
          const service = yield* Workspace.ProjectWorkspaceService;
          const current = yield* service
            .readMemory({ projectId: self.projectId, name })
            .pipe(Effect.option);
          return yield* service.writeMemory({
            projectId: self.projectId,
            name,
            content,
            expectedRevision: Option.isSome(current) ? current.value.revision : null,
          });
        }),
      );
    const remove = (name: string) =>
      run(
        Effect.gen(function* () {
          const service = yield* Workspace.ProjectWorkspaceService;
          const current = yield* service.readMemory({ projectId: self.projectId, name });
          yield* service.deleteMemory({
            projectId: self.projectId,
            name,
            expectedRevision: current.revision,
          });
        }),
      );
    const contents = run(
      Effect.gen(function* () {
        const service = yield* Workspace.ProjectWorkspaceService;
        const read = yield* service.readWorkspace({ projectId: self.projectId });
        const result: Record<string, string> = {};
        for (const file of read.memory.files)
          result[file.name] = (yield* service.readMemory({
            projectId: self.projectId,
            name: file.name,
          })).content;
        return result;
      }),
    );
    const sync = run(Effect.service(LinkedMemorySync.LinkedMemorySync));
    const exported = sync.pipe(
      Effect.flatMap((service) => service.memoryExport({ projectId: self.projectId })),
    );
    const merge = (peer: typeof alpha, memory: LinkedMemoryExport, peerLabel = "Peer") =>
      sync.pipe(
        Effect.flatMap((service) =>
          service.memoryMerge({
            projectId: self.projectId,
            peer: { ...peer, label: peerLabel },
            export: memory,
          }),
        ),
      );
    const history = run(
      Effect.service(LinkedMemoryHistory.LinkedMemoryHistory).pipe(
        Effect.flatMap((service) => service.read(self.projectId)),
      ),
    );
    return { self, write, remove, contents, exported, merge, history };
  });

type Machine = Effect.Success<ReturnType<typeof machine>>;
/** Both exports first, then each side merges the other's, as the client does. */
const pass = (left: Machine, right: Machine) =>
  Effect.gen(function* () {
    const fromLeft = yield* left.exported;
    const fromRight = yield* right.exported;
    const onLeft = yield* left.merge(right.self, fromRight);
    const onRight = yield* right.merge(left.self, fromLeft);
    return { onLeft, onRight };
  });
const refusal = (exit: Exit.Exit<unknown, ProjectLinkError>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit))?.code : "succeeded";

it.effect("records every memory write and delete as a version", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      yield* a.write("notes.md", "one");
      yield* a.write("notes.md", "two");
      const written = yield* a.history;
      assert.deepStrictEqual(written.files["notes.md"]?.history, [
        LinkedMemoryHistory.memoryContentHash("one"),
        LinkedMemoryHistory.memoryContentHash("two"),
      ]);
      yield* a.remove("notes.md");
      const deleted = yield* a.history;
      assert.isUndefined(deleted.files["notes.md"]);
      assert.deepStrictEqual(deleted.tombstones["notes.md"]?.history, [
        LinkedMemoryHistory.memoryContentHash("one"),
        LinkedMemoryHistory.memoryContentHash("two"),
      ]);
    }),
  ),
);

it.effect("exports MEMORY.md first with hashes, versions and tombstones", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      yield* a.write("zeta.md", "z");
      yield* a.write("MEMORY.md", "# index");
      yield* a.write("gone.md", "bye");
      yield* a.remove("gone.md");
      const memory = yield* a.exported;
      assert.strictEqual(memory.logicalProjectId, LOGICAL_ID);
      assert.strictEqual(memory.environmentId, alpha.environmentId);
      assert.strictEqual(memory.machineLabel, "Alpha");
      assert.strictEqual(memory.truncated, false);
      assert.deepStrictEqual(
        memory.files.map((file) => file.name),
        ["MEMORY.md", "zeta.md"],
      );
      const index = memory.files[0]!;
      assert.strictEqual(index.contentSha256, LinkedMemoryHistory.memoryContentHash("# index"));
      assert.deepStrictEqual(index.history, [index.contentSha256]);
      assert.deepStrictEqual(
        memory.tombstones.map((tombstone) => tombstone.name),
        ["gone.md"],
      );
    }),
  ),
);

// Live: the memory store stamps writes with the wall clock.
it.live("replicates memory both ways and keeps the losing edit as a conflict copy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* a.write("MEMORY.md", "# index");
      yield* a.write("notes.md", "base");
      yield* b.write("plan.md", "from beta");
      const first = yield* pass(a, b);
      assert.deepStrictEqual(first.onLeft.applied, ["plan.md"]);
      assert.deepStrictEqual(first.onRight.applied, ["MEMORY.md", "notes.md"]);
      assert.deepStrictEqual(yield* a.contents, yield* b.contents);

      yield* a.write("notes.md", "alpha edit");
      yield* Effect.sleep("5 millis");
      yield* b.write("notes.md", "beta edit");
      const second = yield* pass(a, b);
      assert.deepStrictEqual(second.onLeft.conflicts, [
        { name: "notes.md", copy: "notes.conflict-alpha.md" },
      ]);
      assert.deepStrictEqual(second.onRight.kept, ["notes.md"]);
      yield* pass(a, b);
      const expected = {
        "MEMORY.md": "# index",
        "notes.md": "beta edit",
        "notes.conflict-alpha.md": "alpha edit",
        "plan.md": "from beta",
      };
      assert.deepStrictEqual(yield* a.contents, expected);
      assert.deepStrictEqual(yield* b.contents, expected);
      const settled = yield* pass(a, b);
      assert.deepStrictEqual(settled.onLeft, { applied: [], conflicts: [], kept: [], skipped: [] });
      assert.deepStrictEqual(settled.onRight, {
        applied: [],
        conflicts: [],
        kept: [],
        skipped: [],
      });
    }),
  ),
);

it.effect("replicates deletions but never MEMORY.md", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* a.write("MEMORY.md", "# index");
      yield* a.write("notes.md", "v1");
      yield* pass(a, b);
      yield* b.remove("notes.md");
      yield* b.remove("MEMORY.md");
      const result = yield* pass(a, b);
      assert.deepStrictEqual(result.onLeft.applied, ["notes.md"]);
      assert.deepStrictEqual(result.onRight.applied, ["MEMORY.md"]);
      assert.deepStrictEqual(yield* a.contents, { "MEMORY.md": "# index" });
      assert.deepStrictEqual(yield* b.contents, { "MEMORY.md": "# index" });
    }),
  ),
);

it.effect("refuses merges from unlinked projects, unknown members and this machine", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      const lone = yield* machine(
        { environmentId: EnvironmentId.make("env-lone"), projectId: ProjectId.make("lone") },
        "Lone",
        null,
      );
      yield* b.write("notes.md", "v1");
      const memory = yield* b.exported;
      assert.strictEqual(refusal(yield* Effect.exit(lone.exported)), "not_linked");
      assert.strictEqual(refusal(yield* Effect.exit(lone.merge(beta, memory))), "not_linked");
      assert.strictEqual(
        refusal(
          yield* Effect.exit(a.merge(beta, { ...memory, logicalProjectId: "logical:other" })),
        ),
        "not_linked",
      );
      assert.strictEqual(
        refusal(
          yield* Effect.exit(a.merge(alpha, { ...memory, environmentId: alpha.environmentId })),
        ),
        "same_machine",
      );
      const stranger = {
        environmentId: EnvironmentId.make("env-stranger"),
        projectId: beta.projectId,
      };
      assert.strictEqual(
        refusal(
          yield* Effect.exit(
            a.merge(stranger, { ...memory, environmentId: stranger.environmentId }),
          ),
        ),
        "not_member",
      );
      assert.strictEqual(
        refusal(
          yield* Effect.exit(a.merge({ ...beta, environmentId: stranger.environmentId }, memory)),
        ),
        "invalid",
      );
      assert.deepStrictEqual(yield* a.contents, {});
    }),
  ),
);

it.effect("refuses memory that does not match its hash or is too large", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* b.write("notes.md", "v1");
      const memory = yield* b.exported;
      const tampered = {
        ...memory,
        files: memory.files.map((file) => ({ ...file, content: "tampered" })),
      };
      assert.strictEqual(refusal(yield* Effect.exit(a.merge(beta, tampered))), "invalid");
      const big = "x".repeat(PROJECT_MEMORY_FILE_BYTES);
      const oversized = {
        ...memory,
        files: Array.from({ length: 9 }, (_, index) => ({
          ...memory.files[0]!,
          name: `big-${index}.md`,
          content: big,
        })),
      };
      assert.strictEqual(refusal(yield* Effect.exit(a.merge(beta, oversized))), "too_large");
      assert.deepStrictEqual(yield* a.contents, {});
    }),
  ),
);

it.effect("skips a file the store refuses and merges the rest", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine(alpha, "Alpha");
      const b = yield* machine(beta, "Beta");
      yield* b.write("notes.md", "v1");
      const memory = yield* b.exported;
      const huge = "y".repeat(PROJECT_MEMORY_FILE_BYTES + 1);
      const result = yield* a.merge(beta, {
        ...memory,
        files: [
          ...memory.files,
          {
            name: "huge.md",
            content: huge,
            contentSha256: LinkedMemoryHistory.memoryContentHash(huge),
            updatedAt: "2026-10-19T00:00:00.000Z",
            history: [],
          },
        ],
      });
      assert.deepStrictEqual(result.applied, ["notes.md"]);
      assert.deepStrictEqual(result.skipped, ["huge.md"]);
      assert.deepStrictEqual(yield* a.contents, { "notes.md": "v1" });
      assert.isUndefined((yield* a.history).files["huge.md"]);
    }),
  ),
);

it.effect("keeps scopes separate per machine", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const a = yield* machine(alpha, "Alpha").pipe(Scope.provide(scope));
    const b = yield* machine(beta, "Beta").pipe(Scope.provide(scope));
    yield* a.write("notes.md", "only alpha");
    assert.deepStrictEqual(yield* b.contents, {});
    yield* Scope.close(scope, Exit.void);
  }),
);
