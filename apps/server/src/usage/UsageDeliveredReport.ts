/**
 * UsageDeliveredReport - what this machine's measured usage delivered (1456).
 *
 * The cost basis is the Cost tab's, as in UsageMachineReport: transcript
 * records, each tied to the app thread that owns its native session, plus the
 * turns SpecWithCode recorded for drivers that keep no transcript, priced with
 * the same table, overrides and aliases. Threads are tied to SpecWeave
 * increments through ThreadIncrementProgressService (the plan card's
 * resolver); increments closed, merged or with tasks done in the range are
 * read from the project's planning folder even without spend. The folding
 * rules live in usageDeliveredCore.ts.
 *
 * @module usage/UsageDeliveredReport
 */
import {
  ModelSelection,
  ProjectId,
  THREAD_INCREMENT_PROGRESS_MAX_THREADS,
  ThreadId,
  TurnTokenUsage,
  USAGE_DELIVERED_MAX_DAYS,
  USAGE_DELIVERED_REPORT_VERSION,
  UsageReadError,
  WS_METHODS,
  WsUsageDeliveredRpcGroup,
  staysWithProjectCoordinator,
  type UsageDay,
  type UsageDeliveredProject,
  type UsageDeliveredReport as UsageDeliveredReportResult,
  type UsageDeliveredReportInput,
  type UsageProviderKind,
} from "@specweave-studio/contracts";
import { fingerprintKey } from "@specweave-studio/shared/usageMerge";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import {
  foldSpecweaveLedger,
  parseIncrementMetadata,
  parseSpecweaveSpec,
} from "../mods/SpecweaveProgress.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import {
  CLOSED_INCREMENT_STATES,
  compareNumbered,
  incrementRootFor,
  isSpecweaveProject,
} from "../project/ThreadIncrementProgress.ts";
import * as ThreadIncrementProgressService from "../project/ThreadIncrementProgressService.ts";
import { INCREMENTS_DIR } from "../project/ThreadReports.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { totalsForTurn } from "./projectUsageAggregation.ts";
import { resolveModelAliases } from "./usageAggregation.ts";
import {
  DELIVERED_PARENT_DEPTH,
  buildDeliveredReport,
  deliveredDaySpan,
  incrementKey,
  isoOrNull,
  makeRangeTest,
  readLedgerMerges,
  type DeliveredBindingCandidate,
  type DeliveredCostRow,
  type DeliveredIncrementFacts,
  type DeliveredThreadFacts,
} from "./usageDeliveredCore.ts";
import { TRANSCRIPT_DRIVERS, decodeRates, driverOfProvider } from "./UsageMachineReport.ts";
import { createOverrideRateTable, parseRateTable, type RateTable } from "./usagePricing.ts";
import * as UsageService from "./UsageService.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SPEC_BYTES = 262_144;
const LEDGER_BYTES = 1_048_576;
const SMALL_BYTES = 524_288;
/** Increments per project read for closures, merges and tasks without spend: the newest by number. */
const DISCOVERY_PER_PROJECT = 120;
/** Folders read at once. */
const READ_CONCURRENCY = 16;

const decodeTurnUsage = Schema.decodeUnknownOption(Schema.fromJsonString(TurnTokenUsage));
const decodeSelection = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection));

export class UsageDeliveredReport extends Context.Service<
  UsageDeliveredReport,
  {
    readonly read: (
      input: UsageDeliveredReportInput,
    ) => Effect.Effect<UsageDeliveredReportResult, UsageReadError>;
  }
>()("specweave-studio/usage/UsageDeliveredReport") {}

interface ProjectRow {
  readonly project_id: string;
  readonly title: string;
  readonly workspace_root: string;
  readonly coordinator_thread_id: string | null;
}

interface ThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly parent_thread_id: string | null;
  readonly relationship: string | null;
  readonly pull_requests: string | null;
}

function pullRequestNumbers(json: string | null): number[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      const number = (entry as { number?: unknown } | null)?.number;
      return typeof number === "number" && Number.isSafeInteger(number) && number > 0
        ? [number]
        : [];
    });
  } catch {
    return [];
  }
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const usage = yield* UsageService.UsageService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const progress = yield* ThreadIncrementProgressService.ThreadIncrementProgressService;
  const sql = yield* SqlClient.SqlClient;

  const failed = (detail: string) => (cause: unknown) =>
    new UsageReadError({ reason: "scanFailed", detail, cause });

  /** A file no bigger than `maximum`; null when it is missing, larger or unreadable. */
  const readSmall = (file: string, maximum: number) =>
    fs.stat(file).pipe(
      Effect.flatMap((info) =>
        info.type === "File" && Number(info.size) <= maximum
          ? fs.readFileString(file)
          : Effect.succeed(null),
      ),
      Effect.orElseSucceed(() => null),
    );

  const mtimeOf = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime() ?? null),
      Effect.orElseSucceed(() => null),
    );

  /** One increment folder's metadata, merges, pull requests and tasks. */
  const readIncrementFacts = (projectId: string, incrementId: string, folder: string) =>
    Effect.gen(function* () {
      const [metadataText, ledgerText, specText, tasksText] = yield* Effect.all(
        [
          readSmall(path.join(folder, "metadata.json"), SMALL_BYTES),
          readSmall(path.join(folder, "ledger.jsonl"), LEDGER_BYTES),
          readSmall(path.join(folder, "spec.md"), SPEC_BYTES),
          readSmall(path.join(folder, "tasks.md"), SPEC_BYTES),
        ],
        { concurrency: "unbounded" },
      );
      const metadata = parseIncrementMetadata(metadataText);
      const status =
        typeof metadata.status === "string" && metadata.status.trim()
          ? metadata.status.trim().toLowerCase()
          : "unknown";
      const spec = specText === null ? null : parseSpecweaveSpec(specText);
      // Like SpecWeave's tasksFileFor: a legacy tasks.md, when present, holds the tasks.
      const planned = tasksText !== null ? parseSpecweaveSpec(tasksText).tasks : spec?.tasks;
      const now = yield* DateTime.now;
      const folded =
        planned === undefined || planned.length === 0
          ? []
          : foldSpecweaveLedger(planned, ledgerText ?? "", DateTime.toEpochMillis(now), {
              incrementId,
            }).tasks.filter((task) => planned.some((entry) => entry.id === task.id));
      const ledger = readLedgerMerges(ledgerText ?? "");
      return {
        projectId,
        incrementId,
        title: (typeof metadata.title === "string" && metadata.title.trim()) || spec?.title || null,
        status,
        createdAt: isoOrNull(metadata.created),
        closedAt: CLOSED_INCREMENT_STATES.has(status)
          ? (isoOrNull(metadata.completedAt) ?? isoOrNull(metadata.updated))
          : null,
        merges: ledger.merges,
        pullRequests: ledger.pullRequests,
        tasks: folded.map((task) => ({
          status: task.status,
          ...(task.status === "done" && task.changedAt !== null ? { doneAt: task.changedAt } : {}),
        })),
      } satisfies DeliveredIncrementFacts;
    });

  const read = Effect.fn("UsageDeliveredReport.read")(function* (input: UsageDeliveredReportInput) {
    const days = deliveredDaySpan(input.sinceDay, input.untilDay);
    if (days === null || days < 1) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }
    if (days > USAGE_DELIVERED_MAX_DAYS) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `A delivered report covers at most ${USAGE_DELIVERED_MAX_DAYS} days`,
      });
    }
    const inRange = makeRangeTest(input.timeZone, input.sinceDay, input.untilDay);

    const current = yield* providers.getProviders;
    const instances = new Map(current.map((provider) => [provider.instanceId as string, provider]));
    const currentSettings = yield* settings.getSettings.pipe(
      Effect.mapError(failed("Server settings could not be read.")),
    );
    const configured = currentSettings.providerInstances as Readonly<
      Record<string, { readonly driver: string }>
    >;
    const driverOfInstance = (instanceId: string): string =>
      instances.get(instanceId)?.driver ?? configured[instanceId]?.driver ?? instanceId;

    // A day starts up to 14 hours before its UTC date, so read a day of slack.
    const turnsSinceIso = DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(`${input.sinceDay}T00:00:00.000Z`) - DAY_MS),
    );
    const snapshot = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // Provider threads first, then run attempts; within each, oldest row first.
          const owned = yield* sql<{
            readonly native_id: string | null;
            readonly thread_id: string;
          }>`
            SELECT native_id, thread_id FROM (
              SELECT json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
                     p.thread_id AS thread_id, 0 AS source, p.rowid AS position
              FROM orchestration_v2_projection_provider_threads p
              UNION ALL
              SELECT json_extract(a.payload_json, '$.nativeThreadId') AS native_id,
                     a.thread_id AS thread_id, 1 AS source, a.rowid AS position
              FROM orchestration_v2_projection_run_attempts a
            )
            WHERE native_id IS NOT NULL
            ORDER BY source, position
          `;
          const projects = yield* sql<ProjectRow>`
            SELECT project_id, title, workspace_root,
                   json_extract(workspace_settings_json, '$.coordinatorThreadId') AS coordinator_thread_id
            FROM projection_projects
            WHERE deleted_at IS NULL
          `;
          const threads = yield* sql<ThreadRow>`
            SELECT thread_id, project_id, title,
                   json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
                   json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship,
                   json_extract(payload_json, '$.pullRequests') AS pull_requests
            FROM orchestration_v2_projection_threads
          `;
          const turns = yield* sql<{
            readonly thread_id: string;
            readonly started_at: string | null;
            readonly completed_at: string | null;
            readonly usage_json: string | null;
            readonly provider_instance_id: string | null;
            readonly selection_json: string | null;
          }>`
            SELECT pt.thread_id AS thread_id,
                   pt.started_at AS started_at,
                   pt.completed_at AS completed_at,
                   json_extract(pt.payload_json, '$.turnTokenUsage') AS usage_json,
                   a.provider_instance_id AS provider_instance_id,
                   json_extract(r.payload_json, '$.modelSelection') AS selection_json
            FROM orchestration_v2_projection_provider_turns pt
            JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = pt.run_attempt_id
            JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id
            WHERE COALESCE(pt.completed_at, pt.started_at) >= ${turnsSinceIso}
              AND a.provider_instance_id NOT IN ${sql.in(TRANSCRIPT_DRIVERS)}
          `;
          return { owned, projects, threads, turns };
        }),
      )
      .pipe(Effect.mapError(failed("SpecWithCode's own records could not be read.")));

    const sessionThread = new Map<string, string>();
    for (const row of snapshot.owned) {
      if (typeof row.native_id !== "string" || row.native_id.length === 0) continue;
      if (!sessionThread.has(row.native_id)) sessionThread.set(row.native_id, row.thread_id);
    }

    // Costs per (thread or native session, driver, provider, model).
    const rows = new Map<
      string,
      { -readonly [K in keyof DeliveredCostRow]: DeliveredCostRow[K] }
    >();
    const addRow = (entry: DeliveredCostRow) => {
      const key = [
        entry.threadId ?? "",
        entry.threadId === null ? entry.sessionKey : "",
        entry.driver,
        entry.provider ?? "",
        entry.model,
      ].join("\u0000");
      const existing = rows.get(key);
      if (existing === undefined) {
        rows.set(key, { ...entry });
        return;
      }
      existing.costUsd += entry.costUsd;
      existing.tokens += entry.tokens;
      existing.records += entry.records;
      existing.unpricedRecords += entry.unpricedRecords;
    };

    const sourceKeys = new Map<number, string>();
    const usedSources = new Set<number>();
    const providerOfSource = new Map<number, UsageProviderKind>();
    const cursorSources = new Set<number>();
    let cursorHistoryExcluded = false;
    yield* usage.visitRecords(
      { sinceDay: input.sinceDay, untilDay: input.untilDay, timeZone: input.timeZone },
      {
        onSource: (index, source) => {
          // Cursor's source is the vendor's account history, the same on every machine.
          if (source.provider === "cursor") {
            cursorSources.add(index);
            return;
          }
          providerOfSource.set(index, source.provider);
          sourceKeys.set(
            index,
            fingerprintKey({
              hostId: source.hostId,
              provider: source.provider,
              resolvedHomePath: source.dir,
              volumeId: source.volumeId,
            }),
          );
        },
        onRecord: (record, sourceIndex, model, costUsd, unpriced) => {
          const provider = providerOfSource.get(sourceIndex);
          if (provider === undefined) {
            if (cursorSources.has(sourceIndex)) cursorHistoryExcluded = true;
            return;
          }
          usedSources.add(sourceIndex);
          const tokens =
            record.totals.uncachedInputTokens +
            record.totals.cachedInputTokens +
            record.totals.cacheCreationTokens +
            // Reasoning is part of output, never added on top.
            record.totals.outputTokens;
          addRow({
            threadId: sessionThread.get(record.sessionId) ?? null,
            sessionKey: record.sessionId,
            driver: driverOfProvider(provider),
            provider,
            model,
            costUsd,
            tokens,
            records: 1,
            unpricedRecords: unpriced ? 1 : 0,
          });
        },
      },
    );

    // Recorded turns of drivers without transcripts, priced from the cached table.
    const rates: RateTable = yield* fs
      .readFileString(path.join(config.stateDir, "usage-model-rates.json"))
      .pipe(
        Effect.flatMap(decodeRates),
        Effect.map((cached) => parseRateTable(cached.document)),
        Effect.orElseSucceed((): RateTable => new Map()),
      );
    const priceOverrides = createOverrideRateTable(currentSettings.usagePriceOverrides);
    const modelAliases = resolveModelAliases(currentSettings.usageModelAliases);
    for (const turn of snapshot.turns) {
      const instanceId = turn.provider_instance_id;
      const at = turn.completed_at ?? turn.started_at;
      if (instanceId === null || !inRange(at)) continue;
      const driver = driverOfInstance(instanceId);
      // A second instance of a transcript provider is scanned from its folder.
      if ((TRANSCRIPT_DRIVERS as readonly string[]).includes(driver)) continue;
      const turnUsage = Option.getOrUndefined(decodeTurnUsage(turn.usage_json ?? ""));
      const selection = Option.getOrUndefined(decodeSelection(turn.selection_json ?? ""));
      const totals = totalsForTurn(turnUsage, selection, rates, priceOverrides, modelAliases);
      addRow({
        threadId: turn.thread_id,
        sessionKey: turn.thread_id,
        driver,
        provider: null,
        model:
          selection === undefined
            ? "unknown"
            : (modelAliases.get(selection.model) ?? selection.model),
        costUsd: totals.equivalentCostUsd ?? 0,
        tokens: totals.totalTokens,
        records: 1,
        unpricedRecords: totals.equivalentCostUsd === null ? 1 : 0,
      });
    }

    // Thread facts and coordinators.
    const projectsById = new Map(snapshot.projects.map((project) => [project.project_id, project]));
    const threadRows = new Map(snapshot.threads.map((row) => [row.thread_id, row]));
    const lineageOf = (threadId: string) => {
      const row = threadRows.get(threadId);
      return row === undefined
        ? null
        : { parentThreadId: row.parent_thread_id, relationshipToParent: row.relationship };
    };
    const threads = new Map<string, DeliveredThreadFacts>();
    const factsOf = (threadId: string): DeliveredThreadFacts | undefined => {
      const known = threads.get(threadId);
      if (known !== undefined) return known;
      const row = threadRows.get(threadId);
      if (row === undefined) return undefined;
      const project = projectsById.get(row.project_id);
      const facts: DeliveredThreadFacts = {
        title: row.title,
        projectId: row.project_id,
        parentThreadId: row.parent_thread_id,
        // Subagents running inside the coordinator count as the coordinator.
        isCoordinator: staysWithProjectCoordinator(
          threadId,
          lineageOf(threadId),
          {
            id: row.project_id,
            workspaceSettings: { coordinatorThreadId: project?.coordinator_thread_id ?? null },
          },
          lineageOf,
        ),
        pullRequests: pullRequestNumbers(row.pull_requests),
      };
      threads.set(threadId, facts);
      return facts;
    };

    // Threads with spend and their ancestors, by their own project.
    const toResolve = new Map<string, Set<string>>();
    for (const entry of rows.values()) {
      let threadId: string | null = entry.threadId;
      for (let depth = 0; depth <= DELIVERED_PARENT_DEPTH && threadId !== null; depth += 1) {
        const facts = factsOf(threadId);
        if (facts === undefined || facts.isCoordinator || facts.projectId === null) break;
        const set = toResolve.get(facts.projectId) ?? new Set<string>();
        if (set.has(threadId)) break;
        set.add(threadId);
        toResolve.set(facts.projectId, set);
        threadId = facts.parentThreadId;
      }
    }

    const bindings = new Map<string, DeliveredBindingCandidate[]>();
    const folders = new Map<string, { projectId: string; incrementId: string; folder: string }>();
    const specweaveProjects = new Map<string, boolean>();
    yield* Effect.forEach(
      [...toResolve],
      ([projectId, ids]) =>
        Effect.gen(function* () {
          const all = [...ids].toSorted();
          for (let start = 0; start < all.length; start += THREAD_INCREMENT_PROGRESS_MAX_THREADS) {
            const chunk = all.slice(start, start + THREAD_INCREMENT_PROGRESS_MAX_THREADS);
            const snapshot = yield* progress
              .read({
                projectId: ProjectId.make(projectId),
                threadIds: chunk.map((id) => ThreadId.make(id)),
              })
              .pipe(
                Effect.catchTags({
                  ProjectWorkspaceError: (error) =>
                    Effect.logWarning("delivered report: increments not resolved", {
                      projectId,
                      code: error.code,
                    }).pipe(Effect.as(null)),
                }),
              );
            if (snapshot === null) continue;
            if (snapshot.specweave !== undefined) {
              specweaveProjects.set(projectId, snapshot.specweave);
            }
            for (const entry of snapshot.threads) {
              bindings.set(entry.threadId, [
                { projectId, incrementId: entry.incrementId, binding: entry.binding },
              ]);
              const key = incrementKey(projectId, entry.incrementId);
              if (!folders.has(key)) {
                folders.set(key, {
                  projectId,
                  incrementId: entry.incrementId,
                  folder: entry.incrementPath,
                });
              }
            }
          }
        }),
      { concurrency: 4 },
    );

    // Increments closed, merged or worked in the range without spend: the newest
    // folders of each SpecWeave project's planning root changed since the range began.
    const changedSinceMs = Date.parse(`${input.sinceDay}T00:00:00.000Z`) - DAY_MS;
    const seenRoots = new Set<string>();
    for (const { projectId, incrementId, folder } of folders.values()) {
      seenRoots.add(`${path.dirname(path.dirname(path.dirname(folder)))}\u0000${incrementId}`);
      const project = projectsById.get(projectId);
      if (project !== undefined) {
        const root = yield* Effect.promise(() => incrementRootFor(project.workspace_root, null));
        seenRoots.add(`${root}\u0000${incrementId}`);
      }
    }
    for (const project of snapshot.projects.toSorted((a, b) =>
      a.project_id.localeCompare(b.project_id),
    )) {
      const specweave =
        specweaveProjects.get(project.project_id) ??
        (yield* Effect.promise(() => isSpecweaveProject(project.workspace_root)));
      specweaveProjects.set(project.project_id, specweave);
      if (!specweave) continue;
      const root = yield* Effect.promise(() => incrementRootFor(project.workspace_root, null));
      const names = yield* fs
        .readDirectory(path.join(root, INCREMENTS_DIR))
        .pipe(Effect.orElseSucceed(() => [] as string[]));
      const newest = names
        .filter((name) => /^\d{4,}[A-Z]?-[a-z0-9-]+$/iu.test(name))
        .toSorted((left, right) => compareNumbered(right, left))
        .slice(0, DISCOVERY_PER_PROJECT);
      const changed = yield* Effect.forEach(
        newest,
        (incrementId) =>
          Effect.gen(function* () {
            if (seenRoots.has(`${root}\u0000${incrementId}`)) return null;
            const folder = path.join(root, INCREMENTS_DIR, incrementId);
            const [ledgerAt, metadataAt] = yield* Effect.all([
              mtimeOf(path.join(folder, "ledger.jsonl")),
              mtimeOf(path.join(folder, "metadata.json")),
            ]);
            const latest = Math.max(ledgerAt ?? 0, metadataAt ?? 0);
            return latest >= changedSinceMs ? { incrementId, folder } : null;
          }),
        { concurrency: READ_CONCURRENCY },
      );
      for (const entry of changed) {
        if (entry === null) continue;
        seenRoots.add(`${root}\u0000${entry.incrementId}`);
        const key = incrementKey(project.project_id, entry.incrementId);
        if (!folders.has(key)) folders.set(key, { projectId: project.project_id, ...entry });
      }
    }

    const facts = yield* Effect.forEach(
      [...folders],
      ([key, entry]) =>
        readIncrementFacts(entry.projectId, entry.incrementId, entry.folder).pipe(
          Effect.map((read) => [key, read] as const),
        ),
      { concurrency: READ_CONCURRENCY },
    );

    const body = buildDeliveredReport({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      rows: [...rows.values()],
      threads,
      bindings,
      increments: new Map(facts),
    });

    const usedProjects = new Set<string>(body.increments.map((increment) => increment.projectId));
    for (const thread of [...body.otherThreads.threads, ...body.coordinators.threads]) {
      const projectId = threads.get(thread.threadId)?.projectId;
      if (projectId) usedProjects.add(projectId);
    }
    const projects: UsageDeliveredProject[] = snapshot.projects
      .filter((project) => usedProjects.has(project.project_id) && project.title.trim() !== "")
      .map((project) => ({
        projectId: project.project_id,
        title: project.title.trim(),
        specweave: specweaveProjects.get(project.project_id) ?? false,
      }));

    const readAt = yield* DateTime.now;
    return {
      version: USAGE_DELIVERED_REPORT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay as UsageDay,
      untilDay: input.untilDay as UsageDay,
      projects,
      ...body,
      cursorHistoryExcluded,
      sourceKeys: [...new Set([...usedSources].map((index) => sourceKeys.get(index)!))].toSorted(),
    } satisfies UsageDeliveredReportResult;
  });

  return UsageDeliveredReport.of({
    read: (input) =>
      read(input).pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(
            failed("The delivered report could not be built.")(Cause.squash(Cause.die(defect))),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(UsageDeliveredReport, make);

export const layerRpcHandlers = WsUsageDeliveredRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const report = yield* UsageDeliveredReport;
    return {
      [WS_METHODS.usageDeliveredReport]: (input) => report.read(input),
    };
  }),
);
