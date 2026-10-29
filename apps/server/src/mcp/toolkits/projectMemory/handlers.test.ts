import { expect, it } from "@effect/vitest";
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
import * as Workspace from "../../../project/ProjectWorkspaceService.ts";
import * as Projects from "../../../orchestration-v2/ProjectStore.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Persistence from "../../../persistence/Sqlite.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { ProjectMemoryToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";

it("pages a large memory list and caps one page", () => {
  const files = Array.from({ length: 1_500 }, (_, i) => ({
    name: `topic_${String(i).padStart(4, "0")}.md`,
    revision: 1,
    updatedAt: "2026-10-09T00:00:00.000Z",
    byteLength: 10,
  }));
  const memory = { files, totalBytes: 15_000 };
  const first = Handlers.memoryListPage(memory, {});
  expect(first.files).toHaveLength(Handlers.MEMORY_LIST_PAGE);
  expect(first).toMatchObject({ totalFiles: 1_500, totalBytes: 15_000 });
  expect(Handlers.memoryListPage(memory, { limit: 99_999 }).files).toHaveLength(
    Handlers.MEMORY_LIST_MAX_PAGE,
  );
  expect(Handlers.memoryListPage(memory, { offset: 1_499 }).files.map((f) => f.name)).toEqual([
    "topic_1499.md",
  ]);
  expect(Handlers.memoryListPage(memory, { offset: 5_000 }).files).toEqual([]);
  expect(Handlers.memoryListPage(memory, { query: " TOPIC_00 " }).totalFiles).toBe(100);
});

it("refuses run receipts as new memory files and keeps lasting notes", () => {
  expect(
    Handlers.runRecordRefusal("home-disk-two-released-retirements-20261028.md", "x"),
  ).toContain("carries a date");
  expect(Handlers.runRecordRefusal("m4-retirement-2026-10-28.md", "x")).toContain("carries a date");
  expect(Handlers.runRecordRefusal("release_receipt_20261027.md", "x")).toContain("carries a date");
  expect(Handlers.runRecordRefusal("project_cleanup_2026_10_28.md", "x")).toContain(
    "carries a date",
  );
  expect(Handlers.runRecordRefusal("notes.2026.10.28.md", "x")).toContain("carries a date");
  // The same path repeated, or a URL path, is not a pile of receipts.
  const repeated = Array.from({ length: 5 }, () => "/Users/anton/repo").join(" and ");
  expect(Handlers.runRecordRefusal("project_layout.md", repeated)).toBeUndefined();
  const urls = [1, 2, 3, 4].map((i) => `https://example.com/home/${i}`).join(" ");
  expect(Handlers.runRecordRefusal("reference_links.md", urls)).toBeUndefined();
  const receipt = [1, 2, 3, 4]
    .map((i) => `/Users/anton/.specwithcode/m4/evidence/run-${i}/receipt.json`)
    .join(" and ");
  expect(Handlers.runRecordRefusal("project_disk_cleanup.md", receipt)).toContain("run receipt");
  expect(Handlers.runRecordRefusal("MEMORY.md", receipt)).toBeUndefined();
  expect(
    Handlers.runRecordRefusal(
      "decision_release_policy.md",
      "Releases go through scripts/release/release.sh; the runbook is ~/notes/release.md.",
    ),
  ).toBeUndefined();
  // A version or issue number is not a date.
  expect(Handlers.runRecordRefusal("project_studio_1_0_110.md", "x")).toBeUndefined();
  expect(Handlers.runRecordRefusal("reference_issue_20261.md", "x")).toBeUndefined();
});

const caller = liveThreadShell(ThreadId.make("memory-worker"));
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
const dependencies = Layer.mergeAll(
  Workspace.layer.pipe(Layer.provideMerge(Projects.layer)),
  Layer.mock(Threads.ThreadManagementService)({ getThreadShell: () => Effect.succeed(caller) }),
  Layer.succeed(Context.McpInvocationContext, scope),
).pipe(Layer.provideMerge(Persistence.layerMemory));
const layer = Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(dependencies));
it.effect(
  "reads and writes scoped memory through registered tools with CAS and cross-project denial",
  () =>
    Effect.gen(function* () {
      const projects = yield* Projects.ProjectStoreV2;
      const now = "2026-10-09T00:00:00.000Z";
      yield* projects.apply({
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
          title: "Memory",
          workspaceRoot: "/tmp/memory",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const toolkit = yield* ProjectMemoryToolkit;
      const write = (content: string, expectedRevision: number | null) =>
        toolkit
          .handle("studio_project_memory_write", { name: "MEMORY.md", content, expectedRevision })
          .pipe(Stream.unwrap, Stream.runCollect);
      // Agents creating a file leave the revision out or send 0; both create it.
      const created = yield* toolkit
        .handle("studio_project_memory_write", { name: "rounding.md", content: "two decimals" })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(created.at(-1)?.result).toMatchObject({ name: "rounding.md", revision: 1 });
      const zero = yield* toolkit
        .handle("studio_project_memory_write", {
          name: "owners.md",
          content: "tip.py: Codex worker",
          expectedRevision: 0,
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(zero.at(-1)?.result).toMatchObject({ name: "owners.md", revision: 1 });
      expect((yield* write("first", null)).at(-1)?.result).toMatchObject({
        revision: 1,
        content: "first",
      });
      expect((yield* write("stale", null)).at(-1)?.result).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "invalid_request",
        message: expect.stringContaining("expectedRevision 1"),
      });
      expect((yield* write("second", 1)).at(-1)?.result).toMatchObject({
        revision: 2,
        content: "second",
      });
      const dated = yield* toolkit
        .handle("studio_project_memory_write", {
          name: "retirement-progress-20261028.md",
          content: "30 bindings open",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(dated.at(-1)?.result).toMatchObject({
        _tag: "OrchestratorMcpFailure",
        code: "invalid_request",
        message: expect.stringContaining("carries a date"),
      });
      const read = yield* toolkit
        .handle("studio_project_memory_read", { name: "MEMORY.md" })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(read.at(-1)?.result).toMatchObject({ revision: 2, content: "second" });
      const list = (input: { query?: string; limit?: number; offset?: number } = {}) =>
        toolkit.handle("studio_project_memory_list", input).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );
      expect(yield* list()).toMatchObject({
        totalFiles: 3,
        files: [{ name: "MEMORY.md" }, { name: "owners.md" }, { name: "rounding.md" }],
      });
      // A big memory is searched and paged, not dumped into the agent's context.
      expect(yield* list({ query: "OWN" })).toMatchObject({
        totalFiles: 1,
        files: [{ name: "owners.md", revision: 1 }],
      });
      const page = yield* list({ limit: 1, offset: 1 });
      expect(page).toMatchObject({ totalFiles: 3, files: [{ name: "owners.md" }] });
      expect((page as unknown as { files: unknown[] }).files).toHaveLength(1);
      expect(yield* list({ query: "nothing-like-this" })).toMatchObject({
        totalFiles: 0,
        files: [],
      });
      const foreign = yield* toolkit
        .handle("studio_project_memory_read", {
          projectId: ProjectId.make("foreign"),
          name: "MEMORY.md",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(foreign.at(-1)?.result).toMatchObject({ code: "capability_denied" });
    }).pipe(Effect.provide(layer)),
);
it.effect("read-only external clients cannot write project memory", () =>
  Effect.gen(function* () {
    const toolkit = yield* ProjectMemoryToolkit;
    const result = yield* toolkit
      .handle("studio_project_memory_write", {
        projectId: caller.projectId,
        name: "MEMORY.md",
        content: "deny",
        expectedRevision: null,
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provideService(Context.McpInvocationContext, {
      ...scope,
      thread: undefined,
      client: { sessionId: "readonly", label: "Fixture", access: "read-only" },
    }),
    Effect.provide(layer),
  ),
);
