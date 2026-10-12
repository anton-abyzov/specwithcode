import { assert, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EventId,
  ProjectId,
  ThreadId,
  PROJECT_CONTEXT_CHARACTER_LIMIT,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";
import * as Delivery from "./ProjectContextDelivery.ts";
import { projectContextDelta, projectContextSnapshot } from "./ProjectContextSnapshot.ts";

const storage = ProjectStore.layer.pipe(Layer.provideMerge(Persistence.layerMemory));
const workspace = Workspace.layer.pipe(Layer.provideMerge(storage));
const layer = Delivery.layer.pipe(Layer.provideMerge(workspace));
const identity = (id: string, runId = "run-1"): Delivery.ProjectContextIdentity => ({
  projectId: ProjectId.make(id),
  threadId: ThreadId.make(`thread-${id}`),
  driver: "claude",
  providerInstanceId: "claude-a",
  providerThreadId: `provider-${id}`,
  nativeThreadId: `native-${id}`,
  runId,
});
const seed = (id: string) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make(id);
    yield* (yield* ProjectStore.ProjectStoreV2).apply({
      sequence: 1,
      eventId: EventId.make(`create-${id}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-10-09T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: id,
        workspaceRoot: `/tmp/${id}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: "2026-10-09T00:00:00.000Z",
      },
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, goal: "Ship a useful project", instructions: "Preserve user files" })} WHERE project_id=${projectId}`;
    return identity(id);
  });
const compact = (
  input: Delivery.ProjectContextIdentity,
  ordinal: number,
  status = "completed",
  nativeId = input.nativeThreadId,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const run = `compact-${input.threadId}-${ordinal}`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,payload_json) VALUES(${run},${input.threadId},${ordinal},'claude',${input.providerThreadId},'completed','now','{}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,provider_instance_id,status,payload_json) VALUES(${run},${input.threadId},${run},1,${run},'claude',${input.providerThreadId},${input.providerInstanceId},'completed',${JSON.stringify({ nativeThreadId: nativeId })})`;
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,provider_thread_id,ordinal,type,status,updated_at,payload_json) VALUES(${run},${input.threadId},${run},${input.providerThreadId},${ordinal},'compaction',${status},'now','{}')`;
  });

it.layer(layer)("Project context durable delivery", (it) => {
  it.effect.each(["{broken", '[{"name":"goal","value":"stale"}]'])(
    "restores full context from a corrupt accepted receipt without acknowledging it early: %s",
    (corrupt) =>
      Effect.gen(function* () {
        const input = yield* seed(`corrupt-${corrupt.length}`);
        const service = yield* Delivery.ProjectContextDelivery;
        const sql = yield* SqlClient.SqlClient;
        yield* (yield* Workspace.ProjectWorkspaceService).writeMemory({
          projectId: input.projectId,
          name: "MEMORY.md",
          content: "Keep the project decision",
          expectedRevision: null,
        });
        yield* (yield* service.prepare(input)).accepted;
        yield* sql`UPDATE project_context_deliveries SET accepted_json=${corrupt} WHERE project_id=${input.projectId}`;
        const restored = yield* Effect.gen(function* () {
          return yield* (yield* Delivery.ProjectContextDelivery).prepare({
            ...input,
            runId: "recovery",
          });
        }).pipe(Effect.provide(Layer.fresh(Delivery.layer)));
        for (const text of [
          "current snapshot",
          "Ship a useful project",
          "Preserve user files",
          "Keep the project decision",
        ])
          assert.include(restored.text, text);
        const rows = () => sql<{
          accepted_json: string;
          pending_run_id: string | null;
          pending_json: string | null;
        }>`
        SELECT accepted_json,pending_run_id,pending_json FROM project_context_deliveries WHERE project_id=${input.projectId}`;
        const pending = (yield* rows())[0]!;
        assert.equal(pending.accepted_json, corrupt);
        assert.equal(pending.pending_run_id, "recovery");
        assert.isArray(JSON.parse(pending.pending_json!));
        yield* restored.accepted;
        const accepted = (yield* rows())[0]!;
        assert.equal(accepted.accepted_json, pending.pending_json);
        assert.isNull(accepted.pending_run_id);
        assert.isNull(accepted.pending_json);
        assert.equal((yield* service.prepare({ ...input, runId: "after-recovery" })).text, "");
      }),
  );
  it.effect(
    "omits unchanged sections after acceptance and reloads receipts in a fresh service instance",
    () =>
      Effect.gen(function* () {
        const input = yield* seed("unchanged");
        const service = yield* Delivery.ProjectContextDelivery;
        const first = yield* service.prepare(input);
        assert.include(first.text, "Ship a useful project");
        yield* first.accepted;
        // Rebuild the service against the same persisted database, without its previous closure.
        const second = yield* Effect.gen(function* () {
          return yield* (yield* Delivery.ProjectContextDelivery).prepare({
            ...input,
            runId: "run-2",
          });
        }).pipe(Effect.provide(Delivery.layer));
        assert.equal(second.text, "");
        yield* second.accepted;
      }),
  );
  it.effect(
    "sends only edited memory sections and explicit removal after deleting and recreating the index",
    () =>
      Effect.gen(function* () {
        const input = yield* seed("edits");
        const service = yield* Delivery.ProjectContextDelivery;
        const memory = yield* Workspace.ProjectWorkspaceService;
        yield* (yield* service.prepare(input)).accepted;
        yield* memory.writeMemory({
          projectId: input.projectId,
          name: "MEMORY.md",
          content: "Decision A",
          expectedRevision: null,
        });
        const edit = yield* service.prepare({ ...input, runId: "edit" });
        assert.include(edit.text, "Decision A");
        assert.notInclude(edit.text, "Ship a useful project");
        assert.notInclude(edit.text, "Preserve user files");
        yield* edit.accepted;
        yield* memory.deleteMemory({
          projectId: input.projectId,
          name: "MEMORY.md",
          expectedRevision: 1,
        });
        const removal = yield* service.prepare({ ...input, runId: "delete" });
        assert.include(removal.text, "[memory_index]\n(empty; previous content removed)");
        yield* removal.accepted;
        yield* memory.writeMemory({
          projectId: input.projectId,
          name: "MEMORY.md",
          content: "Decision A",
          expectedRevision: null,
        });
        const recreated = yield* service.prepare({ ...input, runId: "recreate" });
        assert.include(recreated.text, "revision 2");
        assert.include(recreated.text, "Decision A");
      }),
  );
  it.effect(
    "retains immutable pending snapshots but restores current context on the next real prompt after ambiguous acceptance",
    () =>
      Effect.gen(function* () {
        const input = yield* seed("crash");
        const service = yield* Delivery.ProjectContextDelivery;
        const memory = yield* Workspace.ProjectWorkspaceService;
        const beforeCrash = yield* service.prepare(input);
        yield* memory.writeMemory({
          projectId: input.projectId,
          name: "MEMORY.md",
          content: "New evidence",
          expectedRevision: null,
        });
        assert.equal((yield* service.prepare(input)).text, beforeCrash.text);
        const newPrompt = yield* service.prepare({ ...input, runId: "new-user-message" });
        assert.include(newPrompt.text, "New evidence");
        assert.include(newPrompt.text, "current snapshot");
        yield* beforeCrash.accepted; // A late acknowledgement cannot acknowledge the newer run.
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql<{
            pending_run_id: string;
          }>`SELECT pending_run_id FROM project_context_deliveries WHERE project_id=${input.projectId}`)[0]
            ?.pending_run_id,
          "new-user-message",
        );
        yield* newPrompt.accepted;
        assert.equal((yield* service.prepare({ ...input, runId: "third" })).text, "");
      }),
  );
  it.effect(
    "isolates provider accounts, native continuations and projects; returning to retained native history reuses its receipt",
    () =>
      Effect.gen(function* () {
        const input = yield* seed("mixed");
        const service = yield* Delivery.ProjectContextDelivery;
        yield* (yield* service.prepare(input)).accepted;
        for (const change of [
          { driver: "codex", providerInstanceId: "codex-a" },
          { providerInstanceId: "claude-b" },
          { nativeThreadId: "fork" },
        ]) {
          assert.include(
            (yield* service.prepare({ ...input, ...change, runId: JSON.stringify(change) })).text,
            "current snapshot",
          );
        }
        assert.equal(
          (yield* service.prepare({
            ...input,
            providerThreadId: "new-runtime-handle",
            runId: "return",
          })).text,
          "",
        );
        const other = yield* seed("mixed-other");
        assert.include((yield* service.prepare(other)).text, "current snapshot");
        const unknown = { ...input, nativeThreadId: null, runId: "unknown-1" };
        yield* (yield* service.prepare(unknown)).accepted;
        assert.include(
          (yield* service.prepare({ ...unknown, runId: "unknown-2" })).text,
          "current snapshot",
        );
      }),
  );
  it.effect(
    "restores after completed native compaction, ignoring failed and foreign compactions",
    () =>
      Effect.gen(function* () {
        const input = yield* seed("compact");
        const service = yield* Delivery.ProjectContextDelivery;
        yield* (yield* service.prepare(input)).accepted;
        yield* compact(input, 1, "failed");
        yield* compact(input, 2, "completed", "foreign-native");
        const unchanged = yield* service.prepare({ ...input, runId: "unchanged" });
        assert.equal(unchanged.text, "");
        yield* unchanged.accepted;
        yield* compact(input, 3);
        const restored = yield* service.prepare({
          ...input,
          providerThreadId: "new-handle-for-same-native",
          runId: "after-compaction",
        });
        assert.include(restored.text, "current snapshot");
        yield* restored.accepted;
        assert.equal((yield* service.prepare({ ...input, runId: "after-restore" })).text, "");
      }),
  );
  it.effect(
    "fresh compaction restoration sees edits while paused, and deletion prevents stale acknowledgements or restoration",
    () =>
      Effect.gen(function* () {
        const input = yield* seed("purge-context");
        const other = yield* seed("purge-other");
        const service = yield* Delivery.ProjectContextDelivery;
        const sql = yield* SqlClient.SqlClient;
        const pending = yield* service.prepare(input);
        yield* (yield* service.prepare(other)).accepted;
        yield* (yield* Workspace.ProjectWorkspaceService).writeMemory({
          projectId: input.projectId,
          name: "MEMORY.md",
          content: "Latest memory",
          expectedRevision: null,
        });
        yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, paused: true, archived: true })} WHERE project_id=${input.projectId}`;
        assert.include(yield* service.restore(input.projectId, input.threadId), "Latest memory");
        yield* (yield* ProjectStore.ProjectStoreV2).apply({
          sequence: 2,
          eventId: EventId.make("purge-context"),
          aggregateKind: "project",
          aggregateId: input.projectId,
          occurredAt: "now",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: { projectId: input.projectId, deletedAt: "now" },
        });
        yield* pending.accepted;
        assert.deepEqual(
          yield* sql`SELECT * FROM project_context_deliveries WHERE project_id=${input.projectId}`,
          [],
        );
        assert.equal(
          (yield* sql`SELECT * FROM project_context_deliveries WHERE project_id=${other.projectId}`)
            .length,
          1,
        );
        assert.equal(
          (yield* service.restore(input.projectId, input.threadId).pipe(Effect.flip)).code,
          "not_found",
        );
      }),
  );
  it.effect("detects edits beyond the bounded file inventory", () =>
    Effect.gen(function* () {
      const input = yield* seed("inventory");
      const service = yield* Delivery.ProjectContextDelivery;
      const memory = yield* Workspace.ProjectWorkspaceService;
      for (let n = 0; n < 25; n++)
        yield* memory.writeMemory({
          projectId: input.projectId,
          name: `${String(n).padStart(2, "0")}-${"a".repeat(95)}.md`,
          content: "x",
          expectedRevision: null,
        });
      yield* (yield* service.prepare(input)).accepted;
      yield* memory.writeMemory({
        projectId: input.projectId,
        name: `24-${"a".repeat(95)}.md`,
        content: "changed",
        expectedRevision: 1,
      });
      assert.include(
        (yield* service.prepare({ ...input, runId: "late-edit" })).text,
        "[memory_inventory]",
      );
    }),
  );
});

it("bounds snapshots and Unicode without silently retaining removed sections", () => {
  const snapshot = projectContextSnapshot([
    ["goal", "g".repeat(8000)],
    ["instructions", "i".repeat(16000)],
    ["memory_index", "😀".repeat(32000)],
  ]);
  const text = projectContextDelta("bounded", snapshot, null);
  assert.isAtMost(text.length, PROJECT_CONTEXT_CHARACTER_LIMIT);
  assert.isFalse(/[\uD800-\uDBFF]$/.test(snapshot.at(-1)!.value));
  assert.include(projectContextDelta("bounded", [], snapshot), "previous content removed");
});
