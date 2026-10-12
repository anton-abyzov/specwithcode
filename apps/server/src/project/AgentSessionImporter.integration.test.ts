import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProviderRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Importer from "./AgentSessionImporter.ts";
import * as Scanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";
import { projectFixture } from "./ProjectWorkspace.testkit.ts";

const projectId = ProjectId.make("project:import-integration");
const foreignId = ProjectId.make("project:foreign-integration");
const codexId = "synthetic-codex-session";
const claudeId = "01234567-89ab-4cde-8fab-0123456789ab";
const importedId = ThreadId.make(`import:codex:${codexId}`);
const now = Date.parse("2026-10-09T12:00:00.000Z");
const at = new Date(now - 2000).toISOString();
const jsonl = (records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const codexTranscript = (cwd: string) =>
  jsonl([
    { type: "session_meta", timestamp: at, payload: { id: codexId, cwd } },
    { type: "turn_context", timestamp: at, payload: { model: "gpt-6.1-sol" } },
    {
      type: "event_msg",
      timestamp: at,
      payload: { type: "user_message", message: "Repair the synthetic project" },
    },
    {
      type: "response_item",
      timestamp: at,
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Synthetic repair complete" }],
      },
    },
  ]);
const claudeTranscript = (cwd: string, sessionId = claudeId) =>
  jsonl([
    {
      type: "user",
      timestamp: at,
      cwd,
      sessionId,
      message: { role: "user", content: "Review the synthetic change" },
    },
    {
      type: "assistant",
      timestamp: at,
      message: {
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [{ type: "text", text: "Synthetic review complete" }],
      },
    },
  ]);

type Fixture = {
  root: string;
  workspace: string;
  codexFile: string;
  duplicateFile: string;
  claudeFile: string;
};
type Services =
  | Importer.AgentSessionImporter
  | ProjectionStore.ProjectionStoreV2
  | ProviderRuntime.ProviderSessionRuntimeRepository
  | EventSink.EventSinkV2
  | SqlClient.SqlClient
  | FileSystem.FileSystem;

/** Only facade getters are replaced, and both read the actual SQLite stores.
 * Scanner, importer, event transactions, projections and resume metadata are real.
 * No orchestrator workers or native providers are constructed.
 */
const facades = Layer.unwrap(
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          projects.get(id).pipe(
            Effect.map(
              Option.map((row) =>
                projectFixture(id, { workspaceRoot: row.workspaceRoot, title: row.title }),
              ),
            ),
            Effect.mapError(
              (cause) =>
                new ProjectService.ProjectOperationError({
                  operation: "read-project",
                  projectId: id,
                  cause,
                }),
            ),
          ),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: (id, fields, filter) =>
          projections
            .getThreadRecords(id, fields, filter)
            .pipe(
              Effect.mapError(
                (cause) => new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
              ),
            ),
      }),
    );
  }),
);

const withFixture = <A, E>(test: (fixture: Fixture) => Effect.Effect<A, E, Services>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-import-integration-" });
      const workspace = `${root}/workspace`;
      const fixture = {
        root,
        workspace,
        codexFile: `${root}/codex/sessions/2026/10/09/rollout-one.jsonl`,
        duplicateFile: `${root}/codex/sessions/2026/10/09/rollout-two.jsonl`,
        claudeFile: `${root}/claude/projects/synthetic/${claudeId}.jsonl`,
      };
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* TestClock.setTime(now);
      const stores = Layer.mergeAll(
        RuntimeLayer.layerEventSink,
        ProjectStore.layer,
        ProjectionStore.layer,
        ProviderRuntime.layer,
        IdAllocator.layer,
      );
      const layer = Importer.layer.pipe(
        Layer.provideMerge(Scanner.layer),
        Layer.provideMerge(facades),
        Layer.provideMerge(stores),
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provide(ServerConfig.layerTest(workspace, `${root}/studio-state`)),
        Layer.provide(
          Settings.layerTest({
            providers: {
              codex: { homePath: `${root}/codex` },
              claudeAgent: { homePath: `${root}/claude` },
            },
          }),
        ),
        Layer.provide(Layer.succeed(HostProcessEnvironment, {})),
      );
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_projects
      (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at,deleted_at)
      VALUES (${projectId},'Synthetic import',${workspace},NULL,'[]',${at},${at},NULL),
             (${foreignId},'Foreign project',${root + "/foreign"},NULL,'[]',${at},${at},NULL)`;
        return yield* test(fixture);
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const write = Effect.fn(function* (path: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  yield* fs.writeFileString(path, contents);
  yield* fs.utimes(path, (now - 1000) / 1000, (now - 1000) / 1000);
});
const eventCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{
    count: number;
  }>`SELECT COUNT(*) AS count FROM orchestration_events WHERE aggregate_kind = 'thread'`)[0]!.count;
});

it.effect(
  "imports real Codex and Claude files once, recording duplicate file identity and native resume bindings",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* write(f.codexFile, codexTranscript(f.workspace));
        yield* write(f.duplicateFile, codexTranscript(f.workspace));
        yield* write(f.claudeFile, claudeTranscript(f.workspace));
        const importer = yield* Importer.AgentSessionImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const runtimes = yield* ProviderRuntime.ProviderSessionRuntimeRepository;
        expect(
          yield* importer.importRecentAgentThreads({
            projectId,
            expectedWorkspaceRoot: f.workspace,
          }),
        ).toEqual({ importedCount: 2, skippedCount: 0 });
        const projection = yield* projections.getThreadProjection(importedId);
        expect(projection.thread).toMatchObject({
          projectId,
          historyOrigin: "v1_import",
          title: "Repair the synthetic project",
        });
        expect(projection.messages.map((message) => [message.role, message.text])).toEqual([
          ["user", "Repair the synthetic project"],
          ["assistant", "Synthetic repair complete"],
        ]);
        expect(projection.turnItems.map((item) => [item.type, item.ordinal])).toEqual([
          ["user_message", 1],
          ["assistant_message", 2],
        ]);
        expect(projection.providerThreads[0]).toMatchObject({
          status: "idle",
          nativeThreadRef: { driver: "codex", nativeId: codexId, strength: "strong" },
        });
        expect(projection.runs).toHaveLength(0);
        const rows = yield* runtimes.list();
        expect(rows).toHaveLength(2);
        const codex = rows.find((row) => row.threadId === importedId)!;
        expect(codex).toMatchObject({
          status: "stopped",
          providerInstanceId: "codex",
          resumeCursor: { threadId: codexId },
          runtimePayload: { cwd: f.workspace },
        });
        expect(
          (codex.runtimePayload as { importedTranscripts: unknown[] }).importedTranscripts,
        ).toHaveLength(2);
        expect(rows.find((row) => row.providerName === "claudeAgent")).toMatchObject({
          status: "stopped",
          resumeCursor: { resume: claudeId },
        });
        expect(yield* eventCount).toBe(12);
        expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
          importedCount: 2,
          skippedCount: 0,
        });
        expect(yield* eventCount).toBe(12);
        expect((yield* projections.getThreadProjection(importedId)).messages).toEqual(
          projection.messages,
        );
      }),
    ),
);

it.effect(
  "revisits a changed source file without duplicating or rewriting already imported messages",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        const importer = yield* Importer.AgentSessionImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const runtimes = yield* ProviderRuntime.ProviderSessionRuntimeRepository;
        yield* write(f.codexFile, codexTranscript(f.workspace));
        yield* importer.importRecentAgentThreads({ projectId });
        const before = yield* projections.getThreadProjection(importedId);
        const changed =
          codexTranscript(f.workspace) +
          jsonl([
            {
              type: "response_item",
              timestamp: at,
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Later native text" }],
              },
            },
          ]);
        yield* write(f.codexFile, changed);
        expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
          importedCount: 1,
          skippedCount: 0,
        });
        expect(yield* eventCount).toBe(6);
        expect((yield* projections.getThreadProjection(importedId)).messages).toEqual(
          before.messages,
        );
        const runtime = Option.getOrThrow(yield* runtimes.getByThreadId({ threadId: importedId }));
        const sources = (
          runtime.runtimePayload as {
            importedTranscripts: Array<{ size: number; filePath: string }>;
          }
        ).importedTranscripts;
        expect(sources).toHaveLength(1);
        expect(sources[0]).toMatchObject({
          size: Buffer.byteLength(changed),
          filePath: f.codexFile,
        });
      }),
    ),
);

it.effect("rejects deleted or moved project intent before importing any real file", () =>
  withFixture((f) =>
    Effect.gen(function* () {
      yield* write(f.codexFile, codexTranscript(f.workspace));
      const importer = yield* Importer.AgentSessionImporter;
      const changed = yield* importer
        .importRecentAgentThreads({ projectId, expectedWorkspaceRoot: `${f.root}/old-workspace` })
        .pipe(Effect.flip);
      expect(changed._tag).toBe("AgentSessionImportProjectChangedError");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id=${projectId}`;
      const deleted = yield* importer.importRecentAgentThreads({ projectId }).pipe(Effect.flip);
      expect(deleted._tag).toBe("AgentSessionImportProjectNotFoundError");
      expect(yield* eventCount).toBe(0);
      expect(yield* (yield* ProviderRuntime.ProviderSessionRuntimeRepository).list()).toEqual([]);
    }),
  ),
);

const preservesExisting = (mode: "foreign-project" | "modified-thread") =>
  withFixture((f) =>
    Effect.gen(function* () {
      yield* write(f.codexFile, codexTranscript(f.workspace));
      const importer = yield* Importer.AgentSessionImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      yield* importer.importRecentAgentThreads({ projectId });
      const before = yield* projections.getThreadProjection(importedId);
      const changed = {
        ...before.thread,
        ...(mode === "foreign-project"
          ? { projectId: foreignId }
          : { historyOrigin: "native" as const }),
        title: "Preserve this edited thread",
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make(`test:${mode}`),
            type: "thread.metadata-updated",
            threadId: importedId,
            occurredAt: DateTime.makeUnsafe(at),
            payload: changed,
          },
        ],
      });
      // Remove only the scanner receipt to model rediscovery after an older import.
      yield* sql`UPDATE provider_session_runtime SET runtime_payload_json=${JSON.stringify({ cwd: f.workspace })} WHERE thread_id=${importedId}`;
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 0,
        skippedCount: 1,
      });
      const after = yield* projections.getThreadProjection(importedId);
      expect(after.thread).toEqual(changed);
      expect(after.messages).toEqual(before.messages);
      expect(yield* eventCount).toBe(7);
      const row = Option.getOrThrow(
        yield* (yield* ProviderRuntime.ProviderSessionRuntimeRepository).getByThreadId({
          threadId: importedId,
        }),
      );
      expect(row.runtimePayload).toEqual({ cwd: f.workspace });
    }),
  );
it.effect("preserves a foreign project when its source is presented for import again", () =>
  preservesExisting("foreign-project"),
);
it.effect("preserves a modified thread when its source is presented for import again", () =>
  preservesExisting("modified-thread"),
);

it.effect(
  "skips an unresumable Claude transcript and a file with no visible request without creating threads",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* write(f.claudeFile, claudeTranscript(f.workspace, "not-a-resumable-uuid"));
        yield* write(
          f.codexFile,
          jsonl([
            { type: "session_meta", timestamp: at, payload: { id: codexId, cwd: f.workspace } },
          ]),
        );
        const result = yield* (yield* Importer.AgentSessionImporter).importRecentAgentThreads({
          projectId,
        });
        expect(result).toEqual({ importedCount: 0, skippedCount: 2 });
        expect(yield* eventCount).toBe(0);
        expect(yield* (yield* ProviderRuntime.ProviderSessionRuntimeRepository).list()).toEqual([]);
      }),
    ),
);

it.effect(
  "rolls back failed event projection writes and retries without duplicate events or a false import receipt",
  () =>
    withFixture((f) =>
      Effect.gen(function* () {
        yield* write(f.codexFile, codexTranscript(f.workspace));
        const sql = yield* SqlClient.SqlClient;
        const importer = yield* Importer.AgentSessionImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const runtimes = yield* ProviderRuntime.ProviderSessionRuntimeRepository;
        yield* sql.unsafe(
          "CREATE TRIGGER reject_import_message BEFORE INSERT ON orchestration_v2_projection_messages BEGIN SELECT RAISE(ABORT, 'synthetic projection failure'); END",
        );
        expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
          importedCount: 0,
          skippedCount: 1,
        });
        expect(yield* eventCount).toBe(0);
        expect(
          Option.isNone(yield* projections.getThreadProjection(importedId).pipe(Effect.option)),
        ).toBe(true);
        const interrupted = Option.getOrThrow(
          yield* runtimes.getByThreadId({ threadId: importedId }),
        );
        expect(interrupted.status).toBe("stopped");
        expect(interrupted.runtimePayload).toEqual({ cwd: f.workspace });
        yield* sql.unsafe("DROP TRIGGER reject_import_message");
        expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
          importedCount: 1,
          skippedCount: 0,
        });
        expect(yield* eventCount).toBe(6);
        expect((yield* projections.getThreadProjection(importedId)).messages).toHaveLength(2);
        expect(
          (
            Option.getOrThrow(yield* runtimes.getByThreadId({ threadId: importedId }))
              .runtimePayload as { importedTranscripts: unknown[] }
          ).importedTranscripts,
        ).toHaveLength(1);
      }),
    ),
);
