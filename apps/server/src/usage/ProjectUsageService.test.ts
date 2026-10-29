import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  ProviderThreadId,
  ProviderTurnId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunAttemptId,
  RunId,
  type TurnTokenUsage,
  type OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectUsage from "./ProjectUsageService.ts";
import * as UsageService from "./UsageService.ts";
import { routineProject } from "../scheduledTasks/ScheduledTaskService.test-fixtures.ts";
import {
  aggregateProjectUsage,
  localDay,
  type ProjectUsageProjection,
} from "./projectUsageAggregation.ts";
import { parseRateTable } from "./usagePricing.ts";

const projectId = ProjectId.make("project-usage");
const complete: TurnTokenUsage = {
  usageScope: "main_agent",
  usageStatus: "complete",
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 60,
  cacheCreationTokens: 10,
  reasoningTokens: 5,
  hasSubagents: false,
};
const fixture = (
  name: string,
  usage: TurnTokenUsage | undefined = complete,
  driver = "codex",
  model = "fixture-model",
): ProjectUsageProjection => {
  const id = ThreadId.make(name),
    instance = ProviderInstanceId.make(driver),
    providerId = ProviderThreadId.make(`provider-${name}`),
    runId = RunId.make(`run-${name}`),
    attemptId = RunAttemptId.make(`attempt-${name}`);
  return {
    thread: { id, projectId, title: name, archivedAt: null, deletedAt: null },
    providerThreads: [
      {
        id: providerId,
        driver: ProviderDriverKind.make(driver),
        providerInstanceId: instance,
        appThreadId: id,
        nativeThreadRef: {
          nativeId: `native-${name}`,
          driver: ProviderDriverKind.make(driver),
          strength: "strong",
        },
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make(`turn-${name}`),
        providerThreadId: providerId,
        runAttemptId: attemptId,
        nativeTurnRef: {
          nativeId: "turn-1",
          driver: ProviderDriverKind.make(driver),
          strength: "strong",
        },
        ...(usage === undefined ? {} : { turnTokenUsage: usage }),
        tokenUsage: { usedTokens: 99999, inputTokens: 88888, updatedAt: "2026-10-09T00:00:00Z" },
      },
    ],
    attempts: [{ id: attemptId, runId, nativeThreadId: `native-${name}` }],
    runs: [{ id: runId, threadId: id, modelSelection: { instanceId: instance, model } }],
  };
};
const rates = parseRateTable({
  "fixture-model": {
    input_cost_per_token: 1,
    output_cost_per_token: 5,
    cache_read_input_token_cost: 0.1,
    cache_creation_input_token_cost: 2,
    input_cost_per_token_priority: 2,
    output_cost_per_token_priority: 10,
  },
});
const fold = (projections: ProjectUsageProjection[]) =>
  aggregateProjectUsage({
    projectId,
    coordinatorThreadId: ThreadId.make("coordinator"),
    readAt: "2026-10-09T00:00:00Z",
    projections,
    rates,
  });

describe("project usage accounting", () => {
  it.each(["missing", "foreign"] as const)(
    "ignores a %s provider row inside a local projection",
    (scenario) => {
      const owned = fixture(`local-${scenario}`);
      const result = fold([
        {
          ...owned,
          providerThreads:
            scenario === "missing"
              ? []
              : [{ ...owned.providerThreads[0]!, appThreadId: ThreadId.make("foreign-thread") }],
        },
      ]);
      assert.equal(result.totals.totalTokens, 0);
      assert.equal(result.coverage.completeTurns, 0);
      assert.equal(result.coverage.threadsWithUsage, 0);
      assert.equal(result.coverage.missingThreads, 1);
      assert.deepEqual(result.models, []);
    },
  );
  it("counts owned orphan turns once by stable ID without borrowing an unrelated run's model or price", () => {
    const owned = fixture("orphan");
    const turn = { ...owned.providerTurns[0]!, runAttemptId: null, nativeTurnRef: null };
    const orphan = {
      ...owned,
      providerThreads: [{ ...owned.providerThreads[0]!, nativeThreadRef: null }],
      providerTurns: [turn, turn, { ...turn, id: ProviderTurnId.make("distinct-orphan-turn") }],
      // Keep the unrelated priced run/attempt present to detect attribution by container rather than linkage.
    };
    const copied = fixture("imported-orphan");
    const imported = {
      ...copied,
      providerThreads: [{ ...copied.providerThreads[0]!, nativeThreadRef: null }],
      providerTurns: [{ ...turn, providerThreadId: copied.providerThreads[0]!.id }],
    };
    const result = fold([orphan, imported, orphan]);
    assert.equal(result.totals.totalTokens, 240);
    assert.equal(result.coverage.completeTurns, 2);
    assert.equal(result.coverage.costUnknownTurns, 2);
    assert.equal(result.coverage.costEstimatedTurns, 0);
    assert.isNull(result.totals.equivalentCostUsd);
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0]?.modelAttribution, "unknown");
    assert.isNull(result.models[0]?.model);
    assert.equal(result.models[0]?.totals.totalTokens, 240);
    assert.equal(
      result.threads.find((thread) => thread.threadId === copied.thread.id)?.totals.totalTokens,
      0,
    );
  });
  it("counts persisted turn consumption once, ignoring occupancy and repeated snapshots", () => {
    const p = fixture("coordinator");
    const previous = { ...p.providerTurns[0]!, turnTokenUsage: { ...complete, inputTokens: 40 } };
    const current = { ...p, providerTurns: [previous, ...p.providerTurns] };
    const a = fold([current, current]);
    assert.equal(a.totals.totalTokens, 120);
    assert.equal(a.coverage.completeTurns, 1);
    assert.equal(a.threads[0]?.role, "coordinator");
    assert.deepEqual(fold([current]), a);
    assert.equal(a.totals.equivalentCostUsd, 156); // 30 uncached + 6 read + 20 write + 100 output
    assert.equal(a.cacheReadRatio, 0.6);
  });
  it("deduplicates the same native turn across imported views, but retains separate providers", () => {
    const a = fixture("a");
    const copied = fixture("copied");
    const copy = { ...copied, attempts: [{ ...copied.attempts[0]!, nativeThreadId: "native-a" }] };
    const claude = fixture("a-claude", complete, "claudeAgent");
    assert.equal(fold([a, copy, claude]).totals.totalTokens, 240);
  });
  it("keeps historical provider/model attribution and main-agent scope", () => {
    const a = fixture("worker", { ...complete, hasSubagents: true }, "claudeAgent", "old-model");
    const unknown = { ...fixture("unknown"), runs: [] };
    const result = fold([a, unknown]);
    assert.equal(result.scope, "recorded_main_agents");
    assert.equal(result.coverage.subagentTurns, 1);
    assert.equal(result.models[0]?.model, "old-model");
    assert.equal(result.models[0]?.provider, "claudeAgent");
    assert.equal(result.models[1]?.modelAttribution, "unknown");
    assert.equal(result.models[1]?.model, null);
    assert.equal(result.totals.equivalentCostUsd, null);
  });
  it("preserves missing cache categories, partial totals and unmeasured threads", () => {
    const missing = { ...fixture("missing"), providerTurns: [] };
    const partial = fixture("partial", {
      usageScope: "main_agent",
      usageStatus: "partial",
      inputTokens: 5,
      hasSubagents: false,
    });
    const result = fold([fixture("complete"), partial, missing]);
    assert.equal(result.totals.totalTokens, 125);
    assert.equal(result.totals.cachedInputTokens, null);
    assert.equal(result.totals.equivalentCostUsd, 156);
    assert.equal(result.cacheReadRatio, null);
    assert.equal(result.coverage.partialTurns, 1);
    assert.equal(result.coverage.missingThreads, 1);
    assert.equal(result.coverage.costUnknownTurns, 1);
    assert.equal(result.coverage.costEstimatedTurns, 1);
  });
  it("does not count unavailable values or another project's deleted/imported history", () => {
    const unavailable = fixture("unavailable", {
      usageScope: "main_agent",
      usageStatus: "unavailable",
      inputTokens: 999,
      hasSubagents: false,
    });
    const foreign = fixture("foreign"),
      deleted = fixture("deleted");
    const result = fold([
      unavailable,
      { ...foreign, thread: { ...foreign.thread, projectId: ProjectId.make("other") } },
      { ...deleted, thread: { ...deleted.thread, deletedAt: {} as never } },
    ]);
    assert.equal(result.totals.totalTokens, 0);
    assert.equal(result.coverage.threads, 1);
    assert.equal(result.coverage.missingTurns, 1);
    assert.equal(result.cacheReadRatio, null);
  });
  it("prices selected speed options and refuses inconsistent cache subsets", () => {
    const p = fixture("fast");
    const fast = {
      ...p,
      runs: [
        {
          ...p.runs[0]!,
          modelSelection: {
            ...p.runs[0]!.modelSelection,
            options: [{ id: "serviceTier", value: "priority" }],
          },
        },
      ],
    };
    assert.equal(fold([fast]).totals.equivalentCostUsd, 312);
    const bad = fixture("bad", { ...complete, cachedInputTokens: 95 });
    assert.equal(fold([bad]).totals.equivalentCostUsd, null);
  });
  it("weights cache reads by input volume instead of averaging thread percentages", () => {
    const result = fold([
      fixture("small"),
      fixture("large", { ...complete, inputTokens: 900, cachedInputTokens: 90 }),
    ]);
    assert.equal(result.cacheReadRatio, 0.15);
    assert.equal(
      result.threads.reduce((sum, t) => sum + (t.share ?? 0), 0),
      1,
    );
  });

  it("splits each thread by model and dates turns by completion for the trend", () => {
    const done = DateTime.makeUnsafe("2026-10-08T12:00:00Z");
    const worker = fixture("worker", complete, "codex", "gpt-5.5");
    const coordinator = fixture("coordinator", complete, "claudeAgent", "claude-opus-5-5");
    const undated = fixture("undated", complete, "codex", "gpt-5.5");
    const dated = (projection: ProjectUsageProjection, startedAt = done) => ({
      ...projection,
      providerTurns: projection.providerTurns.map((turn) => ({
        ...turn,
        startedAt,
        completedAt: null,
      })),
    });
    const result = fold([dated(worker), dated(coordinator), undated]);
    const threadModels = Object.fromEntries(
      result.threads.map((thread) => [thread.threadId, thread.models]),
    );
    assert.deepEqual(threadModels["coordinator"], [
      {
        provider: "claudeAgent",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
        totals: result.threads.find((t) => t.threadId === "coordinator")!.totals,
      },
    ]);
    assert.equal(threadModels["worker"]?.[0]?.model, "gpt-5.5");
    // The undated thread still counts in totals but never enters the trend.
    assert.equal(result.totals.totalTokens, 360);
    assert.deepEqual(
      result.daily?.map(({ day, role, model, totalTokens }) => ({ day, role, model, totalTokens })),
      [
        {
          day: localDay(DateTime.toEpochMillis(done)),
          role: "coordinator",
          model: "claude-opus-5-5",
          totalTokens: 120,
        },
        {
          day: localDay(DateTime.toEpochMillis(done)),
          role: "worker",
          model: "gpt-5.5",
          totalTokens: 120,
        },
      ],
    );
  });
});

it.effect("service reads scoped persisted rows and cached rates without native homes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      config = yield* ServerConfig.ServerConfig;
    const selected: string[] = [];
    const folderReads: Array<{ roots: readonly string[]; excludeRoots?: readonly string[] }> = [];
    const p = fixture("coordinator");
    for (const [id, project, deleted] of [
      ["coordinator", projectId, null],
      ["other", "other-project", null],
      ["deleted", projectId, "2026-10-09T00:00:00Z"],
    ]) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({ thread_id: id, project_id: project, title: "Synthetic", default_provider: "codex", runtime_mode: "full-access", interaction_mode: "default", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: deleted, payload_json: "{}" })}`;
    }
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert({ provider_thread_id: "pt-owned", thread_id: "elsewhere", provider: "claudeAgent", status: "idle", updated_at: "2026-10-09T00:00:00Z", payload_json: JSON.stringify({ nativeThreadRef: { driver: "claudeAgent", nativeId: "studio-native", strength: "strong" } }) })}`;
    for (const [id, root, deleted] of [
      ["nested", "/synthetic-project/nested", null],
      ["sibling", "/synthetic-project-old", null],
      ["gone", "/synthetic-project/gone", "2026-10-09T00:00:00Z"],
    ] as const) {
      yield* sql`INSERT INTO projection_projects ${sql.insert({ project_id: id, title: id, workspace_root: root, scripts_json: "[]", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", deleted_at: deleted })}`;
    }
    yield* fs.writeFileString(
      path.join(config.stateDir, "usage-model-rates.json"),
      JSON.stringify({
        fetchedAtMs: 1,
        document: {
          "fixture-model": {
            input_cost_per_token: 1,
            output_cost_per_token: 5,
            cache_read_input_token_cost: 0.1,
            cache_creation_input_token_cost: 2,
          },
        },
      }),
    );
    const layers = Layer.mergeAll(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id) =>
          Effect.succeed(
            id === projectId
              ? Option.some({
                  ...routineProject(id),
                  workspaceSettings: { coordinatorThreadId: p.thread.id },
                } as ProjectStore.ProjectRow)
              : Option.none(),
          ),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadRecords: (id) => {
          selected.push(id);
          return Effect.succeed(p as unknown as OrchestrationV2ThreadProjection);
        },
      }),
      Layer.mock(UsageService.UsageService)({
        readFolderSessions: (input) => {
          folderReads.push(input);
          const totals = {
            uncachedInputTokens: 10,
            cachedInputTokens: 80,
            cacheCreationTokens: 10,
            outputTokens: 20,
            reasoningTokens: 0,
          };
          return Effect.succeed([
            {
              provider: "claude" as const,
              path: "/home/.claude/projects/-synthetic-project/cli.jsonl",
              records: [
                {
                  timestampMs: Date.parse("2026-10-09T00:00:00Z"),
                  model: "fixture-model",
                  sessionId: "cli-session",
                  totals,
                  reportedCostUsd: null,
                  speed: "standard" as const,
                  dedupeKey: "m1:r1",
                },
                {
                  timestampMs: Date.parse("2026-10-09T00:00:01Z"),
                  model: "fixture-model",
                  sessionId: "studio-native",
                  totals,
                  reportedCostUsd: null,
                  speed: "standard" as const,
                  dedupeKey: "m2:r2",
                },
              ],
            },
          ]);
        },
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ProjectUsage.ProjectUsageService;
      const result = yield* service.read({ projectId });
      assert.deepEqual(selected, ["coordinator"]);
      assert.equal(result.totals.equivalentCostUsd, 156);
      assert.equal(result.coordinatorThreadId, "coordinator");
      assert.equal(result.threads[0]?.role, "coordinator");
      // Folder sessions: the Studio-owned native session is left out.
      assert.deepEqual(folderReads[0]?.roots, ["/synthetic-project"]);
      assert.deepEqual(folderReads[0]?.excludeRoots, ["/synthetic-project/nested"]);
      assert.equal(result.folderSessions?.sessions, 1);
      assert.equal(result.folderSessions?.studioOwnedSessions, 1);
      assert.equal(result.folderSessions?.totals.totalTokens, 120);
      assert.equal(result.folderSessions?.totals.cachedInputTokens, 80);
      assert.equal(result.folderSessions?.providers[0]?.provider, "claude");
      assert.equal(
        (yield* service.read({ projectId: ProjectId.make("missing") }).pipe(Effect.flip)).reason,
        "project_not_found",
      );
      yield* fs.writeFileString(path.join(config.stateDir, "usage-model-rates.json"), "invalid");
      const missingRates = yield* service.read({ projectId });
      assert.equal(missingRates.totals.totalTokens, 120);
      assert.equal(missingRates.totals.equivalentCostUsd, null);
    }).pipe(Effect.provide(ProjectUsage.layer.pipe(Layer.provide(layers))));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Sqlite.layerMemory,
        ServerConfig.layerTest(process.cwd(), { prefix: "project-usage-" }),
        ServerSettings.layerTest(),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
