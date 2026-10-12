import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { fixtureProjectDatabase } from "./ProjectWorkspace.testkit.ts";
const projectId = ProjectId.make("guard-real-project");
const provider = ProviderInstanceId.make("codex");
const adapter = {
  instanceId: provider,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No real provider allowed"),
} as ProviderAdapterV2Shape;
const database = fixtureProjectDatabase([projectId]);
const layer = Harness.layerWithRegistry(
  { name: "project-admission" },
  Registry.layerFromAdapters([adapter]),
  { databaseLayer: database, runEffectWorker: false },
).pipe(Layer.provideMerge(database));
const create = (name: string, id = projectId) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${name}`),
  threadId: ThreadId.make(name),
  projectId: id,
  title: name,
  modelSelection: { instanceId: provider, model: "gpt-5" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
});
it.effect(
  "raw RPC admission rejects absent, paused and deleted projects; child reservation is durable before effects run",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      expect(
        (yield* orchestrator
          .dispatch(create("missing", ProjectId.make("missing")))
          .pipe(Effect.flip))._tag,
      ).toBe("OrchestratorDispatchError");
      const parent = create("parent");
      yield* orchestrator.dispatch(parent);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("parent-prompt"),
        threadId: parent.threadId,
        messageId: MessageId.make("prompt"),
        text: "Work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const projection = yield* orchestrator.getThreadProjection(parent.threadId);
      const run = projection.runs[0]!;
      expect(run.rootNodeId).not.toBeNull();
      const delegated = yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("child"),
        parentThreadId: parent.threadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Child task",
        modelSelection: parent.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
        completionWake: "always",
      });
      const child = delegated.storedEvents.find((entry) => entry.event.type === "thread.created");
      expect(child?.event.type).toBe("thread.created");
      if (child?.event.type !== "thread.created") throw new Error("Missing child reservation");
      expect((yield* orchestrator.getThreadProjection(child.event.threadId)).runs.length).toBe(1);
      yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, paused: true })} WHERE project_id=${projectId}`;
      expect((yield* orchestrator.dispatch(create("paused")).pipe(Effect.flip))._tag).toBe(
        "OrchestratorDispatchError",
      );
      yield* sql`UPDATE projection_projects SET deleted_at='2026-10-09T00:00:00.000Z' WHERE project_id=${projectId}`;
      expect((yield* orchestrator.dispatch(create("after-delete")).pipe(Effect.flip))._tag).toBe(
        "OrchestratorDispatchError",
      );
      const rows = yield* sql<{
        thread_id: string;
      }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE project_id=${projectId}`;
      expect(rows.map((row) => row.thread_id).sort()).toEqual(
        [parent.threadId, child.event.threadId].sort(),
      );
    }).pipe(Effect.provide(layer)),
);
