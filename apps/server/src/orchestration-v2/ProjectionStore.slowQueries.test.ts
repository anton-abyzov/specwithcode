import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import Migration0074 from "../persistence/Migrations/074_ShellReadIndexes.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { selectBackgroundBusyThreads } from "../serviceUpdate/ServiceUpdatePreparation.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  PREVIOUS_ACTIVE_LOCATION_FILTER,
  PREVIOUS_ARCHIVE_LOCATION_FILTER,
  PREVIOUS_BACKGROUND_BUSY_SQL,
  PREVIOUS_UNSETTLED_FILTER,
  previousShellThreadRowsSql,
} from "./ProjectionStore.slowQueries.fixture.ts";

// The two statements behind 95% of the slow-statement warnings on a large
// install: the update readiness look for background work and the thread shell
// list. This builds a database of that size, checks the current reads return
// the rows the previous statements returned, and holds each statement under
// SLOW_STATEMENT_BUDGET_MS at p95.

const THREAD_COUNT = 3_600;
const SLOW_STATEMENT_BUDGET_MS = 50;
const PAGE_SIZE = 200;
const INDEX_NAMES = [
  "orchestration_v2_projection_nodes_live_subagent_idx",
  "orchestration_v2_projection_runs_active_latest_idx",
  "orchestration_v2_projection_runs_working_latest_idx",
  "orchestration_v2_projection_messages_fallback_notice_idx",
];

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const createThread = Effect.fn("createThread")(function* (threadId: ThreadId) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  yield* store.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:slow"),
      title: "Slow",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
});

const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") statements.push(query);
      };
      return span;
    },
  });
  return { statements, tracer };
};

const squash = (statement: string) => statement.replace(/\s+/g, " ").trim();
const isShellRowsStatement = (statement: string) => statement.includes("AS running_model_json");
const isShellIdsStatement = (statement: string) =>
  squash(statement).startsWith(
    "SELECT t.thread_id FROM orchestration_v2_projection_threads t WHERE t.deleted_at IS NULL",
  );

const percentile = (values: ReadonlyArray<number>, fraction: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
};
const round = (value: number) => Math.round(value * 10) / 10;

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now();
    const value = yield* effect;
    return { value, ms: performance.now() - started };
  });

// A timestamp `seconds` after 2026-01-01, in the ISO form the projection writes.
const at = (seconds: string) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', 1767225600 + (${seconds}), 'unixepoch')`;
const pad = (length: string) => `printf('%.*c', ${length}, 'x')`;

/**
 * Rows shaped like a long-lived install: most threads hold a few runs and a
 * few hold hundreds, three in eight are deleted, two in five archived, and
 * only a handful of runs are live. Payload sizes follow the live averages
 * (threads about 2.2 KB, runs about 1.6 KB, messages 1 to 2 KB).
 */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const templateId = ThreadId.make("thread:slow:00000");
  const statements = [
    `CREATE TEMP TABLE seq AS
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${THREAD_COUNT - 1})
       SELECT i FROM n`,
    `CREATE TEMP TABLE slow_threads AS
       SELECT i, printf('thread:slow:%05d', i) AS thread_id,
         CASE WHEN i % 5 = 0 THEN 0 WHEN i % 97 = 1 THEN 150 ELSE 1 + i % 7 END AS n_runs,
         CASE WHEN i % 3 = 1 THEN 'claudeAgent' ELSE 'codex' END AS inst,
         CASE i % 3 WHEN 1 THEN 'claude-opus-5-5' WHEN 2 THEN 'gpt-5.4[1m]' ELSE 'gpt-5.4' END AS model
       FROM seq`,
    `CREATE TEMP TABLE slow_runs AS
       SELECT t.i, o.i AS k, t.thread_id, t.inst, t.model, t.n_runs,
         printf('run:slow:%05d:%03d', t.i, o.i) AS run_id,
         (t.i * 31 + o.i * 17) % 100 AS h,
         4 + (t.i * 3 + o.i) % 17 AS n_items,
         t.i * 1000 + o.i * 5 AS clock,
         CASE
           WHEN o.i = t.n_runs AND t.i % 400 = 1 THEN 'running'
           WHEN o.i = t.n_runs AND t.i % 900 = 2 THEN 'queued'
           WHEN o.i = t.n_runs AND t.i % 450 = 3 THEN 'waiting'
           WHEN (t.i * 31 + o.i * 17) % 100 < 89 THEN 'completed'
           WHEN (t.i * 31 + o.i * 17) % 100 < 95 THEN 'failed'
           WHEN (t.i * 31 + o.i * 17) % 100 < 98 THEN 'cancelled'
           ELSE 'interrupted'
         END AS status
       FROM slow_threads t JOIN seq o ON o.i <= t.n_runs`,
    `CREATE INDEX temp.slow_runs_idx ON slow_runs(i, k)`,
    // Threads: clones of one thread the store wrote, so every payload decodes.
    `INSERT INTO orchestration_v2_projection_threads
       (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json,
        provider_instance_id)
     SELECT s.thread_id, t.project_id, 'Thread ' || s.i, t.default_provider, t.runtime_mode,
       t.interaction_mode, NULL, t.created_at,
       -- Shared timestamps, so the list order also rests on the thread id.
       ${at("(s.i * 7919) % 1200")},
       CASE WHEN s.i % 5 < 2 THEN ${at("s.i")} END,
       CASE WHEN s.i % 8 < 3 THEN ${at("s.i")} END,
       json_set(t.payload_json,
         '$.id', s.thread_id,
         '$.lineage.rootThreadId', s.thread_id,
         '$.modelSelection', json_object('instanceId', s.inst, 'model', s.model),
         '$.archivedAt', CASE WHEN s.i % 5 < 2 THEN ${at("s.i")} END,
         '$.settledAt', CASE WHEN s.i % 4 <> 0 THEN ${at("s.i")} END,
         '$.settledOverride', CASE WHEN s.i % 16 = 0 THEN 'settled' END,
         '$.creationSource', CASE WHEN s.i % 3 = 0 THEN 'provider' ELSE 'web' END,
         '$.lineage.relationshipToParent', CASE WHEN s.i % 3 = 0 THEN 'subagent' END,
         '$.launchFallbackFrom', CASE WHEN s.i % 40 = 0 THEN json_object('instanceId', 'claudeAgent', 'model', 'claude-opus-5-5') END,
         '$.limitPreswitchFrom', CASE WHEN s.i % 55 = 0 THEN json_object('modelSelection', json_object('instanceId', 'codex', 'model', 'gpt-5.5')) END,
         '$.forkedFrom', CASE WHEN s.i % 250 = 9 THEN json_object('type', 'run', 'threadId', printf('thread:slow:%05d', s.i - 1)) END,
         '$.pad', ${pad("CASE WHEN s.i % 50 = 0 THEN 20000 ELSE 1500 + s.i % 800 END")}),
       s.inst
     FROM slow_threads s, orchestration_v2_projection_threads t
     WHERE t.thread_id = '${templateId}'`,
    `INSERT INTO orchestration_v2_projection_runs
       (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
        completed_at, payload_json, provider_instance_id)
     SELECT run_id, thread_id, k, inst, 'provider-thread:' || thread_id, status, ${at("clock")},
       CASE WHEN status NOT IN ('running', 'queued', 'waiting') THEN ${at("clock + 3")} END,
       json_object(
         'id', run_id, 'threadId', thread_id, 'ordinal', k, 'status', status,
         'modelSelection', json_object('instanceId', inst, 'model',
           CASE WHEN h % 9 = 0 THEN 'gpt-5.5' ELSE model END),
         'rootNodeId', 'node:' || run_id,
         'activeAttemptId', 'attempt:' || run_id,
         'queueHeld', CASE WHEN status = 'queued' AND i % 1800 = 2 THEN json('true') END,
         'startedAt', CASE WHEN status = 'cancelled' AND h % 2 = 1 THEN NULL ELSE ${at("clock + 1")} END,
         'workStartedAt', CASE WHEN h % 4 = 0 THEN ${at("clock + 2")} END,
         'pad', ${pad("1100 + h")}),
       inst
     FROM slow_runs`,
    `INSERT INTO orchestration_v2_projection_messages
       (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
     SELECT 'message:user:' || run_id, thread_id, run_id, 'node:' || run_id, 'user', 0,
       ${at("clock")}, ${at("clock")},
       json_object('createdBy', CASE WHEN (i + k) % 5 = 0 THEN 'user' ELSE 'agent' END,
         'text', ${pad("1700 + h")})
     FROM slow_runs`,
    `INSERT INTO orchestration_v2_projection_messages
       (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
     SELECT printf('message:assistant:%s:%d', r.run_id, a.i), r.thread_id, r.run_id,
       'node:' || r.run_id, 'assistant',
       CASE WHEN r.status = 'running' AND a.i = 1 + (r.i + r.k) % 4 THEN 1 ELSE 0 END,
       ${at("r.clock + a.i")}, ${at("r.clock + a.i")},
       json_object('text', 'Answer ' || a.i || ' ' || ${pad("850 + r.h")})
     FROM slow_runs r JOIN seq a ON a.i <= 1 + (r.i + r.k) % 4`,
    // Fallback notices: the continuation of a stopped run, carried by the next run.
    `INSERT INTO orchestration_v2_projection_messages
       (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
     SELECT CASE WHEN h % 2 = 0 THEN 'limit-fallback:' ELSE 'provider-fallback:' END || run_id,
       thread_id, CASE WHEN k < n_runs THEN printf('run:slow:%05d:%03d', i, k + 1) END, NULL,
       'assistant', 0, ${at("clock + 4")}, ${at("clock + 4")}, json_object('text', 'Moved')
     FROM slow_runs WHERE status = 'failed' AND (i + k) % 3 = 0`,
    `INSERT INTO orchestration_v2_projection_turn_items
       (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json)
     SELECT printf('item:%s:%02d', r.run_id, j.i), r.thread_id, r.run_id,
       CASE WHEN j.i = r.n_items THEN 'node:' || r.run_id
         ELSE printf('node:%s:%02d', r.run_id, j.i) END,
       NULL, NULL, NULL, j.i,
       CASE
         WHEN j.i = r.n_items AND r.status = 'failed' THEN 'error'
         WHEN j.i = r.n_items AND r.status = 'running' AND r.i % 800 = 1 THEN 'secret_request'
         WHEN j.i % 7 = 0 THEN 'command_execution'
         ELSE 'assistant_message'
       END,
       CASE
         WHEN j.i = r.n_items AND r.status = 'failed' THEN 'failed'
         WHEN j.i = r.n_items AND r.status = 'running' AND r.i % 800 = 1 THEN 'waiting'
         WHEN j.i = r.n_items AND r.status = 'running' THEN 'running'
         ELSE 'completed'
       END,
       ${at("r.clock + j.i")}, json_object('ordinal', j.i, 'text', ${pad("100")})
     FROM slow_runs r JOIN seq j ON j.i <= r.n_items`,
    // Items outside any run, as imported history leaves them.
    `INSERT INTO orchestration_v2_projection_turn_items
       (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json)
     SELECT printf('item:runless:%05d:%02d', t.i, j.i), t.thread_id, NULL, NULL, NULL, NULL, NULL,
       1000 + j.i, 'assistant_message', 'completed', ${at("t.i")}, '{}'
     FROM slow_threads t JOIN seq j ON j.i <= 3 WHERE t.i % 11 = 0`,
    `INSERT INTO orchestration_v2_projection_nodes
       (node_id, thread_id, run_id, parent_node_id, root_node_id, kind, status,
        provider_thread_id, provider_turn_id, runtime_request_id, checkpoint_scope_id,
        started_at, completed_at, payload_json)
     SELECT 'node:' || run_id, thread_id, run_id, NULL, 'node:' || run_id, 'root_turn',
       CASE WHEN status IN ('running', 'waiting') THEN status
         WHEN status = 'queued' THEN 'pending' ELSE 'completed' END,
       NULL, NULL, NULL, NULL, ${at("clock")}, NULL, '{}'
     FROM slow_runs`,
    `INSERT INTO orchestration_v2_projection_nodes
       (node_id, thread_id, run_id, parent_node_id, root_node_id, kind, status,
        provider_thread_id, provider_turn_id, runtime_request_id, checkpoint_scope_id,
        started_at, completed_at, payload_json)
     SELECT printf('node:%s:%02d', r.run_id, j.i), r.thread_id, r.run_id, 'node:' || r.run_id,
       'node:' || r.run_id,
       CASE WHEN j.i % 9 = 4 THEN 'subagent' WHEN j.i % 3 = 0 THEN 'reasoning' ELSE 'tool_call' END,
       -- Live subagents under live runs, and a few left live under finished runs.
       CASE
         WHEN j.i % 9 = 4 AND r.status IN ('running', 'waiting') THEN 'running'
         WHEN j.i % 9 = 4 AND r.h = 7 THEN 'waiting'
         ELSE 'completed'
       END,
       NULL, NULL, NULL, NULL, ${at("r.clock + j.i")}, NULL, '{}'
     FROM slow_runs r JOIN seq j ON j.i < r.n_items`,
    // Provider-native child threads that never had a run of their own.
    `INSERT INTO orchestration_v2_projection_nodes
       (node_id, thread_id, run_id, parent_node_id, root_node_id, kind, status,
        provider_thread_id, provider_turn_id, runtime_request_id, checkpoint_scope_id,
        started_at, completed_at, payload_json)
     SELECT 'node:runless:' || thread_id, thread_id, NULL, NULL, 'node:runless:' || thread_id,
       'root_turn', CASE i % 4 WHEN 0 THEN 'running' WHEN 1 THEN 'pending' ELSE 'completed' END,
       NULL, NULL, NULL, NULL, ${at("i")}, NULL, '{}'
     FROM slow_threads WHERE i % 15 = 0`,
    `INSERT INTO orchestration_v2_projection_subagents
       (subagent_id, thread_id, run_id, parent_node_id, provider, provider_thread_id,
        child_thread_id, origin, status, started_at, completed_at, updated_at, payload_json,
        driver, provider_instance_id)
     SELECT 'subagent:' || thread_id, printf('thread:slow:%05d', i - 1), NULL, 'node:parent:' || i,
       inst, NULL, thread_id, 'provider_native',
       CASE WHEN i % 60 = 0 THEN 'running' ELSE 'completed' END, ${at("i")},
       CASE WHEN i % 60 <> 0 THEN ${at("i + 9")} END, ${at("i + 9")}, '{}', inst, inst
     FROM slow_threads WHERE i % 3 = 0`,
    `INSERT INTO orchestration_v2_projection_provider_threads
       (provider_thread_id, thread_id, owner_node_id, provider, provider_session_id, status,
        first_run_ordinal, last_run_ordinal, updated_at, payload_json, driver, provider_instance_id)
     SELECT 'provider-thread:' || thread_id, thread_id, NULL, inst, 'session:' || thread_id, 'idle',
       1, n_runs, ${at("i")},
       json_set(json_object('id', 'provider-thread:' || thread_id, 'pad', ${pad("1000")}),
         '$.pendingBackgroundTasks',
         CASE WHEN i % 300 = 6 THEN json_array(json_object('id', 'task'))
           WHEN i % 3 = 0 THEN json_array() END),
       inst, inst
     FROM slow_threads WHERE n_runs > 0 OR i % 10 = 0`,
    `INSERT INTO orchestration_v2_projection_provider_sessions
       (provider_session_id, thread_id, provider, status, model, updated_at, payload_json, driver,
        provider_instance_id)
     SELECT 'session:' || thread_id, thread_id, inst, 'idle', model, ${at("i")},
       CASE WHEN i % 60 = 2 THEN json_object('lastError', 'Provider stopped') ELSE '{}' END,
       inst, inst
     FROM slow_threads WHERE n_runs > 0 AND i % 2 = 0`,
    `INSERT INTO orchestration_v2_projection_provider_session_bindings (provider_session_id, thread_id)
     SELECT 'session:' || thread_id, thread_id FROM slow_threads WHERE n_runs > 0 AND i % 2 = 0`,
    `INSERT INTO orchestration_v2_projection_plans
       (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
     SELECT 'plan:' || run_id, thread_id, run_id, 'node:' || run_id,
       CASE WHEN i % 70 = 0 THEN 'proposed_plan' ELSE 'todo_list' END, 'active',
       json_object('steps', json_array(run_id))
     FROM slow_runs WHERE i % 35 = 0 AND k % 2 = 1`,
    `INSERT INTO orchestration_v2_projection_runtime_requests
       (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at,
        resolved_at, payload_json)
     SELECT CASE WHEN i % 300 = 7 THEN 'update-reopen:' ELSE '' END || 'request:' || thread_id,
       thread_id, 'node:request:' || i, NULL, 'user_input', 'pending', ${at("i")}, NULL,
       json_object('question', 'Continue?')
     FROM slow_threads WHERE i % 100 = 7`,
    `INSERT INTO orchestration_v2_projection_runtime_requests
       (runtime_request_id, thread_id, node_id, provider_turn_id, kind, status, created_at,
        resolved_at, payload_json)
     SELECT 'request:' || thread_id || ':answered', thread_id, 'node:request:' || i, NULL,
       'user_input', 'resolved', ${at("i")}, ${at("i + 1")}, json_object('decision', 'accept')
     FROM slow_threads WHERE i % 100 = 7 AND i % 200 <> 7`,
    `DROP TABLE slow_runs`,
    `DROP TABLE slow_threads`,
    `DROP TABLE seq`,
  ];
  for (const statement of statements) yield* sql.unsafe(statement);
});

it.effect(
  "returns the previous rows and stays under the slow-statement budget at 3,600 threads",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const templateId = ThreadId.make("thread:slow:00000");
      yield* createThread(templateId);

      // The statements the store really runs, taken from its own spans.
      const { statements, tracer } = traceSqlStatements();
      const capture = <A, E, R>(read: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const from = statements.length;
          yield* read.pipe(Effect.withTracer(tracer));
          return statements.slice(from);
        });
      const idsStatement = (traced: ReadonlyArray<string>) => {
        const found = traced.find(isShellIdsStatement);
        assert.isDefined(found);
        return found as string;
      };
      const listed = yield* capture(store.getShellSnapshot());
      const pageStatement = listed.find(isShellRowsStatement);
      assert.isDefined(pageStatement);
      const variants = [
        { name: "every thread", ids: idsStatement(listed), filter: "" },
        {
          name: "active",
          ids: idsStatement(yield* capture(store.getShellSnapshot({ location: "active" }))),
          filter: PREVIOUS_ACTIVE_LOCATION_FILTER,
        },
        {
          name: "archive",
          ids: idsStatement(yield* capture(store.getShellSnapshot({ location: "archive" }))),
          filter: PREVIOUS_ARCHIVE_LOCATION_FILTER,
        },
        {
          name: "unsettled",
          ids: idsStatement(yield* capture(store.getShellSnapshot({ unsettledOnly: true }))),
          filter: PREVIOUS_UNSETTLED_FILTER,
        },
      ];
      const oneThreadStatement = (yield* capture(store.getThreadShell(templateId))).find(
        isShellRowsStatement,
      );
      assert.isDefined(oneThreadStatement);

      yield* seed;
      const [sizes] = yield* sql<{
        readonly threads: number;
        readonly listed: number;
        readonly runs: number;
        readonly thread_bytes: number;
        readonly run_bytes: number;
        readonly messages: number;
        readonly items: number;
        readonly nodes: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_v2_projection_threads) AS threads,
          (SELECT COUNT(*) FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL) AS listed,
          (SELECT COUNT(*) FROM orchestration_v2_projection_runs) AS runs,
          (SELECT AVG(length(payload_json)) FROM orchestration_v2_projection_threads) AS thread_bytes,
          (SELECT AVG(length(payload_json)) FROM orchestration_v2_projection_runs) AS run_bytes,
          (SELECT COUNT(*) FROM orchestration_v2_projection_messages) AS messages,
          (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items) AS items,
          (SELECT COUNT(*) FROM orchestration_v2_projection_nodes) AS nodes
      `;
      assert.isDefined(sizes);
      if (sizes === undefined) return;
      assert.isAtLeast(sizes.threads, 3_500);
      assert.isAtLeast(sizes.runs, 15_000);
      assert.isAtLeast(sizes.thread_bytes, 2_000);
      assert.isAtLeast(sizes.run_bytes, 1_400);

      const rowsOf = (statement: string, params: ReadonlyArray<string> = []) =>
        sql.unsafe<Record<string, unknown>>(statement, params);
      const busyIds = (rows: ReadonlyArray<{ readonly thread_id?: unknown }>) =>
        rows.map((row) => String(row.thread_id)).sort();

      // Before: the previous statements on the schema as migration 073 left it.
      for (const name of INDEX_NAMES) yield* sql.unsafe(`DROP INDEX ${name}`);
      const previousList = previousShellThreadRowsSql("");
      const previousRows = new Map<string, string>();
      for (const variant of variants) {
        previousRows.set(
          variant.name,
          JSON.stringify(yield* rowsOf(previousShellThreadRowsSql(variant.filter))),
        );
      }
      const sampleIds = Array.from({ length: 80 }, (_, index) =>
        index === 0 ? "thread:slow:missing" : `thread:slow:${String(index * 44).padStart(5, "0")}`,
      );
      const previousOneThread = previousShellThreadRowsSql(" AND t.thread_id = ?");
      const previousSamples: Array<string> = [];
      for (const id of sampleIds) {
        previousSamples.push(JSON.stringify(yield* rowsOf(previousOneThread, [id])));
      }
      const previousBusy = busyIds(yield* rowsOf(PREVIOUS_BACKGROUND_BUSY_SQL));
      assert.isAbove(previousBusy.length, 3);
      const previousListMs: Array<number> = [];
      const previousBusyMs: Array<number> = [];
      for (let round = 0; round < 7; round += 1) {
        previousListMs.push((yield* timed(rowsOf(previousList))).ms);
        previousBusyMs.push((yield* timed(rowsOf(PREVIOUS_BACKGROUND_BUSY_SQL))).ms);
      }

      // After: migration 074's indexes and the statements the store runs now.
      const migration = yield* timed(Migration0074);
      const readPages = (ids: string, durations?: Array<number>) =>
        Effect.gen(function* () {
          const ordered = yield* timed(rowsOf(ids));
          durations?.push(ordered.ms);
          const threadIds = ordered.value.map((row) => String(row.thread_id));
          const rows: Array<Record<string, unknown>> = [];
          for (let start = 0; start < threadIds.length; start += PAGE_SIZE) {
            const page = yield* timed(
              rowsOf(pageStatement as string, [
                JSON.stringify(threadIds.slice(start, start + PAGE_SIZE)),
              ]),
            );
            durations?.push(page.ms);
            for (const row of page.value) rows.push(row);
          }
          return rows;
        });

      for (const variant of variants) {
        const rows = yield* readPages(variant.ids);
        assert.isAbove(rows.length, PAGE_SIZE, variant.name);
        assert.isTrue(
          JSON.stringify(rows) === previousRows.get(variant.name),
          `${variant.name}: the paged rows differ from the previous statement's`,
        );
      }
      for (const [index, id] of sampleIds.entries()) {
        assert.strictEqual(
          JSON.stringify(yield* rowsOf(oneThreadStatement as string, [id])),
          previousSamples[index],
          id,
        );
      }
      assert.deepStrictEqual(busyIds(yield* selectBackgroundBusyThreads(sql)), previousBusy);

      const plan = (statement: string, params: ReadonlyArray<string> = []) =>
        sql
          .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement}`, params)
          .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));
      const busyPlan = yield* plan(PREVIOUS_BACKGROUND_BUSY_SQL);
      assert.include(busyPlan, "orchestration_v2_projection_nodes_live_subagent_idx");
      assert.notMatch(busyPlan, /SCAN n$/m);
      const pagePlan = yield* plan(pageStatement as string, ["[]"]);
      for (const name of INDEX_NAMES.slice(1)) assert.include(pagePlan, name);
      assert.match(pagePlan, /SEARCH t USING INDEX \S+ \(thread_id=\?\)/);

      const listStatementMs: Array<number> = [];
      const listTotalMs: Array<number> = [];
      const busyMs: Array<number> = [];
      const oneThreadMs: Array<number> = [];
      for (let round = 0; round < 12; round += 1) {
        listTotalMs.push((yield* timed(readPages(variants[0]?.ids ?? "", listStatementMs))).ms);
      }
      for (let round = 0; round < 60; round += 1) {
        busyMs.push((yield* timed(selectBackgroundBusyThreads(sql))).ms);
        oneThreadMs.push(
          (yield* timed(rowsOf(oneThreadStatement as string, [sampleIds[1 + (round % 79)] ?? ""])))
            .ms,
        );
      }

      const report = {
        rows: {
          ...sizes,
          thread_bytes: round(sizes.thread_bytes),
          run_bytes: round(sizes.run_bytes),
        },
        migration074Ms: round(migration.ms),
        shellList: {
          previousOneStatementMs: {
            p50: round(percentile(previousListMs, 0.5)),
            max: round(Math.max(...previousListMs)),
          },
          pagedStatementMs: {
            p50: round(percentile(listStatementMs, 0.5)),
            p95: round(percentile(listStatementMs, 0.95)),
            max: round(Math.max(...listStatementMs)),
            statementsPerRead: listStatementMs.length / listTotalMs.length,
          },
          pagedWholeReadMs: { p50: round(percentile(listTotalMs, 0.5)) },
          oneThreadMs: { p95: round(percentile(oneThreadMs, 0.95)) },
        },
        backgroundBusy: {
          previousMs: {
            p50: round(percentile(previousBusyMs, 0.5)),
            max: round(Math.max(...previousBusyMs)),
          },
          currentMs: { p50: round(percentile(busyMs, 0.5)), p95: round(percentile(busyMs, 0.95)) },
        },
      };
      console.info(`slow query timings ${JSON.stringify(report)}`);

      assert.isBelow(percentile(listStatementMs, 0.95), SLOW_STATEMENT_BUDGET_MS);
      assert.isBelow(percentile(oneThreadMs, 0.95), SLOW_STATEMENT_BUDGET_MS);
      assert.isBelow(percentile(busyMs, 0.95), SLOW_STATEMENT_BUDGET_MS);
    }).pipe(Effect.provide(layerTest)),
  { timeout: 300_000 },
);
