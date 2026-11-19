/**
 * 0898: limit hits, provider switches and handoffs per instance for one UTC
 * day, read from the projection tables the orchestrator writes.
 */
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { readTeamUsageCounts, utcDayBounds } from "./teamUsageCounts.ts";

const NOW = Date.parse("2026-11-19T15:00:00.000Z");

it("utc day bounds", () => {
  expect(utcDayBounds(NOW)).toEqual({
    start: "2026-11-19T00:00:00.000Z",
    end: "2026-11-20T00:00:00.000Z",
  });
});

it.effect("counts today's limit stops, limit switches and limit handoffs per instance", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const run = (id: string, thread: string, ordinal: number, instance: string, status: string, at: string) =>
      sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
        VALUES (${id}, ${thread}, ${ordinal}, 'claudeAgent', NULL, ${status}, ${at}, ${at},
          ${JSON.stringify({ modelSelection: { instanceId: instance, model: "claude-opus-5-5" } })})`;
    const error = (id: string, runId: string, thread: string, failureClass: string) =>
      sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json)
        VALUES (${id}, ${thread}, ${runId}, NULL, NULL, NULL, NULL, 1, 'error', 'failed', '2026-11-19T10:00:00.000Z',
          ${JSON.stringify({ failure: { class: failureClass } })})`;
    const message = (id: string, thread: string, at: string) =>
      sql`INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${id}, ${thread}, NULL, NULL, 'user', 0, ${at}, ${at}, '{}')`;
    const receipt = (id: string, thread: string, at: string) =>
      sql`INSERT INTO orchestration_v2_command_receipts
        (command_id, thread_id, command_type, accepted_at, result_sequence, status, error)
        VALUES (${id}, ${thread}, 'thread.project-move.record', ${at}, 1, 'accepted', NULL)`;

    // Thread a: a limit stop on claude-1 today, moved to another model, then handed off.
    yield* run("run-a1", "thread-a", 1, "claude-1", "failed", "2026-11-19T09:00:00.000Z");
    yield* error("err-a1", "run-a1", "thread-a", "usage_limit");
    yield* message("limit-fallback:thread-a:run-a1", "thread-a", "2026-11-19T09:00:05.000Z");
    yield* receipt("handoff-source:thread-a:1", "thread-a", "2026-11-19T09:01:00.000Z");
    // Thread b: a second limit stop on claude-1 (a later hop) and one yesterday.
    yield* run("run-b1", "thread-b", 1, "claude-1", "failed", "2026-11-18T23:00:00.000Z");
    yield* error("err-b1", "run-b1", "thread-b", "usage_limit");
    yield* run("run-b2", "thread-b", 2, "claude-1", "failed", "2026-11-19T11:00:00.000Z");
    yield* error("err-b2", "run-b2", "thread-b", "usage_limit");
    yield* message("limit-fallback:thread-b:hop-1:run-b2", "thread-b", "2026-11-19T11:00:05.000Z");
    yield* message("limit-fallback:thread-b:run-b1", "thread-b", "2026-11-18T23:00:05.000Z");
    // Thread c: a failure that was not a limit, then a handoff: not caused by limits.
    yield* run("run-c1", "thread-c", 1, "codex", "failed", "2026-11-19T12:00:00.000Z");
    yield* error("err-c1", "run-c1", "thread-c", "provider_error");
    yield* receipt("handoff-source:thread-c:1", "thread-c", "2026-11-19T12:01:00.000Z");
    // Thread d: a limit stop, then a run that worked, then a handoff: not caused by the limit.
    yield* run("run-d1", "thread-d", 1, "codex", "failed", "2026-11-19T07:00:00.000Z");
    yield* error("err-d1", "run-d1", "thread-d", "usage_limit");
    yield* run("run-d2", "thread-d", 2, "codex", "completed", "2026-11-19T08:00:00.000Z");
    yield* receipt("handoff-source:thread-d:1", "thread-d", "2026-11-19T13:00:00.000Z");

    const counts = yield* readTeamUsageCounts(NOW);
    expect(Object.fromEntries(counts)).toEqual({
      "claude-1": { limitHits: 2, handoffs: 1, providerSwitches: 2 },
      codex: { limitHits: 1, handoffs: 0, providerSwitches: 0 },
    });
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
