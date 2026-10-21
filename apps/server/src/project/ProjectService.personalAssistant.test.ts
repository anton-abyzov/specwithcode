import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const layerTest = RuntimeLayer.layerProjectService.pipe(
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
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "personal-assistant-test-" })),
  Layer.provide(NodeServices.layer),
);

// A fictional household machine: no real person, account or folder.
const createAssistant = (service: ProjectService.ProjectService["Service"], name: string) =>
  service.create({
    commandId: CommandId.make(`assistant:${name}`),
    projectId: ProjectId.make(`project:${name}`),
    title: "Aide",
    kind: "personal",
    workspaceRoot: `/fixtures/example-household/${name}`,
  });

const revisionOf = (project: {
  readonly workspaceSettings?: { readonly revision: number } | null | undefined;
}) => project.workspaceSettings?.revision ?? 0;

const reasonOf = (error: unknown) =>
  (error as { _tag?: string })._tag === "ProjectRequestDeniedError"
    ? (error as ProjectService.ProjectRequestDeniedError).reason
    : (error as { _tag?: string })._tag;

it.effect("refuses a second assistant from any create path, archived or not", () =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    const first = yield* createAssistant(service, "aide");
    const refused = yield* createAssistant(service, "aide-again").pipe(Effect.flip);
    assert.equal(reasonOf(refused), "assistant_exists");
    assert.include((refused as Error).message, "already has its personal assistant");
    // A retried command replays its refusal; it never creates later.
    assert.equal(
      reasonOf(yield* createAssistant(service, "aide-again").pipe(Effect.flip)),
      "assistant_exists",
    );

    // An archived assistant is still this machine's assistant.
    yield* service.update({
      commandId: CommandId.make("assistant:archive"),
      projectId: first.id,
      workspaceSettings: { archived: true, expectedRevision: revisionOf(first) },
    });
    assert.equal(
      reasonOf(yield* createAssistant(service, "aide-after-archive").pipe(Effect.flip)),
      "assistant_exists",
    );

    // Code projects are not affected.
    const code = yield* service.create({
      commandId: CommandId.make("code:atlas"),
      projectId: ProjectId.make("project:atlas"),
      title: "Atlas",
      workspaceRoot: "/fixtures/example-studio/atlas",
    });
    assert.equal(code.workspaceSettings?.kind ?? "code", "code");

    // Once the assistant is deleted the machine may have a new one.
    yield* service.delete({ commandId: CommandId.make("assistant:delete"), projectId: first.id });
    const next = yield* createAssistant(service, "aide-new");
    assert.equal(next.workspaceSettings?.kind, "personal");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lets only one of two concurrent creates make the assistant", () =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    const results = yield* Effect.all(
      ["left", "right", "third"].map((name) =>
        createAssistant(service, `race-${name}`).pipe(Effect.result),
      ),
      { concurrency: "unbounded" },
    );
    const created = results.filter((result) => result._tag === "Success");
    assert.equal(created.length, 1);
    for (const result of results)
      if (result._tag === "Failure") assert.equal(reasonOf(result.failure), "assistant_exists");
    const assistants = (yield* service.snapshot).projects.filter(
      (project) => project.workspaceSettings?.kind === "personal",
    );
    assert.equal(assistants.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("never changes a project's kind after creation", () =>
  Effect.gen(function* () {
    const service = yield* ProjectService.ProjectService;
    const assistant = yield* createAssistant(service, "kind-fixed");
    const toCode = yield* service
      .update({
        commandId: CommandId.make("kind:to-code"),
        projectId: assistant.id,
        workspaceSettings: { kind: "code", expectedRevision: revisionOf(assistant) },
      })
      .pipe(Effect.flip);
    assert.equal(reasonOf(toCode), "kind_fixed");
    const code = yield* service.create({
      commandId: CommandId.make("kind:code"),
      projectId: ProjectId.make("project:kind-code"),
      title: "Ledger",
      workspaceRoot: "/fixtures/example-studio/ledger",
    });
    const toPersonal = yield* service
      .update({
        commandId: CommandId.make("kind:to-personal"),
        projectId: code.id,
        workspaceSettings: { kind: "personal", expectedRevision: revisionOf(code) },
      })
      .pipe(Effect.flip);
    assert.equal(reasonOf(toPersonal), "kind_fixed");
    // Saving the same kind again is fine.
    yield* service.update({
      commandId: CommandId.make("kind:same"),
      projectId: assistant.id,
      workspaceSettings: {
        kind: "personal",
        goal: "Keep the household's paperwork in order",
        expectedRevision: revisionOf(assistant),
      },
    });
    const saved = Option.getOrThrow(yield* service.getById(assistant.id));
    assert.equal(saved.workspaceSettings?.kind, "personal");
  }).pipe(Effect.provide(layerTest)),
);
