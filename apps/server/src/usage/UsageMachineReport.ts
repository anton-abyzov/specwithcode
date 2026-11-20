/**
 * UsageMachineReport - what this machine recorded per subscription account.
 *
 * Reads the same transcripts as the usage summary, names each record's account
 * from the spans this service keeps (which account every provider instance was
 * signed in to, and when), and marks a session as SpecWithCode's when a thread
 * owns its native id. Providers that keep no transcript are read from the turns
 * SpecWithCode recorded. Clients merge the reports of every machine they reach.
 *
 * The spans are kept in `<stateDir>/usage-account-spans.json`, written at most
 * once a minute and on shutdown. A file rather than a table: it is small and
 * costs only attribution detail to lose.
 *
 * @module usage/UsageMachineReport
 */
import {
  ModelSelection,
  ProviderDriverKind,
  TurnTokenUsage,
  USAGE_MACHINE_REPORT_HOURLY_DAYS,
  USAGE_MACHINE_REPORT_MAX_DAYS,
  USAGE_MACHINE_REPORT_VERSION,
  UsageReadError,
  WS_METHODS,
  WsUsageMachineReportRpcGroup,
  type ServerProvider,
  type UsageDay,
  type UsageMachineAccount,
  type UsageMachineReport as UsageMachineReportResult,
  type UsageMachineReportInput,
} from "@specweave-studio/contracts";
import {
  unknownUsageAccountKey,
  usageAccountKey,
  usageAccountKeyDriver,
} from "@specweave-studio/shared/usageAccountKey";
import { fingerprintKey } from "@specweave-studio/shared/usageMerge";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { totalsForTurn } from "./projectUsageAggregation.ts";
import {
  type AccountReading,
  type AccountSpan,
  USAGE_ACCOUNT_SPANS_FILE,
  decodeSpansFile,
  encodeSpansFile,
  makeAccountResolver,
  pruneSpans,
  recordSighting,
} from "./usageAccountSpans.ts";
import { makeDayFormatter, resolveModelAliases } from "./usageAggregation.ts";
import { UsageLimitHistory } from "./UsageLimitHistory.ts";
import { MachineReportBuilder } from "./usageMachineReportCore.ts";
import { createOverrideRateTable, parseRateTable, type RateTable } from "./usagePricing.ts";
import * as UsageService from "./UsageService.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Drivers whose usage the transcript scan already covers. Their recorded turns
 * are left out, or every in-app turn would count twice. Cursor is not here:
 * its scan source is the account's history from the vendor, the same on every
 * machine, so only recorded turns say which machine used it.
 */
const TRANSCRIPT_DRIVERS = ["claudeAgent", "codex", "grok", "opencode", "antigravity"] as const;

/** The driver behind a transcript provider kind. */
function driverOfProvider(provider: string): string {
  return provider === "claude" ? "claudeAgent" : provider;
}

const decodeRates = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ fetchedAtMs: Schema.Number, document: Schema.Unknown })),
);
const decodeTurnUsage = Schema.decodeUnknownOption(Schema.fromJsonString(TurnTokenUsage));
const decodeSelection = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection));
const decodeDriver = Schema.decodeUnknownOption(ProviderDriverKind);

export class UsageMachineReport extends Context.Service<
  UsageMachineReport,
  {
    readonly read: (
      input: UsageMachineReportInput,
    ) => Effect.Effect<UsageMachineReportResult, UsageReadError>;
  }
>()("specweave-studio/usage/UsageMachineReport") {}

/** Days between two `YYYY-MM-DD` days, inclusive of both. Null when either is not a date. */
function daySpan(sinceDay: string, untilDay: string): number | null {
  const since = Date.parse(`${sinceDay}T00:00:00Z`);
  const until = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(since) || Number.isNaN(until)) return null;
  return Math.round((until - since) / DAY_MS) + 1;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const history = yield* UsageLimitHistory;
  const usage = yield* UsageService.UsageService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const filePath = path.join(config.stateDir, USAGE_ACCOUNT_SPANS_FILE);

  const spans = decodeSpansFile(
    yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => "")),
  );
  // Bumped on every stored change; a save marks the version it wrote, so a
  // change during a write, or a failed write, is saved by the next flush.
  let version = 0;
  let savedVersion = 0;

  const sight = (current: ReadonlyArray<ServerProvider>) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const provider of current) {
        // Only a signed-in instance names an account; a signed-out one keeps its last span.
        if (provider.auth.status !== "authenticated") continue;
        if (recordSighting(spans, provider.instanceId, usageAccountKey(provider), now)) {
          version += 1;
        }
      }
    });

  const flush = Effect.gen(function* () {
    if (version === savedVersion) return;
    const writing = version;
    pruneSpans(spans, yield* Clock.currentTimeMillis);
    yield* writeFileStringAtomically({ filePath, contents: encodeSpansFile(spans) }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.andThen(
        Effect.sync(() => {
          savedVersion = writing;
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not save usage account spans", { cause }),
      ),
    );
  });

  // The registry stream carries changes only, so seed it with what is there now.
  yield* Stream.concat(Stream.fromEffect(providers.getProviders), providers.streamChanges).pipe(
    Stream.runForEach(sight),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );
  const ticker = yield* Effect.forever(
    // A quiet registry still means the same accounts are signed in.
    Effect.sleep("60 seconds").pipe(
      Effect.andThen(providers.getProviders),
      Effect.flatMap(sight),
      Effect.andThen(flush),
    ),
  ).pipe(Effect.forkScoped);
  // Stop the periodic save first, so the last save is never cut short by it.
  yield* Effect.addFinalizer(() => Fiber.interrupt(ticker).pipe(Effect.andThen(flush)));

  const failed = (detail: string) => (cause: unknown) =>
    new UsageReadError({ reason: "scanFailed", detail, cause });

  const read = Effect.fn("UsageMachineReport.read")(function* (input: UsageMachineReportInput) {
    const days = daySpan(input.sinceDay, input.untilDay);
    if (days === null || days < 1) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }
    if (days > USAGE_MACHINE_REPORT_MAX_DAYS) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `A machine report covers at most ${USAGE_MACHINE_REPORT_MAX_DAYS} days`,
      });
    }

    const now = yield* Clock.currentTimeMillis;
    const hourlySinceMs =
      Math.floor((now - USAGE_MACHINE_REPORT_HOURLY_DAYS * DAY_MS) / HOUR_MS) * HOUR_MS;
    // The scan reaches back far enough for the hourly series whatever range was asked.
    const hourlySinceDay = makeDayFormatter(input.timeZone)(hourlySinceMs);
    const scanSinceDay = (
      hourlySinceDay < input.sinceDay ? hourlySinceDay : input.sinceDay
    ) as UsageDay;

    const current = yield* providers.getProviders;
    yield* sight(current);
    const instances = new Map(current.map((provider) => [provider.instanceId as string, provider]));
    const instancesByDriver = new Map<string, ServerProvider[]>();
    for (const provider of current) {
      const list = instancesByDriver.get(provider.driver) ?? [];
      list.push(provider);
      instancesByDriver.set(provider.driver, list);
    }
    const signedInKey = (provider: ServerProvider | undefined): string | null =>
      provider !== undefined && provider.auth.status === "authenticated"
        ? usageAccountKey(provider)
        : null;

    // Limit readings stand in for the time before spans were recorded.
    const readingsByDriver = new Map<string, AccountReading[]>();
    const limitHistory = yield* history.read({ sinceHours: USAGE_MACHINE_REPORT_HOURLY_DAYS * 24 });
    for (const series of limitHistory.series) {
      const list = readingsByDriver.get(series.driver) ?? [];
      for (const sample of series.samples) {
        const at = Date.parse(sample.at);
        if (!Number.isNaN(at)) list.push({ at, accountKey: series.accountKey });
      }
      readingsByDriver.set(series.driver, list);
    }
    for (const list of readingsByDriver.values()) list.sort((a, b) => a.at - b.at);

    const resolverFor = (driver: string, instanceIds: readonly string[]) => {
      const driverInstances = instancesByDriver.get(driver) ?? [];
      // A folder no instance owns (OpenCode, Antigravity) belongs to the driver's instances.
      const owners =
        instanceIds.length > 0 ? instanceIds : driverInstances.map((p) => p.instanceId);
      const signedIn = owners.flatMap((id) => {
        const key = signedInKey(instances.get(id));
        return key === null ? [] : [key];
      });
      return makeAccountResolver({
        spans: owners.map((id): readonly AccountSpan[] => spans.get(id) ?? []),
        readings: driverInstances.length <= 1 ? (readingsByDriver.get(driver) ?? []) : null,
        currentAccountKey: new Set(signedIn).size === 1 ? signedIn[0]! : null,
        unknownAccountKey: unknownUsageAccountKey(driver),
      });
    };

    // One snapshot for session ownership, project names and recorded turns.
    const scanSinceIso = `${scanSinceDay}T00:00:00.000Z`;
    // A day starts up to 14 hours before its UTC date, so read a day of slack.
    const turnsSinceIso = DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(scanSinceIso) - DAY_MS),
    );
    const snapshot = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const owned = yield* sql<{
            readonly native_id: string | null;
            readonly project_id: string | null;
          }>`
            SELECT json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
                   t.project_id AS project_id
            FROM orchestration_v2_projection_provider_threads p
            LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
            UNION
            SELECT json_extract(a.payload_json, '$.nativeThreadId') AS native_id,
                   t.project_id AS project_id
            FROM orchestration_v2_projection_run_attempts a
            LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = a.thread_id
          `;
          const projects = yield* sql<{ readonly project_id: string; readonly title: string }>`
            SELECT project_id, title FROM projection_projects
          `;
          const turns = yield* sql<{
            readonly provider_turn_id: string;
            readonly thread_id: string;
            readonly started_at: string | null;
            readonly completed_at: string | null;
            readonly usage_json: string | null;
            readonly provider_instance_id: string | null;
            readonly driver: string | null;
            readonly selection_json: string | null;
            readonly project_id: string | null;
          }>`
            SELECT pt.provider_turn_id AS provider_turn_id,
                   pt.thread_id AS thread_id,
                   pt.started_at AS started_at,
                   pt.completed_at AS completed_at,
                   json_extract(pt.payload_json, '$.turnTokenUsage') AS usage_json,
                   a.provider_instance_id AS provider_instance_id,
                   a.provider AS driver,
                   json_extract(r.payload_json, '$.modelSelection') AS selection_json,
                   t.project_id AS project_id
            FROM orchestration_v2_projection_provider_turns pt
            JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = pt.run_attempt_id
            JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id
            LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = pt.thread_id
            WHERE COALESCE(pt.completed_at, pt.started_at) >= ${turnsSinceIso}
              AND a.provider NOT IN ${sql.in(TRANSCRIPT_DRIVERS)}
          `;
          return { owned, projects, turns };
        }),
      )
      .pipe(Effect.mapError(failed("SpecWithCode's own records could not be read.")));

    const ownedSessions = new Map<string, string | null>();
    for (const row of snapshot.owned) {
      if (typeof row.native_id !== "string" || row.native_id.length === 0) continue;
      // A session two rows name keeps the row that knows its project.
      if (ownedSessions.get(row.native_id) == null) {
        ownedSessions.set(row.native_id, row.project_id ?? null);
      }
    }

    const builder = new MachineReportBuilder({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      hourlySinceMs,
      ownedSessions,
    });

    yield* usage.visitRecords(
      { sinceDay: scanSinceDay, untilDay: input.untilDay, timeZone: input.timeZone },
      {
        onSource: (index, source) => {
          // Cursor's source is the vendor's account history, the same on every machine.
          if (source.provider === "cursor") return;
          builder.setSource(index, {
            key: fingerprintKey({
              hostId: source.hostId,
              provider: source.provider,
              resolvedHomePath: source.dir,
              volumeId: source.volumeId,
            }),
            provider: source.provider,
            resolve: resolverFor(driverOfProvider(source.provider), source.instanceIds),
          });
        },
        onRecord: (record, sourceIndex, model, costUsd, unpriced) =>
          builder.addRecord(record, sourceIndex, model, costUsd, unpriced),
      },
    );

    // Recorded turns of providers without transcripts, priced from the cached table.
    const rates: RateTable = yield* fs
      .readFileString(path.join(config.stateDir, "usage-model-rates.json"))
      .pipe(
        Effect.flatMap(decodeRates),
        Effect.map((cached) => parseRateTable(cached.document)),
        Effect.orElseSucceed((): RateTable => new Map()),
      );
    const currentSettings = yield* settings.getSettings.pipe(
      Effect.mapError(failed("Server settings could not be read.")),
    );
    const priceOverrides = createOverrideRateTable(currentSettings.usagePriceOverrides);
    const modelAliases = resolveModelAliases(currentSettings.usageModelAliases);
    const turnResolvers = new Map<string, ReturnType<typeof makeAccountResolver>>();
    for (const row of snapshot.turns) {
      const instanceId = row.provider_instance_id;
      const driver = row.driver ?? instances.get(instanceId ?? "")?.driver;
      const at = Date.parse(row.completed_at ?? row.started_at ?? "");
      if (instanceId === null || driver === undefined || Number.isNaN(at)) continue;
      let resolve = turnResolvers.get(instanceId);
      if (resolve === undefined) {
        resolve = resolverFor(driver, [instanceId]);
        turnResolvers.set(instanceId, resolve);
      }
      const turnUsage = Option.getOrUndefined(decodeTurnUsage(row.usage_json ?? ""));
      const selection = Option.getOrUndefined(decodeSelection(row.selection_json ?? ""));
      const totals = totalsForTurn(turnUsage, selection, rates, priceOverrides, modelAliases);
      builder.addTurn({
        atMs: at,
        account: resolve(at),
        model:
          selection === undefined
            ? "unknown"
            : (modelAliases.get(selection.model) ?? selection.model),
        tokens: totals.totalTokens,
        costUsd: totals.equivalentCostUsd,
        projectId: row.project_id,
        sessionKey: row.thread_id,
      });
    }

    const built = builder.finish();

    const accounts = new Map<string, UsageMachineAccount>();
    const account = (accountKey: string): UsageMachineAccount | null => {
      const existing = accounts.get(accountKey);
      if (existing !== undefined) return existing;
      const driver = Option.getOrUndefined(decodeDriver(usageAccountKeyDriver(accountKey)));
      if (driver === undefined) return null;
      const created: UsageMachineAccount = {
        accountKey,
        driver,
        identity: built.identities.get(accountKey) ?? "current",
        signedIn: false,
      };
      accounts.set(accountKey, created);
      return created;
    };
    for (const accountKey of built.identities.keys()) account(accountKey);
    // An account signed in here is listed even with no usage, so a client knows
    // this machine holds it and was heard from.
    for (const provider of current) {
      const accountKey = signedInKey(provider);
      if (accountKey === null) continue;
      const entry = account(accountKey);
      if (entry === null) continue;
      accounts.set(accountKey, {
        ...entry,
        signedIn: true,
        ...(provider.displayName === undefined ? {} : { label: provider.displayName }),
      });
    }

    const usedProjects = new Set(built.cells.flatMap((cell) => cell.projectId ?? []));
    const readAt = yield* DateTime.now;
    return {
      version: USAGE_MACHINE_REPORT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      accounts: [...accounts.values()].sort((a, b) => a.accountKey.localeCompare(b.accountKey)),
      sources: built.sources,
      projects: snapshot.projects
        .filter((project) => usedProjects.has(project.project_id) && project.title.trim() !== "")
        .map((project) => ({ projectId: project.project_id, title: project.title.trim() })),
      cells: built.cells,
      hourly: built.hourly,
      hourlySinceMs,
    } satisfies UsageMachineReportResult;
  });

  return {
    read: (input) =>
      read(input).pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(
            failed("The machine report could not be built.")(Cause.squash(Cause.die(defect))),
          ),
        ),
      ),
  } satisfies UsageMachineReport["Service"];
});

export const layer = Layer.effect(UsageMachineReport, make);

export const layerRpcHandlers = WsUsageMachineReportRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const report = yield* UsageMachineReport;
    return {
      [WS_METHODS.usageMachineReport]: (input) => report.read(input),
    };
  }),
);
