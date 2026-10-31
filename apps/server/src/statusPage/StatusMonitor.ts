/**
 * Background health checks for the Status page.
 *
 * Checks run on their own fiber after the server activates: the first one a
 * little after start, then every few minutes. Reading the page returns the
 * latest result at once and never waits on the network; offline checks show
 * as "unknown" rather than failing.
 */
import {
  StatusPageError,
  WS_METHODS,
  WsStatusPageRpcGroup,
  type ServerProvider,
  type StatusSnapshot,
} from "@specweave-studio/contracts";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import { readTailscaleStatus } from "@specweave-studio/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as ServerConfig from "../config.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS } from "../orchestration-v2/ShellSnapshotCache.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { discoverFleet, readFleetConfig } from "../studioFleet.ts";
import {
  FEEDS,
  GITHUB_COMPONENTS,
  PROVIDERS,
  RELEASE_FEED_URL,
  buildStatusServices,
  decodeHealthWatch,
  neededFeeds,
  showsTailscale,
  type ConnectState,
  type CoordinatorState,
  type FeedId,
  type ObservedThread,
  type StatusInputs,
  type TailscaleState,
} from "./catalog.ts";
import {
  fetchFeedText,
  isReachable,
  parseGoogleCloudIncidents,
  parseStatuspageSummary,
  parseXaiStatusRss,
  type FeedReading,
} from "./feeds.ts";
import {
  decodeStatusHistory,
  emptyStatusHistory,
  failingSince,
  recordStatusChecks,
  recordUnexpectedStop,
  type StatusHistory,
} from "./history.ts";
import { snapshotFrom, type MonitorState } from "./snapshot.ts";

const FIRST_CHECK_DELAY = Duration.seconds(20);
const CHECK_INTERVAL = Duration.minutes(5);
/** A manual refresh inside this window returns the last result instead. */
const REFRESH_COOLDOWN_MS = 30_000;
const INCIDENT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export class StatusMonitor extends Context.Service<
  StatusMonitor,
  {
    /** The latest result, without checking anything. */
    readonly snapshot: Effect.Effect<StatusSnapshot>;
    /** Checks now unless a check just finished, then returns the result. */
    readonly refresh: Effect.Effect<StatusSnapshot>;
    /** Starts the background checks for the server's lifetime. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("specweave-studio/statusPage/StatusMonitor") {}

const statuspageFeed =
  (
    id: FeedId,
    include: (name: string) => boolean,
    titles: { readonly incidentTitle?: RegExp; readonly otherProducts?: RegExp } = {},
  ) =>
  (raw: string | null) =>
    parseStatuspageSummary(raw, {
      serviceId: id,
      pageUrl: FEEDS[id].pageUrl,
      include,
      ...(titles.incidentTitle ? { incidentTitle: titles.incidentTitle } : {}),
      ...(titles.otherProducts ? { otherProducts: titles.otherProducts } : {}),
    });

const FEED_PARSERS: Record<FeedId, (raw: string | null, now: number) => FeedReading> = {
  claude: statuspageFeed("claude", (name) => PROVIDERS.claude.components!.test(name)),
  openai: statuspageFeed(
    "openai",
    (name) => PROVIDERS.codex.components!.test(name),
    PROVIDERS.codex,
  ),
  github: statuspageFeed(
    "github",
    (name) => GITHUB_COMPONENTS.test(name) || PROVIDERS.copilot.components!.test(name),
  ),
  tailscale: statuspageFeed("tailscale", () => true),
  google: (raw, now) =>
    parseGoogleCloudIncidents(raw, {
      serviceId: "google",
      pageUrl: FEEDS.google.pageUrl,
      product: /Gemini|Vertex AI/iu,
      now,
      lookbackMs: INCIDENT_LOOKBACK_MS,
    }),
  xai: (raw, now) =>
    parseXaiStatusRss(raw, {
      serviceId: "xai",
      pageUrl: FEEDS.xai.pageUrl,
      now,
      lookbackMs: INCIDENT_LOOKBACK_MS,
    }),
};

const millis = (value: DateTime.Utc) => DateTime.toEpochMillis(value);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const providers = yield* ProviderRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const historyPath = path.join(config.stateDir, "status-history.json");
  const healthWatchPath = path.join(config.baseDir, "health", "latest.json");
  const startedAt = yield* Clock.currentTimeMillis;

  // Read before this run records its own: the previous run clears the file
  // when it shuts down, so one left behind by a dead process means it stopped
  // without shutting down.
  const previousRun = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  const unexpectedStop =
    previousRun._tag === "Some" &&
    previousRun.value.pid !== process.pid &&
    !isProcessAlive(previousRun.value.pid) &&
    Number.isFinite(Date.parse(previousRun.value.startedAt))
      ? { previousStartedAt: Date.parse(previousRun.value.startedAt), restartedAt: startedAt }
      : null;

  const loadHistory = fs.readFileString(historyPath).pipe(
    Effect.flatMap(decodeJson),
    Effect.map(decodeStatusHistory),
    Effect.orElseSucceed(emptyStatusHistory),
    Effect.map((loaded) =>
      unexpectedStop === null ? loaded : recordUnexpectedStop(loaded, unexpectedStop),
    ),
  );
  const history = yield* Ref.make<StatusHistory | null>(null);
  const state = yield* Ref.make<MonitorState>({ inputs: null, checkedAt: null, checking: false });
  const lock = yield* Semaphore.make(1);

  const currentHistory = Effect.gen(function* () {
    const loaded = yield* Ref.get(history);
    if (loaded !== null) return loaded;
    const fromDisk = yield* loadHistory;
    yield* Ref.set(history, fromDisk);
    return fromDisk;
  });

  const readThreads = projections
    .getShellSnapshot({ location: "active", maxAgeMs: SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS })
    .pipe(
      Effect.map((snapshot) =>
        snapshot.threads.map((thread): ObservedThread & { readonly id: string } => ({
          id: thread.id,
          providerInstanceId: thread.providerInstanceId,
          status: thread.status,
          lastErrorClass: thread.lastErrorClass ?? null,
          updatedAtMs: millis(thread.updatedAt),
        })),
      ),
      Effect.orElseSucceed(() => []),
    );

  const readCoordinators = (threads: ReadonlyArray<ObservedThread & { readonly id: string }>) =>
    projects.list().pipe(
      Effect.map((rows) =>
        rows.flatMap((row): Array<CoordinatorState> => {
          const settings = (
            row as typeof row & {
              readonly workspaceSettings?: {
                readonly coordinatorThreadId?: string | null;
                readonly archived?: boolean;
              } | null;
            }
          ).workspaceSettings;
          const threadId = settings?.coordinatorThreadId ?? null;
          if (threadId === null || settings?.archived === true) return [];
          const thread = threads.find((candidate) => candidate.id === threadId);
          return [
            {
              projectTitle: row.title,
              status: thread?.status ?? null,
              lastErrorClass: thread?.lastErrorClass ?? null,
            },
          ];
        }),
      ),
      Effect.orElseSucceed(() => []),
    );

  const readFleet = Effect.tryPromise(async (): Promise<StudioFleetSnapshot | null> => {
    const fleetConfig = await readFleetConfig(config.baseDir);
    return fleetConfig === null ? null : discoverFleet(fleetConfig, config.host);
  }).pipe(Effect.orElseSucceed(() => null));

  const readHealthWatch = fs.readFileString(healthWatchPath).pipe(
    Effect.flatMap(decodeJson),
    Effect.map(decodeHealthWatch),
    Effect.orElseSucceed(() => null),
  );

  const readTailscale = readTailscaleStatus.pipe(
    Effect.map((status): TailscaleState => ({ state: "running", dnsName: status.magicDnsName })),
    Effect.orElseSucceed((): TailscaleState => ({ state: "unavailable" })),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );

  // Same reading as CloudLink's link state: a linked user means linked, and a
  // stored tunnel runtime config means the managed (tunnel) mode. The
  // connector's live state is not exposed to this service, so it stays unknown.
  const readConnect = Effect.all(
    [secrets.get(CLOUD_LINKED_USER_ID), secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG)],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([linkedUser, runtimeConfig]): ConnectState => ({
      mode: Option.isNone(linkedUser)
        ? "not_linked"
        : Option.isSome(runtimeConfig)
          ? "managed"
          : "publish_only",
      tunnel: "unknown",
    })),
    Effect.orElseSucceed((): ConnectState | null => null),
  );

  const readFeeds = (ids: ReadonlyArray<FeedId>, now: number) =>
    Effect.forEach(
      ids,
      (id) =>
        Effect.promise(() => fetchFeedText(FEEDS[id].url)).pipe(
          Effect.map((raw) => [id, FEED_PARSERS[id](raw, now)] as const),
        ),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((entries) => Object.fromEntries(entries) as Partial<Record<FeedId, FeedReading>>),
    );

  const check = Effect.gen(function* () {
    yield* Ref.update(state, (current) => ({ ...current, checking: true }));
    const now = yield* Clock.currentTimeMillis;
    const providerList: ReadonlyArray<ServerProvider> = yield* providers.getProviders;
    const databaseOk = yield* sql`SELECT 1`.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const threads = yield* readThreads;
    const [coordinators, fleet, tailscale, connect, releaseFeed, healthWatch] = yield* Effect.all(
      [
        readCoordinators(threads),
        readFleet,
        readTailscale,
        readConnect,
        Effect.promise(() => isReachable(RELEASE_FEED_URL)),
        readHealthWatch,
      ],
      { concurrency: "unbounded" },
    );
    const feeds = yield* readFeeds(
      neededFeeds({
        providers: providerList,
        showTailscale: showsTailscale(tailscale, fleet),
      }),
      now,
    );
    const previous = yield* currentHistory;
    const inputs: StatusInputs = {
      now,
      serverVersion: packageJson.version,
      startedAt,
      databaseOk,
      providers: providerList,
      threads,
      coordinators,
      fleet,
      tailscale,
      connect,
      feeds,
      releaseFeedReachable: releaseFeed,
      healthWatch,
      failingSince: Object.fromEntries(
        Object.keys(previous.streaks).flatMap((serviceId) => {
          const since = failingSince(previous, serviceId);
          return since === null ? [] : [[serviceId, since]];
        }),
      ),
    };
    const services = buildStatusServices(inputs);
    const next = recordStatusChecks(
      previous,
      services.map((service) => ({
        serviceId: service.id,
        serviceName: service.name,
        level: service.level,
        note: service.level === "operational" ? null : service.detail,
        tracksIncidents: service.tracksIncidents,
        ...(service.dormant ? { dormant: true } : {}),
      })),
      now,
    );
    yield* Ref.set(history, next);
    yield* Ref.set(state, { inputs, checkedAt: now, checking: false });
    yield* encodeJson(next).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: historyPath, contents: `${contents}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) => Effect.logWarning("Could not save status history", { cause })),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Ref.update(state, (current) => ({ ...current, checking: false }));
        yield* Effect.logWarning("Status check failed", { cause });
      }),
    ),
    lock.withPermits(1),
  );

  const snapshot = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return snapshotFrom(yield* Ref.get(state), yield* currentHistory, now);
  });

  const refresh = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const { checkedAt } = yield* Ref.get(state);
    if (checkedAt === null || now - checkedAt > REFRESH_COOLDOWN_MS) yield* check;
    return yield* snapshot;
  });

  const start: StatusMonitor["Service"]["start"] = () =>
    forkParked(
      Effect.sleep(FIRST_CHECK_DELAY).pipe(
        Effect.andThen(check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)))),
        Effect.asVoid,
      ),
    );

  return StatusMonitor.of({ snapshot, refresh, start });
});

export const layer = Layer.effect(StatusMonitor, make);

/** Runs the background checks for the server's lifetime. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const monitor = yield* StatusMonitor;
    yield* monitor.start();
  }),
);

/**
 * The `statusPage.*` handlers, registered apart from the rest of the
 * WebSocket API (see `WsStatusPageRpcGroup`).
 */
export const layerRpcHandlers = WsStatusPageRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const monitor = yield* StatusMonitor;
    const orFail = <A>(effect: Effect.Effect<A>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.fail(new StatusPageError({ detail: "Could not read the status.", cause })),
        ),
      );
    return {
      [WS_METHODS.statusPageSnapshot]: () => orFail(monitor.snapshot),
      [WS_METHODS.statusPageRefresh]: () => orFail(monitor.refresh),
    };
  }),
);
