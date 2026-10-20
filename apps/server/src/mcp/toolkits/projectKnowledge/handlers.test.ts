// @effect-diagnostics nodeBuiltinImport:off -- The fixture project folder is laid out with node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../../config.ts";
import * as Projects from "../../../orchestration-v2/ProjectStore.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as EventStore from "../../../persistence/OrchestrationEventStore.ts";
import * as Persistence from "../../../persistence/Sqlite.ts";
import * as ProjectKnowledge from "../../../project/knowledge/ProjectKnowledge.ts";
import * as Workspace from "../../../project/ProjectWorkspaceService.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { ProjectKnowledgeToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "knowledge-mcp-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));
NodeFS.mkdirSync(NodePath.join(root, ".specweave/docs"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(root, ".specweave/docs/storage.md"),
  "# Storage\n\nThe index lives in one SQLite file per project, named by a hash.\n",
);

const caller = liveThreadShell(ThreadId.make("knowledge-worker"));
const scope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  thread: {
    threadId: caller.id,
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
};
const dependencies = (invocation: Context.McpInvocationScope) =>
  Layer.mergeAll(
    Workspace.layer.pipe(
      Layer.provideMerge(ProjectKnowledge.layer),
      Layer.provideMerge(Layer.merge(Projects.layer, EventStore.layer)),
    ),
    Layer.mock(Threads.ThreadManagementService)({ getThreadShell: () => Effect.succeed(caller) }),
    Layer.succeed(Context.McpInvocationContext, invocation),
  ).pipe(
    Layer.provideMerge(Persistence.layerMemory),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "knowledge-mcp-state-" })),
    Layer.provide(NodeServices.layer),
  );
const layerFor = (invocation: Context.McpInvocationScope) =>
  Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(dependencies(invocation)));

it.effect("searches and reads the calling thread's project knowledge, and nothing else", () =>
  Effect.gen(function* () {
    const now = "2026-10-20T00:00:00.000Z";
    yield* (yield* Projects.ProjectStoreV2).apply({
      sequence: 1,
      eventId: EventId.make("project"),
      aggregateKind: "project",
      aggregateId: caller.projectId,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: caller.projectId,
        title: "Knowledge",
        workspaceRoot: root,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
    const toolkit = yield* ProjectKnowledgeToolkit;
    const call = <Name extends "studio_project_knowledge_search" | "studio_project_knowledge_read">(
      name: Name,
      input: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit.handle(name, input).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((parts) => parts.at(-1)?.result),
      );
    const found = (yield* call("studio_project_knowledge_search", {
      query: "where does the index live",
    })) as unknown as { results: Array<{ documentId: string; excerpt: string }> };
    expect(found.results[0]?.excerpt).toContain("one SQLite file per project");
    expect(
      yield* call("studio_project_knowledge_read", { documentId: found.results[0]!.documentId }),
    ).toMatchObject({ title: "Storage", location: ".specweave/docs/storage.md", nextOffset: null });
    expect(
      yield* call("studio_project_knowledge_read", { documentId: "file:../outside.md" }),
    ).toMatchObject({ code: "invalid_request" });
    expect(
      yield* call("studio_project_knowledge_search", {
        projectId: ProjectId.make("foreign"),
        query: "index",
      }),
    ).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("refuses an MCP client outside a thread, even one that names the project", () =>
  Effect.gen(function* () {
    const toolkit = yield* ProjectKnowledgeToolkit;
    const result = yield* toolkit
      .handle("studio_project_knowledge_search", { projectId: caller.projectId, query: "index" })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((parts) => parts.at(-1)?.result),
      );
    expect(result).toMatchObject({ code: "thread_credential_required" });
  }).pipe(Effect.provide(layerFor({ ...scope, thread: undefined }))),
);
